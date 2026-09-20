import { randomUUID } from 'node:crypto';
import type { Address } from 'viem';
import { config } from '../config';
import { readErc20Allowance } from '../blockchain/erc20';
import { discoverMintedTokenId } from '../blockchain/erc721';
import { getExecutorAddress } from '../blockchain/walletClient';
import { executeCriticalTransaction, safeErrorMessage } from '../execution/executeCriticalTransaction';
import type { TransactionAttemptRepository, TxSafetyDeps } from '../execution/types';
import type { LivePositionStateProvider, PoolPriceProvider } from '../monitoring/types';
import type { CreatePositionInput, PositionPoolContext, PositionRecord, PositionRepository } from './types';
import { DuplicateActiveTokenPositionError, openMintAttemptKey } from './types';
import type { CapitalRules } from '../capital/types';
import { buildApproveDeps as realBuildApproveDeps, needsApproval, type ApproveVerifyData } from './approveTx';
import { buildMintDeps as realBuildMintDeps, type MintInput, type MintVerifyData } from './mintTx';
import { runPermit2Preflight, type Permit2PreflightResult } from './permit2Preflight';

export type OpenPositionOutcome =
  | { outcome: 'ACTIVE'; position: PositionRecord }
  /** `entryPausedBy`: the reservation was refused by the entry gate -- nothing was created; the caller stops deploying. */
  | {
      outcome: 'FAILED';
      reason: string;
      entryPausedBy?: 'OPERATOR' | 'AI';
      /** The v4 Permit2 pre-flight refused the entry BEFORE any capital reservation (wallet-level: every candidate would fail the same way). */
      blockedByPermit2?: Permit2PreflightResult;
    }
  | { outcome: 'PENDING'; reason: string };

export interface OpenPositionInput {
  tokenAddress: Address;
  tokenSymbol: string;
  tokenDecimals: number;
  pool: PositionPoolContext;
  tickLower: number;
  tickUpper: number;
  /** The decided position size -- `decideCapitalAllocation`'s `positionSizeUsdgRaw` (35% of the stable base portfolio balance, truncated as needed to respect the 3-position and 95%-exposure caps). */
  entryUsdgRaw: bigint;
  /** The pool price snapshot the range/decision were computed from (Modules 3/4) -- the PNL basis, recorded once, never recomputed. The ACTUAL mint transaction reads a FRESH live price at build time (see `mintTx.ts`), same as `exits/removeLiquidityTx.ts` -- these two can legitimately differ if price moved between decision and execution. */
  entryTick: number;
  entrySqrtPriceX96: bigint;
  /**
   * P1-1: a reader for the RAW on-chain USDG balance (no OPENING
   * reservation subtracted -- `CapitalSnapshotProvider.readOnChainUsdgBalance`)
   * plus the SAME `CapitalRules` `screeningCycle.ts` used to decide
   * `entryUsdgRaw` -- passed through so `positions.createIfCapitalAllows`
   * can re-derive free capital, deployed total and position count from ONE
   * consistent, freshly-read state while holding `CapitalLock`, instead of
   * pairing a stale pre-derived free balance with a fresh deployed sum
   * (which double-counted concurrent OPENING reservations).
   */
  readOnChainUsdgBalance: () => Promise<bigint>;
  capitalRules: CapitalRules;
}

export interface OpenPositionDeps {
  positions: PositionRepository;
  txAttempts: TransactionAttemptRepository;
  livePositionState: LivePositionStateProvider;
  poolPrice: PoolPriceProvider;
  /** Injectable, defaulting to the real implementations -- same testability reasoning as `exits/executeExit.ts`'s equivalent fields. */
  buildApproveDeps?: (amountInRaw: bigint) => TxSafetyDeps<ApproveVerifyData>;
  buildMintDeps?: (input: MintInput, live: LivePositionStateProvider, pool: PoolPriceProvider) => TxSafetyDeps<MintVerifyData>;
  readAllowance?: (tokenAddress: Address, owner: Address, spender: Address) => Promise<bigint>;
  walletAddress?: Address;
  /** v4 Permit2 pre-flight (read-only). Injectable for tests -- defaults to the real on-chain reads. */
  permit2Preflight?: (requiredAmount: bigint) => Promise<Permit2PreflightResult>;
  /** Receives a deployable-but-noteworthy pre-flight result (grant expiring soon). */
  onPermit2Warning?: (result: Permit2PreflightResult) => void;
  /** Injectable for tests -- defaults to the real on-chain Transfer-log lookup (see the "defense-in-depth" fallback in `executeOpen`). */
  discoverTokenId?: (txHash: `0x${string}`, contractAddress: Address, recipient: Address) => Promise<bigint>;
}

/**
 * Starts a brand-new open-position attempt: creates the `Position` row
 * (status OPENING, a fresh `openIdempotencyKey`) BEFORE any
 * `executeCriticalTransaction` call -- same reasoning as every other
 * critical flow in this project (the row must exist first so the same key
 * covers the whole flow for crash recovery, per Revision 6). Called by the
 * 30-minute screening cycle once a candidate has passed every filter and
 * `decideCapitalAllocation` has approved a size.
 */
export async function openPosition(input: OpenPositionInput, deps: OpenPositionDeps): Promise<OpenPositionOutcome> {
  const createInput: CreatePositionInput = {
    tokenAddress: input.tokenAddress,
    tokenSymbol: input.tokenSymbol,
    tokenDecimals: input.tokenDecimals,
    pool: input.pool,
    tickLower: input.tickLower,
    tickUpper: input.tickUpper,
    entryUsdgRaw: input.entryUsdgRaw,
    entrySqrtPriceX96: input.entrySqrtPriceX96,
    entryTick: input.entryTick,
    openIdempotencyKey: `deploy:${input.tokenAddress}:${randomUUID()}`,
  };
  // P1-1/P1-2 fix: `createIfCapitalAllows` atomically (a) re-validates the
  // capital cap against a FRESH, transaction-scoped read (never trusting
  // the possibly-now-stale snapshot used several awaits ago to decide
  // `entryUsdgRaw` and select this candidate's pool/range), and (b) can
  // throw `DuplicateActiveTokenPositionError` if a real DB-level partial
  // unique index rejects the insert because a non-closed position for this
  // SAME token already exists (a second candidate for the same token that
  // got this far concurrently with the first, past the earlier
  // `duplicatePosition.ts` filter check). Both are DEFINITIVE, deterministic
  // facts (no on-chain ambiguity involved -- nothing was ever attempted for
  // THIS candidate), so both resolve as FAILED, never PENDING/resumable:
  // there is no position row here to retry against, and `screeningCycle.ts`'s
  // existing "try the next candidate on failure" policy already does the
  // right thing with it.
  // v4 Permit2 pre-flight -- BEFORE any capital reservation: an entry whose
  // mint is guaranteed to fail at settlement (expired/missing/insufficient
  // Permit2 grant, or a PositionManager bound to a different Permit2) must
  // not reserve capital, create a position, or spend gas on an approve.
  // Fails CLOSED: an RPC error reading it blocks this entry too.
  let preflight: Permit2PreflightResult;
  try {
    preflight = await (deps.permit2Preflight ?? runPermit2Preflight)(input.entryUsdgRaw);
  } catch (err) {
    const reason = `Permit2 pre-flight could not be read -- entry not attempted (fail closed): ${safeErrorMessage(err)}`;
    return { outcome: 'FAILED', reason, blockedByPermit2: { status: 'UNAVAILABLE', deployable: false, needsErc20Approval: false, reason, grantExpiration: 0, secondsUntilExpiry: 0, expiringSoon: false, grantNonce: 0 } };
  }
  if (!preflight.deployable) {
    return { outcome: 'FAILED', reason: `[PERMIT2_${preflight.status}] ${preflight.reason}`, blockedByPermit2: preflight };
  }
  if (preflight.expiringSoon) deps.onPermit2Warning?.(preflight);

  let created: PositionRecord;
  try {
    const result = await deps.positions.createIfCapitalAllows(createInput, input.readOnChainUsdgBalance, input.capitalRules);
    if (!result.ok) {
      return { outcome: 'FAILED', reason: result.reason, ...(result.entryPausedBy && { entryPausedBy: result.entryPausedBy }) };
    }
    created = result.record;
  } catch (err) {
    if (err instanceof DuplicateActiveTokenPositionError) {
      return { outcome: 'FAILED', reason: err.message };
    }
    throw err;
  }
  return executeOpen(created, deps);
}

/**
 * Resumes an open-position attempt already in flight -- a position at
 * OPENING found by `positions.findAllOpening()` (the mint-side mirror of
 * `exits/`'s `findAllClosing()` resume pass). Uses the position's
 * EXISTING `openIdempotencyKey`, unchanged: unlike `exits/`'s two-transaction
 * flow, a single-transaction mint has no earlier already-VERIFIED leg to
 * protect from duplication, so there is no fresh-key-per-retry pattern
 * here -- `executeCriticalTransaction`'s own idempotency resumes exactly
 * where the last attempt left off (e.g. a crash between SIGNED and
 * broadcast resumes from SIGNED, never re-signing).
 */
export async function resumeOpenPosition(position: PositionRecord, deps: OpenPositionDeps): Promise<OpenPositionOutcome> {
  return executeOpen(position, deps);
}

/**
 * The failed-open state machine -- deliberately SIMPLER than `exits/`'s,
 * per explicit review: this is ONE mandatory transaction (mint) plus one
 * CONDITIONAL transaction (approve, only if the current USDG allowance
 * for Permit2 -- the v4 settlement spender -- is insufficient) -- never two mandatory legs
 * where the first's success changes what "failure" means for the second.
 * A USDG-only one-sided deposit needs no swap up front (the decided size
 * is already USDG), so there is no analogue to `exits/`'s
 * remove-liquidity-then-swap sequencing risk at all.
 *
 * **Any DEFINITIVE failure -- in EITHER leg -- gets the SAME simple
 * response: `markFailed`, full stop.** No fresh-idempotency-key retry
 * pattern (unlike `exits/`'s swap leg): if approve or mint fails
 * definitively, nothing irreversible has happened (USDG never left the
 * wallet -- an approve() only sets an allowance, and a failed mint never
 * pulls funds), so this candidate is simply released. Its capital
 * automatically returns to `freeUsdgBalance` via the accounting already
 * proven correct in Revision 7 (a `FAILED` position is excluded from both
 * `reservedForOpening` and `totalDeployedUsdg` -- neither sum needed any
 * change for this module either, for the exact same reason). Retrying the
 * SAME mint with a fresh key would be actively wrong, not just
 * unnecessary: the pool price has moved since the candidate was decided,
 * and the candidate itself may no longer be worth opening -- the correct
 * "retry" is the NEXT 30-minute screening cycle evaluating fresh
 * candidates against fresh prices, not this module blindly re-attempting
 * stale parameters.
 *
 * **An AMBIGUOUS (`resumable: true`) failure in either leg** leaves the
 * position at OPENING, retried with the SAME idempotencyKey -- ordinary
 * Module 6 resumability, nothing extra needed.
 *
 * A position is marked ACTIVE ONLY after `mintTx.ts`'s `verifyOnChain`
 * confirms a real `positionTokenId` was discovered AND its on-chain
 * liquidity reads > 0 -- never on broadcast success or receipt confirmation
 * alone.
 */
async function executeOpen(position: PositionRecord, deps: OpenPositionDeps): Promise<OpenPositionOutcome> {
  // C7 concurrency fix: atomically claim this position before doing any
  // transaction-executing work. Both entry points (`openPosition`'s
  // brand-new candidate and `resumeOpenPosition`'s per-tick resume loop in
  // `composition/exitCycle.ts`) funnel through here, so this is the single
  // enforcement point that prevents the 30-minute screening cycle and the
  // 15-second exit/open-resume cycle -- two independently-scheduled,
  // unsynchronized timers (see `composition/app.ts`) -- from both acting
  // on the SAME position at once (e.g. a mint that takes >15s to mine is
  // otherwise guaranteed to be picked up mid-flight by the next exit-cycle
  // tick's OPENING-resume pass). Losing the claim is NOT a failure --
  // another caller already owns this position right now; deferring to it
  // is the safe outcome, never a duplicate mint attempt.
  const claimToken = await deps.positions.claimForResume(position.id, 'OPENING', config.rules.execution.RESUME_CLAIM_FRESHNESS_MS);
  if (claimToken === null) {
    return { outcome: 'PENDING', reason: 'position is already claimed by a concurrent open/resume attempt' };
  }
  // Released unconditionally (from THIS call's perspective) once this
  // call's work is done (success, definitive failure, or ambiguous/
  // PENDING) -- the claim's lifetime matches however long THIS attempt
  // actually takes, not a fixed timeout, so a long-running mint doesn't
  // stall a legitimate later resume once this call genuinely finishes.
  // P0-1: passes back the EXACT token this call won -- releaseResumeClaim
  // only clears the row if that token still matches, so a call that hangs
  // past `RESUME_CLAIM_FRESHNESS_MS` (losing the claim to a second worker)
  // can no longer release the SECOND worker's still-active claim when it
  // finally reaches this `finally` block.
  try {
    return await executeOpenClaimed(position, deps);
  } finally {
    await deps.positions.releaseResumeClaim(position.id, claimToken);
  }
}

async function executeOpenClaimed(position: PositionRecord, deps: OpenPositionDeps): Promise<OpenPositionOutcome> {
  const buildApproveDeps = deps.buildApproveDeps ?? realBuildApproveDeps;
  const buildMintDeps = deps.buildMintDeps ?? realBuildMintDeps;
  const readAllowance = deps.readAllowance ?? readErc20Allowance;
  const discoverTokenId = deps.discoverTokenId ?? discoverMintedTokenId;
  const wallet = deps.walletAddress ?? getExecutorAddress();
  const usdgAddress = config.quoteAsset.ADDRESS as Address;
  const positionManagerAddress = config.uniswap.v4.positionManager as Address;
  // The v4 mint settles through Permit2, so the ERC20 allowance that matters is the one to Permit2.
  const permit2Address = config.uniswap.v4.permit2 as Address;

  const currentAllowance = await readAllowance(usdgAddress, wallet, permit2Address);
  if (needsApproval(currentAllowance, position.entryUsdgRaw)) {
    const approveKey = `${position.openIdempotencyKey}:approve`;
    const approveDeps = buildApproveDeps(position.entryUsdgRaw);
    const approveResult = await executeCriticalTransaction(approveKey, 'deploy:approve', approveDeps, deps.txAttempts);

    if (!approveResult.ok) {
      if (!approveResult.resumable) {
        return fail(position, approveResult.reason, deps);
      }
      return { outcome: 'PENDING', reason: approveResult.reason };
    }
  }

  // Stuck-transaction audit: the approve leg can take a long time (or, as in
  // the incident, many ticks). If the position left OPENING meanwhile -- H3
  // expiry, or any other writer -- a mint must never be started for it. The
  // mint fence already stops a mint whose attempt row exists; this also
  // covers a lifecycle that was failed without one.
  const current = await deps.positions.findById(position.id);
  if (current?.status !== 'OPENING') {
    const now = current?.status ?? 'missing';
    return now === 'FAILED'
      ? { outcome: 'FAILED', reason: 'position was failed while its approve leg ran -- mint not started' }
      : { outcome: 'PENDING', reason: `position is no longer OPENING (now ${now}) -- mint not started` };
  }

  const mintKey = openMintAttemptKey(position.openIdempotencyKey);
  const mintInput: MintInput = {
    tokenAddress: position.tokenAddress,
    tokenSymbol: position.tokenSymbol,
    tokenDecimals: position.tokenDecimals,
    pool: position.pool,
    tickLower: position.tickLower,
    tickUpper: position.tickUpper,
    entryUsdgRaw: position.entryUsdgRaw,
  };
  const mintDeps = buildMintDeps(mintInput, deps.livePositionState, deps.poolPrice);
  const mintResult = await executeCriticalTransaction(mintKey, 'deploy:mint', mintDeps, deps.txAttempts);

  if (!mintResult.ok) {
    if (!mintResult.resumable) {
      return fail(position, mintResult.reason, deps);
    }
    return { outcome: 'PENDING', reason: mintResult.reason };
  }

  // The type says `data` is non-nullable (MintVerifyData has no null
  // fields) -- but this is documented defense-in-depth against a "should
  // be unreachable" state: executeCriticalTransaction's VERIFIED
  // short-circuit reconstructs verifyData from a LEGACY row that predates
  // the field, which at runtime can be anything JSON round-tripped. A mint
  // that has ALREADY SUCCEEDED on-chain must never crash here or, worse,
  // fall through to markFailed and release capital that's actually
  // already spent on a real, unmonitored LP position -- the runtime check
  // stays, deliberately against the type.
  // eslint-disable-next-line @typescript-eslint/no-unnecessary-condition
  if (mintResult.data == null) {
    const attempt = await deps.txAttempts.find(mintKey);
    if (attempt?.txHash) {
      try {
        const tokenId = await discoverTokenId(attempt.txHash, positionManagerAddress, wallet);
        return await activate(position, tokenId.toString(), deps);
      } catch {
        // Ambiguous -- fall through to PENDING below. Never markFailed: the
        // mint is VERIFIED, i.e. already confirmed successful on-chain.
      }
    }
    return { outcome: 'PENDING', reason: 'mint verified on-chain but positionTokenId could not be recovered yet' };
  }

  return activate(position, mintResult.data.positionTokenId, deps);
}

/**
 * Stale-writer fix: `markActive` is conditional on OPENING. If it wrote
 * nothing, another worker already moved the row: the same mint recorded
 * as ACTIVE is idempotent success; anything else is reported, never
 * overwritten (a late worker must not drag a CLOSING/CLOSED position back
 * to ACTIVE).
 */
async function activate(position: PositionRecord, positionTokenId: string, deps: OpenPositionDeps): Promise<OpenPositionOutcome> {
  const updated = await deps.positions.markActive(position.id, positionTokenId, new Date());
  if (updated) return { outcome: 'ACTIVE', position: updated };
  const current = await deps.positions.findById(position.id);
  if (current?.status === 'ACTIVE' && current.positionTokenId === positionTokenId) return { outcome: 'ACTIVE', position: current };
  return { outcome: 'PENDING', reason: `mint verified but the position is no longer OPENING (now ${current?.status ?? 'missing'}) -- not moved backwards` };
}

/** Stale-writer fix: `markFailed` is conditional on OPENING -- a worker whose failure is already superseded (another worker made it ACTIVE, or H3 expired it) changes nothing. */
async function fail(position: PositionRecord, reason: string, deps: OpenPositionDeps): Promise<OpenPositionOutcome> {
  const failed = await deps.positions.markFailed(position.id);
  if (failed) return { outcome: 'FAILED', reason };
  const current = await deps.positions.findById(position.id);
  if (current?.status === 'FAILED') return { outcome: 'FAILED', reason };
  return { outcome: 'PENDING', reason: `definitive failure (${reason}) but the position is no longer OPENING (now ${current?.status ?? 'missing'}) -- not overwritten` };
}
