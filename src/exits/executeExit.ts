import type { Address } from 'viem';
import { config } from '../config';
import { readErc20Allowance, readErc20Balance } from '../blockchain/erc20';
import { getExecutorAddress } from '../blockchain/walletClient';
import { executeCriticalTransaction } from '../execution/executeCriticalTransaction';
import type { ExecutionResult, TransactionAttemptRepository, TxSafetyDeps } from '../execution/types';
import type { PositionRecord, PositionRepository } from '../positions/types';
import type { LivePositionStateProvider, PoolPriceProvider } from '../monitoring/types';
import type { SwapExecutor, SwapQuote } from '../swap/types';
import type { ExitStateRepository } from './types';
import { buildRemoveLiquidityDeps as realBuildRemoveLiquidityDeps, type RemoveLiquidityVerifyData } from './removeLiquidityTx';
import { buildSwapDeps as realBuildSwapDeps, defaultLogImpact, shouldBlockForPriceImpact, type SwapVerifyData } from './swapTx';
import { buildApproveDeps as realBuildApproveDeps, needsApproval, type ApproveVerifyData } from './approveTx';

/**
 * TIER 3 — maps a definitive-failure count to a slippage tier, clamping at
 * the last one. `EXITS.SLIPPAGE_TIERS_BPS` is `[100, 200, 300]` (Meridian's
 * `executor.rs`: attempt 1 => 100, 2 => 200, _ => 300).
 *
 * Exported for direct unit testing: the "never jump 100 -> 300" guarantee
 * is a property of THIS function plus the fact that only definitive
 * failures increment the counter, and both halves deserve to be pinned
 * down explicitly rather than inferred from an integration test.
 */
export function exitSlippageBpsForAttempt(swapAttemptCount: number): number {
  const tiers = config.rules.exits.SLIPPAGE_TIERS_BPS;
  const index = Math.min(Math.max(0, Math.floor(swapAttemptCount)), tiers.length - 1);
  return tiers[index] ?? tiers[tiers.length - 1] ?? 0;
}

export type ExitExecutionOutcome =
  | { outcome: 'CLOSED' }
  | { outcome: 'REVERTED_TO_ACTIVE'; reason: string }
  | { outcome: 'SWAP_FAILED_RETRY_PENDING'; reason: string }
  | { outcome: 'PENDING'; reason: string };

export interface ExecuteExitDeps {
  positions: PositionRepository;
  exitStates: ExitStateRepository;
  txAttempts: TransactionAttemptRepository;
  livePositionState: LivePositionStateProvider;
  poolPrice: PoolPriceProvider;
  swapExecutor: SwapExecutor;
  /**
   * Injectable, defaulting to the real on-chain implementations
   * (`removeLiquidityTx.ts`/`swapTx.ts`/`approveTx.ts`) -- exactly the same
   * reason `execution/executeCriticalTransaction.test.ts` tests against
   * fully fake `TxSafetyDeps` rather than real viem calls: this is what
   * makes the STATE MACHINE in this file (the failure branches, the
   * idempotency-key derivation) testable in complete isolation from any
   * real RPC/API call. Tests inject a fake here to control exactly how
   * each leg "fails" without needing a live chain.
   */
  buildRemoveLiquidityDeps?: (position: PositionRecord, live: LivePositionStateProvider, pool: PoolPriceProvider) => TxSafetyDeps<RemoveLiquidityVerifyData>;
  buildSwapDeps?: (
    positionId: string,
    tokenAddress: PositionRecord['tokenAddress'],
    /** `null` = resume-only deps for an attempt that already holds a signed payload -- see `swapTx.ts`. */
    quote: SwapQuote | null,
    swap: SwapExecutor,
    exitStates: ExitStateRepository,
  ) => TxSafetyDeps<SwapVerifyData>;
  buildApproveDeps?: (tokenAddress: Address, spender: Address, amountInRaw: bigint) => TxSafetyDeps<ApproveVerifyData>;
  /** Injectable for tests -- defaults to the real on-chain ERC20 reads. */
  readTokenBalance?: (tokenAddress: Address, wallet: Address) => Promise<bigint>;
  readAllowance?: (tokenAddress: Address, owner: Address, spender: Address) => Promise<bigint>;
  walletAddress?: Address;
  /** TIER 3: `priceImpactPct` is nullable -- a provider that omits the field is reported as UNAVAILABLE rather than logged as 0.000%. */
  logImpact?: (positionId: string, priceImpactPct: number | null) => void;
  /**
   * C4 defense-in-depth: invoked ONLY when `finalizeClose` finds a
   * position with no `pendingCloseReason` (a legacy/orphaned row --
   * should be structurally impossible after the C4 write-order fix in
   * `runExitCycle.ts`, but see that fix's doc comment for why this
   * fallback exists anyway). Deliberately a plain callback rather than
   * importing `composition/logger.ts`'s `Logger` type directly -- `exits/`
   * doesn't otherwise depend on `composition/`, and this signature is
   * structurally identical to `Logger.warn`, so the real logger can be
   * passed straight through by composition/exitCycle.ts. Defaults to
   * `console.warn` so a missing wiring is still loud, never silent.
   */
  warnLog?: (event: string, data?: Record<string, unknown>) => void;
}

/**
 * The exit flow's orchestrator, and the failure-state-machine this module
 * was reviewed most strictly on before any code was written.
 *
 * ## Why multiple legs, multiple idempotency keys, different failure responses
 *
 * The exit flow is up to THREE separate `executeCriticalTransaction`
 * calls, not one -- Tx A (remove-liquidity + collect fees, one on-chain
 * tx, see `removeLiquidityTx.ts`), an OPTIONAL Tx (a plain ERC20
 * `approve()`, see `approveTx.ts` -- only when the swap quote's
 * `allowanceTarget` isn't already sufficiently approved; see "Permit2
 * opt-out" below), then Tx B (TOKEN->USDG swap, see `swapTx.ts`).
 * `executeCriticalTransaction` caches a `FAILED` `TransactionAttempt` and
 * returns it immediately, forever, for that same idempotencyKey -- BY
 * DESIGN (Module 6), so a definitive failure is never silently retried
 * under the same key. That single fact is why this function's failure
 * branches below look so different from each other, even though the
 * user's original proposal (mirroring the `markFailed`/Revision-7 pattern)
 * assumed one uniform "revert and retry with a fresh key" response would
 * cover every case:
 *
 * **Tx A (remove-liquidity) fails definitively, before ever reaching
 * VERIFIED**: the LP is still 100% intact -- nothing changed on-chain, so
 * "this position never started exiting" is the TRUE state. `markExitFailed`
 * reverts status CLOSING -> ACTIVE and clears `closeIdempotencyKey`, so the
 * NEXT exit attempt (next tick, trigger re-evaluated completely fresh)
 * calls `markClosing` again with a BRAND NEW key -- never resuming the
 * dead one. This is exactly the user's proposed fix, and it is correct
 * for this branch.
 *
 * **The approve leg, or Tx B (swap), fails definitively, AFTER Tx A
 * already reached VERIFIED**: the LP is genuinely gone -- liquidity is 0,
 * the wallet holds raw TOKEN, USDG hasn't arrived. Reverting to ACTIVE
 * here would be WRONG: there is no LP left to monitor or compute PNL
 * against, and capital would be misrepresented as "still an LP position"
 * when it is actually naked TOKEN exposure. The position correctly STAYS
 * CLOSING -- this is not a "stuck forever, no way out" state (the same
 * shape of bug `markFailed` fixed in Revision 7): `ExitState.swapAttemptCount`
 * is incremented (both the approve leg and the swap leg share this SAME
 * counter -- from a "did the post-remove-liquidity half of this exit
 * succeed" perspective they are one unit of work), and the NEXT retry
 * derives FRESH approve/swap keys from the bumped counter
 * (`${closeIdempotencyKey}:approve:${n}` / `:swap:${n}`) while the
 * remove-liquidity key stays untouched and stable, so Tx A's cached
 * `VERIFIED` result is found and short-circuited for free -- Tx A is NEVER
 * rebuilt, re-signed, or re-broadcast on a retry of this half.
 *
 * ## Permit2 opt-out, not EIP-712 signing
 *
 * The Trading API's default flow can require a Permit2 SIGNATURE (an
 * off-chain EIP-712 signature, not a transaction) instead of a plain
 * `approve()`. This project has no EIP-712 signing capability anywhere --
 * every other integration point signs and broadcasts real transactions
 * through this exact pipeline. Rather than half-implement signing as a
 * one-off special case, `swap/tradingApiClient.ts` explicitly requests
 * Permit2 be disabled, and `swap/tradingApiMapper.ts` independently
 * verifies the resulting quote's `permitData` is actually null --
 * throwing loudly (never silently falling back to guessing) if the API
 * still wants a permit despite the opt-out request. When the opt-out
 * holds, `quote.allowanceTarget` names an ordinary ERC20 spender, and the
 * approve leg above is a normal transaction like any other.
 *
 * `capitalSnapshotProvider.ts` needs NO change for any of these branches:
 * reverting to ACTIVE keeps the position in `NON_CLOSED_STATUSES` (still
 * correctly counted as deployed, still occupies a slot) exactly as
 * before; staying at CLOSING is already unconditionally included by
 * Revision 5's fix, regardless of which CLOSING sub-phase (LP-still-there
 * vs. LP-already-removed-approve-or-swap-pending) the position is
 * actually in -- the capital is genuinely still at risk either way
 * (arguably MORE at risk as naked TOKEN than as an LP position), so
 * counting it as deployed remains correct. See
 * `tests/exits/executeExit.test.ts` for the numeric proof, including the
 * counter-proof of what "stuck forever" would look like if the same key
 * were reused instead of a fresh one.
 */
/**
 * P1-3 fix: claims ownership of this position's CLOSING processing before
 * any transaction-executing work runs, using the EXACT SAME primitive
 * `positions/openPosition.ts`'s `executeOpen` uses for OPENING
 * (`PositionRepository.claimForResume`/`releaseResumeClaim`, P0-1
 * ownership-token hardened). Without this, `runExitCycle`'s DECIDE pass
 * (which calls `executeExit` immediately after `markClosing`) and the very
 * next 15-second tick's RESUME pass (which re-discovers the same still-
 * CLOSING row via `findAllClosing()`) could both call `executeExit` for the
 * same position concurrently if the first call's on-chain work (remove-
 * liquidity mining + swap) takes longer than one tick -- duplicating real
 * gas spend and racing on `ExitState`/`TransactionAttempt` writes. Losing
 * the claim is NOT a failure -- another caller already owns this position
 * right now; deferring to it (PENDING) is the safe outcome, exactly
 * mirroring `executeOpen`'s reasoning.
 */
export async function executeExit(position: PositionRecord, deps: ExecuteExitDeps): Promise<ExitExecutionOutcome> {
  const claimToken = await deps.positions.claimForResume(position.id, 'CLOSING', config.rules.execution.RESUME_CLAIM_FRESHNESS_MS);
  if (claimToken === null) {
    return { outcome: 'PENDING', reason: 'position is already claimed by a concurrent exit/resume attempt' };
  }
  try {
    return await executeExitClaimed(position, deps);
  } finally {
    await deps.positions.releaseResumeClaim(position.id, claimToken);
  }
}

async function executeExitClaimed(position: PositionRecord, deps: ExecuteExitDeps): Promise<ExitExecutionOutcome> {
  if (!position.closeIdempotencyKey) {
    throw new Error(`cannot execute exit for position ${position.id}: status is ${position.status} but closeIdempotencyKey is null`);
  }

  const buildRemoveLiquidityDeps = deps.buildRemoveLiquidityDeps ?? realBuildRemoveLiquidityDeps;
  const buildSwapDeps = deps.buildSwapDeps ?? realBuildSwapDeps;
  const buildApproveDeps = deps.buildApproveDeps ?? realBuildApproveDeps;
  const readTokenBalance = deps.readTokenBalance ?? readErc20Balance;
  const readAllowance = deps.readAllowance ?? readErc20Allowance;
  const wallet = deps.walletAddress ?? getExecutorAddress();
  const logImpact = deps.logImpact ?? defaultLogImpact;

  const removeKey = `${position.closeIdempotencyKey}:removeLiquidity`;
  const removeDeps = buildRemoveLiquidityDeps(position, deps.livePositionState, deps.poolPrice);
  const removeResult = await executeCriticalTransaction(removeKey, 'exit:removeLiquidity', removeDeps, deps.txAttempts);  if (!removeResult.ok) {
    if (!removeResult.resumable) {
      // Definitive, and Tx A never reached VERIFIED -- LP fully intact.
      await deps.positions.markExitFailed(position.id);
      return { outcome: 'REVERTED_TO_ACTIVE', reason: removeResult.reason };
    }
    // Ambiguous (broadcast uncertain, etc.) -- retry the SAME key next tick, executeCriticalTransaction resumes from the last checkpoint.
    return { outcome: 'PENDING', reason: removeResult.reason };
  }

  // From here on, the LP is gone -- a definitive failure in EITHER the
  // approve leg or the swap leg shares the SAME "stay CLOSING, bump
  // swapAttemptCount, retry with a fresh key" response.
  const exitState = await deps.exitStates.getOrCreate(position.id);

  // C3 fix: check whether THIS attempt's swap leg already reached VERIFIED
  // BEFORE touching the live TOKEN balance at all. A successful swap
  // leaves the TOKEN balance at (or near) zero -- the EXPECTED outcome of
  // success, not evidence that "remove-liquidity succeeded but nothing
  // happened yet." Unconditionally re-deriving `amountInRaw` here (the
  // historical bug) read that expected post-swap zero balance as an
  // invariant violation on every resume, throwing forever even though the
  // exit had already fully succeeded on-chain -- permanently stuck at
  // CLOSING with no cooldown ever recorded and a slot never freed.
  const swapKey = `${position.closeIdempotencyKey}:swap:${exitState.swapAttemptCount}`;
  const existingSwapAttempt = await deps.txAttempts.find(swapKey);
  if (existingSwapAttempt?.status === 'VERIFIED') {
    return finalizeClose(position, exitState, deps, removeKey, swapKey);
  }

  // P1 fix: this attempt already SIGNED a swap (SIGNED/SENT/CONFIRMED -- a
  // txHash exists), so the swap may already be on-chain: broadcast
  // uncertain, receipt wait interrupted, or confirmed with verification
  // incomplete because the proceeds read failed. Resume THAT exact payload
  // under the same key. Re-deriving the amount from the live TOKEN balance
  // (already ~0 once the swap filled -- the same trap C3 fixed for VERIFIED),
  // re-quoting, or re-approving here would throw forever or send a second
  // swap. Resume-only deps carry no quote, so the pipeline can only re-run
  // the steps this attempt has not completed yet.
  if (existingSwapAttempt && existingSwapAttempt.status !== 'FAILED' && existingSwapAttempt.txHash !== null) {
    const resumeSwapDeps = buildSwapDeps(position.id, position.tokenAddress, null, deps.swapExecutor, deps.exitStates);
    const resumedSwap = await executeCriticalTransaction(swapKey, 'exit:swap', resumeSwapDeps, deps.txAttempts);
    return settleSwapLeg(resumedSwap, position, exitState, deps, removeKey, swapKey);
  }

  const amountInRaw = await readTokenBalance(position.tokenAddress, wallet);
  if (amountInRaw <= 0n) {
    throw new Error(`position ${position.id}: remove-liquidity is VERIFIED but TOKEN balance reads 0 -- invariant violated`);
  }
  // TIER 3 — slippage ladder. The tier is `swapAttemptCount`, which Module
  // 8 increments ONLY on a DEFINITIVE failure, so:
  //  - attempt 1 always asks for the tight 100 bps;
  //  - an AMBIGUOUS attempt (broadcast uncertain, process died mid-flight)
  //    does NOT advance the tier -- the resumed attempt re-quotes at the
  //    SAME width under the SAME idempotency key, rather than widening on
  //    the strength of a failure nobody has actually established;
  //  - only a proven failure earns 200, then 300 bps;
  //  - past the last tier the index CLAMPS (stays 300) instead of
  //    running off the end, and SWAP_RETRY.STUCK_THRESHOLD surfaces it.
  // No new persisted state: the tier IS the attempt counter.
  const slippageBps = exitSlippageBpsForAttempt(exitState.swapAttemptCount);

  const quote = await deps.swapExecutor.getQuote(position.tokenAddress, amountInRaw, slippageBps);
  logImpact(position.id, quote.priceImpactPct);
  if (shouldBlockForPriceImpact(quote.priceImpactPct, config.rules.exits.IMPACT_CHECK_ENABLED, config.rules.priceImpact.MAX_EXIT_IMPACT_PCT)) {
    // Not a definitive failure -- conditions right now are bad, not
    // permanently invalid; no TransactionAttempt is even created for this
    // tick, and `swapAttemptCount` is NOT incremented (so this deferral
    // can never widen the slippage tier -- price impact and slippage are
    // separate protections and a bad quote is never "rescued" by asking
    // for a looser fill). Retried next tick once impact may have improved.
    const measured =
      quote.priceImpactPct === null
        ? 'could not be verified (provider did not report priceImpact)'
        : `${(quote.priceImpactPct * 100).toFixed(2)}% exceeds max ${(config.rules.priceImpact.MAX_EXIT_IMPACT_PCT * 100).toFixed(2)}%`;
    return {
      outcome: 'PENDING',
      reason: `exit swap price impact ${measured} -- IMPACT_CHECK_ENABLED is on, deferring this swap`,
    };
  }

  // C5 fix: the quote response has no `allowanceTarget` field on the real
  // API -- the real mechanism is this separate check, which also returns
  // the actual spender (decoded from the API's own approval calldata, see
  // tradingApiMapper.ts's parseApprovalResponse). Our own on-chain
  // allowance is still independently re-checked below before deciding to
  // actually broadcast anything, so a prior attempt's already-sufficient
  // approval is never redundantly re-approved.
  const approvalCheck = await deps.swapExecutor.checkApproval(position.tokenAddress, amountInRaw);
  if (approvalCheck.needsApproval && approvalCheck.spender) {
    const spender = approvalCheck.spender;
    const currentAllowance = await readAllowance(position.tokenAddress, wallet, spender);
    if (needsApproval(currentAllowance, amountInRaw)) {
      const approveKey = `${position.closeIdempotencyKey}:approve:${exitState.swapAttemptCount}`;
      const approveDeps = buildApproveDeps(position.tokenAddress, spender, amountInRaw);
      const approveResult = await executeCriticalTransaction(approveKey, 'exit:approve', approveDeps, deps.txAttempts);

      if (!approveResult.ok) {
        if (!approveResult.resumable) {
          await deps.exitStates.incrementSwapAttempt(position.id);
          return { outcome: 'SWAP_FAILED_RETRY_PENDING', reason: approveResult.reason };
        }
        return { outcome: 'PENDING', reason: approveResult.reason };
      }
    }
  }

  const swapDeps = buildSwapDeps(position.id, position.tokenAddress, quote, deps.swapExecutor, deps.exitStates);
  const swapResult = await executeCriticalTransaction(swapKey, 'exit:swap', swapDeps, deps.txAttempts);
  return settleSwapLeg(swapResult, position, exitState, deps, removeKey, swapKey);
}

/** Shared outcome mapping for a fresh swap attempt and a resumed signed one. */
async function settleSwapLeg(
  swapResult: ExecutionResult<SwapVerifyData>,
  position: PositionRecord,
  exitState: { pendingCloseReason: string | null },
  deps: ExecuteExitDeps,
  removeKey: string,
  swapKey: string,
): Promise<ExitExecutionOutcome> {
  if (!swapResult.ok) {
    if (!swapResult.resumable) {
      // Definitive, but Tx A is ALREADY VERIFIED -- LP is gone, cannot
      // revert to ACTIVE. Bump the counter so the next retry gets fresh
      // approve/swap keys; position stays CLOSING (correct -- see doc comment above).
      await deps.exitStates.incrementSwapAttempt(position.id);
      return { outcome: 'SWAP_FAILED_RETRY_PENDING', reason: swapResult.reason };
    }
    // Ambiguous, including "confirmed but proceeds not yet measured" --
    // same key next tick, which resumes via the signed-attempt path above.
    return { outcome: 'PENDING', reason: swapResult.reason };
  }

  return finalizeClose(position, exitState, deps, removeKey, swapKey);
}

/**
 * VALIDATION PHASE: sums the on-chain-measured USDG proceeds of the two
 * exit legs from their VERIFIED attempts' persisted `verifyData` (the same
 * crash-safe mechanism that reconstructs any other post-verification
 * payload). Returns null -- "not measured", never a fabricated number --
 * when either leg's verifyData predates the proceeds fields (a legacy
 * attempt verified by an older build, or a legacy row) or cannot be read:
 * half a measurement is not a measurement, and under-counting realized
 * proceeds would silently overstate the position's loss.
 *
 * P1-14: this sum is principal PLUS whatever LP fees the remove-liquidity
 * leg's `TAKE_PAIR` settlement happened to pay out together with it --
 * NOT the same quantity as the principal-only `pnlPct` that decided this
 * position should close (see `resolveExitDecision.ts`'s "P1-14" doc
 * comment section for the full explanation and why this divergence is
 * intentional, confirmed by explicit operator decision, and never to be
 * reconciled).
 *
 * P1-13: exported so `exits/realizedPnlBackfill.ts` can reuse this EXACT
 * computation for already-CLOSED positions whose `realizedUsdgRaw` is
 * still null (a legacy row, or a close that happened before the proceeds
 * fields existed) -- one single source of truth for "how realized
 * proceeds are computed," never a second, potentially-divergent
 * implementation.
 */
export function computeRealizedProceeds(
  deps: Pick<ExecuteExitDeps, 'txAttempts'>,
  removeKey: string,
  swapKey: string,
): Promise<bigint | null> {
  return (async () => {
    try {
      const [removeAttempt, swapAttempt] = await Promise.all([deps.txAttempts.find(removeKey), deps.txAttempts.find(swapKey)]);
      const removeProceeds = removeAttempt?.status === 'VERIFIED' ? removeAttempt.verifyData : null;
      const swapProceeds = swapAttempt?.status === 'VERIFIED' ? swapAttempt.verifyData : null;
      const removeUsdg =
        typeof removeProceeds === 'object' && removeProceeds !== null && 'usdgProceedsRaw' in removeProceeds
          ? (removeProceeds as RemoveLiquidityVerifyData).usdgProceedsRaw
          : null;
      const swapUsdg =
        typeof swapProceeds === 'object' && swapProceeds !== null && 'usdgProceedsRaw' in swapProceeds
          ? (swapProceeds as SwapVerifyData).usdgProceedsRaw
          : null;
      if (removeUsdg === null || swapUsdg === null) return null;
      return removeUsdg + swapUsdg;
    } catch {
      return null; // honest "not measured" -- a close is never blocked by its own accounting read
    }
  })();
}

/**
 * The final step of a successful exit -- shared by the normal swap-just-
 * completed path and the C3 resume path (swap already found VERIFIED on
 * entry, before any live balance read).
 */
async function finalizeClose(
  position: PositionRecord,
  exitState: { pendingCloseReason: string | null },
  deps: Pick<ExecuteExitDeps, 'positions' | 'warnLog' | 'txAttempts'>,
  removeKey: string,
  swapKey: string,
): Promise<ExitExecutionOutcome> {
  // C4 defense-in-depth: `runExitCycle.ts` now writes `pendingCloseReason`
  // BEFORE `markClosing` (reordered specifically so a crash between the
  // two writes can never produce this state), so this should be
  // unreachable in practice. It is NOT treated as a fatal invariant
  // violation, though: the on-chain exit has ALREADY FULLY SUCCEEDED by
  // the time this runs (remove-liquidity AND swap both VERIFIED) --
  // throwing here would permanently strand a position that has no real
  // problem left to resolve, purely because of a missing metadata field.
  // A loud warning plus an honest 'UNKNOWN' close reason is safe: nothing
  // downstream treats `closeReason` as anything but a display/audit label.
  const closeReason = exitState.pendingCloseReason ?? 'UNKNOWN';
  if (!exitState.pendingCloseReason) {
    const warnLog = deps.warnLog ?? ((event, data) => { console.warn(event, data); });
    warnLog('exit_missing_pending_close_reason', { positionId: position.id });
  }
  // Same "already fully succeeded on-chain" reasoning for the realized
  // proceeds: a null here (unmeasurable) still closes the position -- the
  // number is reported as unavailable for THIS row, never blocks the
  // state transition.
  const realizedUsdgRaw = await computeRealizedProceeds(deps, removeKey, swapKey);
  await deps.positions.markClosed(position.id, new Date(), closeReason, realizedUsdgRaw);
  return { outcome: 'CLOSED' };
}
