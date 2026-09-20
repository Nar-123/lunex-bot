import type { Address } from 'viem';
import { config } from '../config';
import { readErc20Balance } from '../blockchain/erc20';
import { getExecutorAddress } from '../blockchain/walletClient';
import { exitLegKeyPrefix } from '../capital/freshCapitalSnapshot';
import type { TransactionAttemptRepository } from '../execution/types';
import type { SwapExecutor } from '../swap/types';
import type { DustSettlementRecord, PositionRepository } from '../positions/types';

/**
 * OPERATOR-AUTHORISED DUST SETTLEMENT.
 *
 * A CLOSING position whose remove-liquidity receipt proved a TOKEN residual can
 * be finalized WITHOUT selling that residual -- but ONLY when selling it cannot
 * pay for its own gas. Nothing on-chain happens here: no transaction is built,
 * signed or sent, no allowance is touched, and no transaction hash exists.
 *
 * What this is NOT:
 *  - not "close a position without selling": a residual worth more than the
 *    threshold is refused outright, every time;
 *  - not a claim that the TOKEN was sold: there are no proceeds, no
 *    minReceived and no txHash anywhere in the record;
 *  - not automatic: nothing in the exit cycle can trigger it. It is an explicit
 *    operator action (`POST /positions/:id/settle-dust`) with an explicit
 *    confirmation field.
 *
 * The decision is always VALUE-based, never quantity-based: a FRESH read-only
 * quote is taken for EXACTLY the receipt-proven residual, and that quote's USDG
 * output is compared against the configured threshold. Token decimals and price
 * are therefore handled by the quote itself -- no decimal scaling is hardcoded
 * anywhere in this file.
 *
 * Accounting is deliberately honest:
 *  - `Position.realizedUsdgRaw` keeps reporting ONLY the USDG the receipts
 *    actually paid (the remove-liquidity proceeds);
 *  - the abandoned residual, its quoted value, the threshold it was judged
 *    against, the quote's timestamp and the authorising operator are recorded
 *    separately in `DustSettlement`, in the SAME transaction as the close.
 *
 * Fails closed: every unknown, unreadable or ambiguous condition rejects.
 */

export type DustRejectReason =
  | 'INVALID_REQUEST'
  | 'NOT_CONFIRMED'
  | 'POSITION_NOT_FOUND'
  | 'POSITION_NOT_CLOSING'
  | 'STALE_CLOSE_LIFECYCLE'
  | 'REMOVE_NOT_VERIFIED'
  | 'TOKEN_RESIDUAL_UNKNOWN'
  | 'NO_TOKEN_RESIDUAL'
  | 'EXIT_TX_IN_FLIGHT'
  | 'SWAP_ALREADY_VERIFIED'
  | 'BALANCE_UNVERIFIABLE'
  | 'BALANCE_BELOW_RESIDUAL'
  | 'QUOTE_UNAVAILABLE'
  | 'QUOTE_STALE'
  | 'NOT_DUST'
  | 'CLOSE_LOST_RACE';

export interface DustSettlementRequest {
  positionId: string;
  closeIdempotencyKey: string;
  /** Explicit operator confirmation -- must equal `DUST_CONFIRMATION`. */
  confirm: string;
  /** Authenticated operator identity (never a secret -- a username). */
  actor: string;
  requestId?: string | null;
}

export interface DustSettlementDeps {
  positions: PositionRepository;
  txAttempts: TransactionAttemptRepository;
  swapExecutor: SwapExecutor;
  /** Injectable for tests -- defaults to the real on-chain ERC20 balance read. */
  readTokenBalance?: (token: Address, wallet: Address) => Promise<bigint>;
  walletAddress?: Address;
  now?: () => Date;
  /** Structured audit sink. Never receives secrets. */
  auditLog?: (event: string, data: Record<string, unknown>) => void;
}

export interface DustDecisionFacts {
  tokenAddress: string;
  tokenDecimals: number;
  residualTokenRaw: bigint;
  quotedUsdgRaw: bigint;
  thresholdUsdgRaw: bigint;
  quotedAt: Date;
}

export type DustSettlementResult =
  | ({ outcome: 'SETTLED'; positionId: string; realizedUsdgRaw: bigint | null; closedAt: Date } & DustDecisionFacts)
  | { outcome: 'ALREADY_SETTLED'; positionId: string; settlement: DustSettlementRecord }
  | { outcome: 'REJECTED'; reason: DustRejectReason; detail: string };

/** The exact string an operator must send to authorise abandoning a residual. */
export const DUST_CONFIRMATION = 'ABANDON_DUST';

const POSSIBLY_MINED_UNVERIFIED = new Set(['SIGNED', 'SENT', 'CONFIRMED']);
const reject = (reason: DustRejectReason, detail: string): DustSettlementResult => ({ outcome: 'REJECTED', reason, detail });

/**
 * The policy itself, pure and total: is this residual dust?
 *
 * STRICTLY below the threshold -- a residual exactly AT the threshold is not
 * dust, so the boundary can never be argued about. A non-positive or unreadable
 * quote is never treated as "worth nothing".
 */
export function isDustValue(quotedUsdgRaw: bigint, thresholdUsdgRaw: bigint): boolean {
  // A negative quote is never "worth nothing" -- it is nonsense, and nonsense is
  // never dust. With that guard in place a zero (or negative) threshold disables
  // the whole mechanism on its own: nothing can be strictly below it.
  if (quotedUsdgRaw < 0n) return false;
  return quotedUsdgRaw < thresholdUsdgRaw;
}

/** True when a quote taken at `quotedAt` is still fresh enough to decide on. */
export function isQuoteFresh(quotedAt: Date, now: Date, maxAgeMs: number): boolean {
  const ageMs = now.getTime() - quotedAt.getTime();
  return ageMs >= 0 && ageMs <= maxAgeMs;
}

function bigintField(data: unknown, field: string): bigint | null {
  if (typeof data !== 'object' || data === null) return null;
  const raw = (data as Record<string, unknown>)[field];
  if (typeof raw === 'bigint') return raw;
  if (typeof raw === 'string') {
    const cleaned = raw.startsWith('bigint:') ? raw.slice('bigint:'.length) : raw;
    try {
      return BigInt(cleaned);
    } catch {
      return null;
    }
  }
  return null;
}

/**
 * Executes an operator-authorised dust settlement. Read-only against the chain
 * (one balance read plus one quote); the only write is the position's normal
 * CLOSING -> CLOSED transition, with the abandonment recorded atomically.
 */
export async function settleResidualDust(deps: DustSettlementDeps, request: DustSettlementRequest): Promise<DustSettlementResult> {
  const now = deps.now ?? (() => new Date());
  const readBalance = deps.readTokenBalance ?? readErc20Balance;
  const wallet = deps.walletAddress ?? getExecutorAddress();
  const thresholdUsdgRaw = config.rules.exits.DUST_SETTLEMENT.MAX_USDG_VALUE_RAW;

  if (!request.positionId || !request.closeIdempotencyKey) return reject('INVALID_REQUEST', 'positionId and closeIdempotencyKey are required');
  if (request.confirm !== DUST_CONFIRMATION) {
    return reject('NOT_CONFIRMED', `abandoning a residual requires an explicit confirmation field equal to "${DUST_CONFIRMATION}"`);
  }

  // Idempotency: a position already settled this way returns its recorded
  // settlement unchanged -- never a second close, never a second record.
  const existing = await deps.positions.findDustSettlementByPositionId(request.positionId);
  if (existing) return { outcome: 'ALREADY_SETTLED', positionId: request.positionId, settlement: existing };

  const position = await deps.positions.findById(request.positionId);
  if (!position) return reject('POSITION_NOT_FOUND', `no position ${request.positionId}`);
  if (position.status !== 'CLOSING') return reject('POSITION_NOT_CLOSING', `position is ${position.status} -- only a CLOSING position can be dust-settled`);
  if (position.closeIdempotencyKey !== request.closeIdempotencyKey) {
    return reject('STALE_CLOSE_LIFECYCLE', 'the position is in a different close lifecycle than the one this request names');
  }

  // The residual is the receipt-proven TOKEN the remove-liquidity leg paid --
  // never an operator-supplied number, never a wallet balance.
  const removeKey = `${position.closeIdempotencyKey}:removeLiquidity`;
  const remove = await deps.txAttempts.find(removeKey);
  if (remove?.status !== 'VERIFIED') return reject('REMOVE_NOT_VERIFIED', 'remove-liquidity is not VERIFIED -- there is no proven residual to abandon');
  const residualTokenRaw = bigintField(remove.verifyData, 'tokenProceedsRaw');
  const removeUsdgRaw = bigintField(remove.verifyData, 'usdgProceedsRaw');
  if (residualTokenRaw === null) return reject('TOKEN_RESIDUAL_UNKNOWN', 'the remove-liquidity attempt has no receipt-recorded TOKEN proceeds -- the residual cannot be proven');
  if (residualTokenRaw <= 0n) return reject('NO_TOKEN_RESIDUAL', 'the remove-liquidity receipt paid no TOKEN -- there is nothing to abandon');

  // Never settle around an exit transaction that may still land.
  const legs = await deps.txAttempts.findByKeyPrefixes([exitLegKeyPrefix(position.closeIdempotencyKey)]);
  const inFlight = legs.find((a) => POSSIBLY_MINED_UNVERIFIED.has(a.status));
  if (inFlight) return reject('EXIT_TX_IN_FLIGHT', `exit transaction ${inFlight.idempotencyKey} is ${inFlight.status} -- it may still land; wait for it to resolve`);
  const verifiedSwap = legs.find((a) => a.purpose === 'exit:swap' && a.status === 'VERIFIED');
  if (verifiedSwap) return reject('SWAP_ALREADY_VERIFIED', "the bot's own swap is VERIFIED -- the normal exit finalizes this position");

  // The residual must actually still be in the wallet: if it is not, something
  // else happened to it (an external sale), which is manual settlement's job.
  let balance: bigint;
  try {
    balance = await readBalance(position.tokenAddress, wallet);
  } catch (err) {
    return reject('BALANCE_UNVERIFIABLE', `could not read the wallet TOKEN balance: ${err instanceof Error ? err.message.split('\n')[0] : String(err)}`);
  }
  if (balance < residualTokenRaw) {
    return reject('BALANCE_BELOW_RESIDUAL', `wallet holds ${balance} TOKEN but the proven residual is ${residualTokenRaw} -- the residual is not intact, use receipt settlement instead`);
  }

  // FRESH read-only quote for EXACTLY the residual. Nothing is executed.
  const quotedAt = now();
  let quotedUsdgRaw: bigint;
  try {
    const quote = await deps.swapExecutor.getQuote(position.tokenAddress, residualTokenRaw, config.rules.exits.DUST_SETTLEMENT.QUOTE_SLIPPAGE_BPS);
    if (quote.amountInRaw !== residualTokenRaw) {
      return reject('QUOTE_UNAVAILABLE', `the quote is for ${quote.amountInRaw} TOKEN, not the residual ${residualTokenRaw} -- refusing to value a different amount`);
    }
    quotedUsdgRaw = quote.expectedAmountOutRaw;
  } catch (err) {
    return reject('QUOTE_UNAVAILABLE', `no fresh quote for the residual: ${err instanceof Error ? err.message.split('\n')[0] : String(err)}`);
  }
  if (!isQuoteFresh(quotedAt, now(), config.rules.exits.DUST_SETTLEMENT.QUOTE_MAX_AGE_MS)) {
    return reject('QUOTE_STALE', 'the valuation quote took longer than the configured freshness window -- refusing to decide on a stale price');
  }
  if (!isDustValue(quotedUsdgRaw, thresholdUsdgRaw)) {
    return reject(
      'NOT_DUST',
      `residual ${residualTokenRaw} TOKEN is worth ${quotedUsdgRaw} raw USDG, which is not below the configured dust threshold ${thresholdUsdgRaw} -- it must be sold, not abandoned`,
    );
  }

  const facts: DustDecisionFacts = {
    tokenAddress: position.tokenAddress,
    tokenDecimals: position.tokenDecimals,
    residualTokenRaw,
    quotedUsdgRaw,
    thresholdUsdgRaw,
    quotedAt,
  };
  const settledAt = now();
  // The close is the ONE normal finalization path, conditional on this exact
  // lifecycle, with the abandonment recorded in the same transaction.
  // `realizedUsdgRaw` is the USDG the receipts actually paid -- the abandoned
  // dust is NOT added to it, because it was never received.
  const closed = await deps.positions.markClosed(
    position.id,
    settledAt,
    'DUST_SETTLEMENT',
    removeUsdgRaw,
    request.closeIdempotencyKey,
    undefined,
    { ...facts, actor: request.actor, requestId: request.requestId ?? null },
  );
  if (!closed) {
    const already = await deps.positions.findDustSettlementByPositionId(position.id);
    if (already) return { outcome: 'ALREADY_SETTLED', positionId: position.id, settlement: already };
    return reject('CLOSE_LOST_RACE', 'the position left this CLOSING lifecycle while the settlement was being evaluated -- nothing was written');
  }

  deps.auditLog?.('DUST_SETTLEMENT', {
    positionId: position.id,
    actor: request.actor,
    action: 'DUST_SETTLEMENT',
    token: facts.tokenAddress,
    residualAmountRaw: facts.residualTokenRaw.toString(),
    tokenDecimals: facts.tokenDecimals,
    quotedUsdgRaw: facts.quotedUsdgRaw.toString(),
    thresholdUsdgRaw: facts.thresholdUsdgRaw.toString(),
    closeIdempotencyKey: request.closeIdempotencyKey,
    quotedAt: facts.quotedAt.toISOString(),
    timestamp: settledAt.toISOString(),
    requestId: request.requestId ?? null,
    realizedUsdgRaw: closed.realizedUsdgRaw === null ? null : closed.realizedUsdgRaw.toString(),
    note: 'TOKEN residual abandoned -- no swap, no transaction, no proceeds',
  });

  return { outcome: 'SETTLED', positionId: position.id, realizedUsdgRaw: closed.realizedUsdgRaw, closedAt: settledAt, ...facts };
}
