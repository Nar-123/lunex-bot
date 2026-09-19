import type { Address, Log } from 'viem';
import { TransactionNotFoundError, TransactionReceiptNotFoundError, toEventSelector } from 'viem';
import { config } from '../config';
import { decodeErc20Transfers } from '../blockchain/erc20';
import type { DecodedErc20Transfer } from '../blockchain/erc20';
import { getPublicClient } from '../blockchain/viemClient';
import { exitLegKeyPrefix } from '../capital/freshCapitalSnapshot';
import type { TransactionAttemptRepository } from '../execution/types';
import type { ManualSettlementRecord, PositionRepository } from '../positions/types';
import { ManualSettlementTxAlreadyUsedError } from '../positions/types';
import type { ExitStateRepository } from './types';

/**
 * MANUAL TOKEN SETTLEMENT VIA RECEIPT.
 *
 * A CLOSING position whose remove-liquidity receipt proved TOKEN > 0 and
 * whose TOKEN swap the bot cannot route (see `closingRecovery.ts`) may have
 * had that TOKEN sold by the operator OUTSIDE the bot. This finalizes such
 * a position -- through the one normal finalization path, `markClosed` --
 * ONLY when an operator-supplied transaction's OWN RECEIPT proves it:
 *
 *  - the transaction exists, is mined, succeeded, on the configured chain;
 *  - it was SENT BY the bot wallet (only the wallet key can author it --
 *    no third party can manufacture this evidence) with no native value;
 *  - it is ordered strictly AFTER this lifecycle's verified remove-liquidity
 *    (so a transaction from an earlier lifecycle -- e.g. a previous
 *    position's normal exit swap of the same token -- can never be
 *    replayed against this one);
 *  - its ERC20 `Transfer` logs show exactly ONE transfer of THIS position's
 *    TOKEN out of the wallet, of at least the receipt-proven residual, and
 *    USDG (the configured official contract) into the wallet;
 *  - the wallet appears in NO other event of the transaction (other than
 *    value-free ERC20 `Approval`s) -- so the wallet's whole ERC20 effect is
 *    "-TOKEN, +USDG" and ALL of that USDG is attributable to this TOKEN
 *    (no other asset of the wallet could have paid for it).
 *
 * Nothing the operator types is financial proof: amounts come only from
 * the receipt. Wallet balances are never read. Binding to the POSITION:
 * the TOKEN is position-specific (a partial unique index allows at most
 * one non-CLOSED position per token), the lifecycle is pinned by the
 * operator-supplied `closeIdempotencyKey` AND the conditional
 * `markClosed(expectedCloseIdempotencyKey)`, and the txHash is recorded
 * (primary key) in the same transaction as the close.
 *
 * Aggregation follows the existing swap verification: every USDG
 * `Transfer(... -> wallet)` in the receipt is summed; TOKEN disposed beyond
 * the residual is credited to this position exactly as the bot's own exit
 * swap already does (it swaps the wallet's whole TOKEN balance).
 *
 * PARTIAL disposal (TOKEN out < residual) is REJECTED and nothing is
 * written: the position stays CLOSING with the full residual still
 * unresolved. Combining several transactions would need a multi-transaction
 * settlement ledger and cross-transaction attribution, which this does not
 * implement -- the operator must dispose of at least the full residual in
 * one transaction.
 */

export type SettlementRejectReason =
  | 'INVALID_REQUEST'
  | 'POSITION_NOT_FOUND'
  | 'POSITION_NOT_CLOSING'
  | 'STALE_CLOSE_LIFECYCLE'
  | 'POSITION_BUSY'
  | 'REMOVE_NOT_VERIFIED'
  | 'NO_TOKEN_RESIDUAL'
  | 'TOKEN_RESIDUAL_UNKNOWN'
  | 'EXIT_TX_IN_FLIGHT'
  | 'SWAP_ALREADY_VERIFIED'
  | 'TX_ALREADY_USED'
  | 'CHAIN_READ_FAILED'
  | 'WRONG_CHAIN'
  | 'TX_NOT_FOUND'
  | 'TX_PENDING'
  | 'TX_REVERTED'
  | 'NOT_FROM_BOT_WALLET'
  | 'TX_NOT_AFTER_REMOVE_LIQUIDITY'
  | 'NO_TOKEN_DISPOSAL'
  | 'TOKEN_WRONG_DIRECTION'
  | 'INSUFFICIENT_TOKEN_DISPOSED'
  | 'NO_USDG_RECEIVED'
  | 'USDG_WRONG_DIRECTION'
  | 'UNABLE_TO_BIND_TRANSACTION_TO_POSITION';

export type ManualSettlementResult =
  | { outcome: 'SETTLED'; positionId: string; txHash: string; tokenDisposedRaw: bigint; usdgProceedsRaw: bigint; realizedUsdgRaw: bigint; closedAt: Date }
  | { outcome: 'ALREADY_SETTLED'; positionId: string; txHash: string; tokenDisposedRaw: bigint; usdgProceedsRaw: bigint; realizedUsdgRaw: bigint | null; closedAt: Date | null }
  | { outcome: 'REJECTED'; reason: SettlementRejectReason; detail: string };

/** The minimal on-chain facts the proof reads -- a port so tests inject exact transactions/receipts. */
export interface SettlementTxView {
  from: string;
  /** EIP-155 chain id the transaction was signed for; null when the transaction carries none. */
  chainId: number | null;
  value: bigint;
}

export interface SettlementReceiptView {
  status: 'success' | 'reverted';
  blockNumber: bigint;
  transactionIndex: number;
  logs: readonly Log[];
}

export interface ManualSettlementChainReader {
  getChainId(): Promise<number>;
  /** null = no such transaction on this chain. */
  getTransaction(hash: `0x${string}`): Promise<SettlementTxView | null>;
  /** null = not mined yet. */
  getReceipt(hash: `0x${string}`): Promise<SettlementReceiptView | null>;
}

export function createViemSettlementChainReader(): ManualSettlementChainReader {
  return {
    getChainId: () => getPublicClient().getChainId(),
    getTransaction: async (hash) => {
      try {
        const tx = await getPublicClient().getTransaction({ hash });
        return { from: tx.from, chainId: tx.chainId ?? null, value: tx.value };
      } catch (err) {
        if (err instanceof TransactionNotFoundError) return null;
        throw err;
      }
    },
    getReceipt: async (hash) => {
      try {
        const r = await getPublicClient().getTransactionReceipt({ hash });
        return { status: r.status, blockNumber: r.blockNumber, transactionIndex: r.transactionIndex, logs: r.logs };
      } catch (err) {
        if (err instanceof TransactionReceiptNotFoundError) return null;
        throw err;
      }
    },
  };
}

const TX_HASH_RE = /^0x[0-9a-f]{64}$/;
const APPROVAL_SELECTOR = toEventSelector('Approval(address,address,uint256)');
const POSSIBLY_MINED_UNVERIFIED = new Set(['SIGNED', 'SENT', 'CONFIRMED']);

const reject = (reason: SettlementRejectReason, detail: string): ManualSettlementResult => ({ outcome: 'REJECTED', reason, detail });
const topicFor = (address: string): string => `0x${'0'.repeat(24)}${address.toLowerCase().slice(2)}`;

export interface SettlementReceiptContext {
  wallet: Address;
  token: Address;
  usdg: Address;
  chainId: number;
  residualTokenRaw: bigint;
  /** Where this lifecycle's verified remove-liquidity landed -- the settlement must come strictly after it. */
  removeLiquidityAt: { blockNumber: bigint; transactionIndex: number };
}

export type SettlementReceiptVerdict =
  | { ok: true; tokenDisposedRaw: bigint; usdgProceedsRaw: bigint }
  | { ok: false; reason: SettlementRejectReason; detail: string };

/**
 * The proof itself -- pure: a transaction + its receipt either settle the
 * residual TOKEN of the position described by `ctx`, or are rejected with
 * the first failed condition. Never reads balances, never trusts input
 * amounts.
 */
export function evaluateSettlementReceipt(tx: SettlementTxView, receipt: SettlementReceiptView, ctx: SettlementReceiptContext): SettlementReceiptVerdict {
  const no = (reason: SettlementRejectReason, detail: string): SettlementReceiptVerdict => ({ ok: false, reason, detail });
  const wallet = ctx.wallet.toLowerCase();
  const token = ctx.token.toLowerCase();
  const usdg = ctx.usdg.toLowerCase();

  if (receipt.status !== 'success') return no('TX_REVERTED', 'the transaction reverted -- it moved nothing');
  if (tx.chainId !== ctx.chainId) return no('WRONG_CHAIN', `transaction chainId ${tx.chainId ?? 'none'} is not the configured chain ${ctx.chainId}`);
  if (tx.from.toLowerCase() !== wallet) return no('NOT_FROM_BOT_WALLET', 'the transaction was not sent by the bot wallet');
  if (tx.value !== 0n) return no('UNABLE_TO_BIND_TRANSACTION_TO_POSITION', 'the transaction also spent native currency -- the USDG received cannot be attributed to the TOKEN alone');
  const after =
    receipt.blockNumber > ctx.removeLiquidityAt.blockNumber ||
    (receipt.blockNumber === ctx.removeLiquidityAt.blockNumber && receipt.transactionIndex > ctx.removeLiquidityAt.transactionIndex);
  if (!after) return no('TX_NOT_AFTER_REMOVE_LIQUIDITY', 'the transaction is not after this lifecycle\'s remove-liquidity -- it cannot have disposed of TOKEN that the removal paid');

  const transfers = decodeErc20Transfers(receipt.logs);
  const tokenOut = transfers.filter((t) => t.token === token && t.from === wallet && t.to !== wallet);
  const usdgIn = transfers.filter((t) => t.token === usdg && t.to === wallet && t.from !== wallet);

  if (tokenOut.length === 0) {
    if (transfers.some((t) => t.token === token && t.to === wallet)) return no('TOKEN_WRONG_DIRECTION', 'the position TOKEN moved INTO the wallet, not out of it');
    return no('NO_TOKEN_DISPOSAL', 'no transfer of the position TOKEN out of the wallet');
  }
  if (tokenOut.length > 1) return no('UNABLE_TO_BIND_TRANSACTION_TO_POSITION', `${tokenOut.length} separate TOKEN transfers out of the wallet -- which one settles this position cannot be attributed exactly`);
  const [disposal] = tokenOut as [DecodedErc20Transfer];
  const tokenDisposedRaw = disposal.value;
  if (tokenDisposedRaw < ctx.residualTokenRaw) {
    return no('INSUFFICIENT_TOKEN_DISPOSED', `disposed ${tokenDisposedRaw} TOKEN, the unresolved residual is ${ctx.residualTokenRaw} -- partial settlement is not accepted`);
  }
  if (usdgIn.length === 0) {
    if (transfers.some((t) => t.token === usdg && t.from === wallet)) return no('USDG_WRONG_DIRECTION', 'USDG moved OUT of the wallet, not into it');
    return no('NO_USDG_RECEIVED', 'no official-USDG transfer into the wallet');
  }

  // Exact attribution: the wallet may appear in no other event -- any other
  // wallet transfer (another token out, USDG out, TOKEN in, an NFT, a WETH
  // unwrap, ...) means the USDG could have been paid for by something else.
  const accounted = new Set([...tokenOut, ...usdgIn].map((t) => t.logIndex));
  const walletTopic = topicFor(wallet);
  for (const log of receipt.logs) {
    const topics = (log.topics as readonly string[]).map((t) => t.toLowerCase());
    if (!topics.slice(1).includes(walletTopic)) continue;
    if (topics[0] === APPROVAL_SELECTOR && topics.length === 3) continue; // allowance bookkeeping, moves no value
    if (log.logIndex !== null && accounted.has(log.logIndex)) continue;
    return no('UNABLE_TO_BIND_TRANSACTION_TO_POSITION', `the wallet is also involved in another event (contract ${log.address.toLowerCase()}, topic ${topics[0] ?? 'none'}) -- the USDG cannot be attributed to this TOKEN alone`);
  }

  const usdgProceedsRaw = usdgIn.reduce((sum, t) => sum + t.value, 0n);
  return { ok: true, tokenDisposedRaw, usdgProceedsRaw };
}

export interface ManualTokenSettlementDeps {
  positions: PositionRepository;
  txAttempts: TransactionAttemptRepository;
  exitStates: ExitStateRepository;
  chain: ManualSettlementChainReader;
  walletAddress: Address;
  /** Defaults to the configured official USDG. */
  usdgAddress?: Address;
  /** Defaults to the configured chain. */
  chainId?: number;
  log?: (event: string, data: Record<string, unknown>) => void;
}

export interface ManualTokenSettlementRequest {
  positionId: string;
  txHash: string;
  /** The close lifecycle the operator is settling (shown by GET /positions/stuck) -- an old request can never finalize a newer lifecycle. */
  closeIdempotencyKey: string;
}

function bigintField(data: unknown, field: string): bigint | null {
  if (typeof data !== 'object' || data === null || !(field in data)) return null;
  const value = (data as Record<string, unknown>)[field];
  return typeof value === 'bigint' ? value : null;
}

const alreadySettled = (s: ManualSettlementRecord, realizedUsdgRaw: bigint | null, closedAt: Date | null): ManualSettlementResult => ({
  outcome: 'ALREADY_SETTLED',
  positionId: s.positionId,
  txHash: s.txHash,
  tokenDisposedRaw: s.tokenDisposedRaw,
  usdgProceedsRaw: s.usdgProceedsRaw,
  realizedUsdgRaw,
  closedAt,
});

export async function settleResidualTokenViaReceipt(deps: ManualTokenSettlementDeps, request: ManualTokenSettlementRequest): Promise<ManualSettlementResult> {
  const txHash = request.txHash.toLowerCase();
  if (!TX_HASH_RE.test(txHash)) return reject('INVALID_REQUEST', 'txHash must be a 0x-prefixed 32-byte hex transaction hash');

  const position = await deps.positions.findById(request.positionId);
  if (!position) return reject('POSITION_NOT_FOUND', 'no such position');

  // Idempotency: a transaction already recorded settles only the position it settled.
  const recorded = await deps.positions.findManualSettlementByTxHash(txHash);
  if (recorded && recorded.positionId !== position.id) return reject('TX_ALREADY_USED', 'this transaction already settled a different position');
  if (position.status !== 'CLOSING') {
    if (recorded && position.status === 'CLOSED') return alreadySettled(recorded, position.realizedUsdgRaw, position.closedAt);
    return reject('POSITION_NOT_CLOSING', `position is ${position.status} -- only a CLOSING position can be settled`);
  }
  if (position.closeIdempotencyKey !== request.closeIdempotencyKey) {
    return reject('STALE_CLOSE_LIFECYCLE', 'the position is in a different close lifecycle than the one this request names');
  }

  // Same mutual exclusion as the exit worker (executeExit): nothing else
  // acts on this position while the receipt is checked and the close written.
  const claim = await deps.positions.claimForResume(position.id, 'CLOSING', config.rules.execution.RESUME_CLAIM_FRESHNESS_MS);
  if (claim === null) return reject('POSITION_BUSY', 'the position is being processed right now (exit worker or another settlement) -- retry shortly');
  try {
    const closeKey = request.closeIdempotencyKey;
    const legs = await deps.txAttempts.findByKeyPrefixes([exitLegKeyPrefix(closeKey)]);
    const remove = legs.find((a) => a.idempotencyKey === `${closeKey}:removeLiquidity`);
    if (!remove || remove.status !== 'VERIFIED' || !remove.txHash) return reject('REMOVE_NOT_VERIFIED', 'this lifecycle\'s remove-liquidity is not VERIFIED');
    const residualTokenRaw = bigintField(remove.verifyData, 'tokenProceedsRaw');
    const removeUsdgRaw = bigintField(remove.verifyData, 'usdgProceedsRaw');
    if (residualTokenRaw === null || removeUsdgRaw === null) return reject('TOKEN_RESIDUAL_UNKNOWN', 'the remove-liquidity attempt has no receipt-recorded TOKEN/USDG proceeds (legacy) -- the residual cannot be proven');
    if (residualTokenRaw === 0n) return reject('NO_TOKEN_RESIDUAL', 'the remove-liquidity receipt paid no TOKEN -- there is nothing to settle (the normal USDG-only close applies)');
    const inFlight = legs.find((a) => POSSIBLY_MINED_UNVERIFIED.has(a.status));
    if (inFlight) return reject('EXIT_TX_IN_FLIGHT', `exit transaction ${inFlight.idempotencyKey} is ${inFlight.status} -- it may still land; wait for it to resolve`);
    if (legs.some((a) => a.idempotencyKey.startsWith(`${closeKey}:swap:`) && a.status === 'VERIFIED')) {
      return reject('SWAP_ALREADY_VERIFIED', 'the bot\'s own swap is VERIFIED -- the normal exit finalizes this position');
    }

    let tx: SettlementTxView | null;
    let receipt: SettlementReceiptView | null;
    let removeReceipt: SettlementReceiptView | null;
    try {
      const rpcChainId = await deps.chain.getChainId();
      const chainId = deps.chainId ?? config.chain.chainId;
      if (rpcChainId !== chainId) return reject('WRONG_CHAIN', `the RPC serves chain ${rpcChainId}, not the configured chain ${chainId}`);
      tx = await deps.chain.getTransaction(txHash as `0x${string}`);
      if (!tx) return reject('TX_NOT_FOUND', 'no such transaction on the configured chain');
      receipt = await deps.chain.getReceipt(txHash as `0x${string}`);
      if (!receipt) return reject('TX_PENDING', 'the transaction is not mined yet -- retry once it is');
      removeReceipt = await deps.chain.getReceipt(remove.txHash);
      if (!removeReceipt) return reject('CHAIN_READ_FAILED', 'could not read this lifecycle\'s remove-liquidity receipt');
    } catch (err) {
      return reject('CHAIN_READ_FAILED', `chain read failed: ${err instanceof Error ? err.message : String(err)}`);
    }

    const verdict = evaluateSettlementReceipt(tx, receipt, {
      wallet: deps.walletAddress,
      token: position.tokenAddress,
      usdg: deps.usdgAddress ?? (config.quoteAsset.ADDRESS as Address),
      chainId: deps.chainId ?? config.chain.chainId,
      residualTokenRaw,
      removeLiquidityAt: { blockNumber: removeReceipt.blockNumber, transactionIndex: removeReceipt.transactionIndex },
    });
    if (!verdict.ok) return reject(verdict.reason, verdict.detail);

    // PnL: the remove leg's receipt USDG + this receipt's USDG -- the same
    // "remove + swap" sum a normal TOKEN exit realizes; nothing else.
    const realizedUsdgRaw = removeUsdgRaw + verdict.usdgProceedsRaw;
    const exitState = await deps.exitStates.getOrCreate(position.id);
    const closedAt = new Date();
    let closed;
    try {
      closed = await deps.positions.markClosed(position.id, closedAt, exitState.pendingCloseReason ?? 'UNKNOWN', realizedUsdgRaw, closeKey, {
        txHash,
        tokenDisposedRaw: verdict.tokenDisposedRaw,
        usdgProceedsRaw: verdict.usdgProceedsRaw,
        blockNumber: receipt.blockNumber,
      });
    } catch (err) {
      if (err instanceof ManualSettlementTxAlreadyUsedError) return reject('TX_ALREADY_USED', 'this transaction is already recorded as a settlement');
      throw err;
    }
    if (!closed) {
      const now = await deps.positions.findManualSettlementByTxHash(txHash);
      const row = await deps.positions.findById(position.id);
      if (now && now.positionId === position.id) return alreadySettled(now, row?.realizedUsdgRaw ?? null, row?.closedAt ?? null);
      return reject('POSITION_NOT_CLOSING', 'the position left this close lifecycle before the settlement could be written -- nothing written');
    }
    deps.log?.('manual_token_settlement', {
      positionId: position.id,
      txHash,
      tokenDisposedRaw: verdict.tokenDisposedRaw.toString(),
      usdgProceedsRaw: verdict.usdgProceedsRaw.toString(),
      realizedUsdgRaw: realizedUsdgRaw.toString(),
    });
    return { outcome: 'SETTLED', positionId: position.id, txHash, tokenDisposedRaw: verdict.tokenDisposedRaw, usdgProceedsRaw: verdict.usdgProceedsRaw, realizedUsdgRaw, closedAt };
  } finally {
    await deps.positions.releaseResumeClaim(position.id, claim);
  }
}
