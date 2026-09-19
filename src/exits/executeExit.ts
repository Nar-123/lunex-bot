import type { Address } from 'viem';
import { config } from '../config';
import { readErc20Allowance, readErc20Balance, readErc20TransfersTo } from '../blockchain/erc20';
import { getExecutorAddress } from '../blockchain/walletClient';
import { executeCriticalTransaction } from '../execution/executeCriticalTransaction';
import type { ExecutionResult, TransactionAttemptRepository, TxSafetyDeps } from '../execution/types';
import type { PositionRecord, PositionRepository } from '../positions/types';
import type { LivePositionStateProvider, PoolPriceProvider } from '../monitoring/types';
import type { SwapExecutor, SwapQuote } from '../swap/types';
import type { ExitStateRepository, SwapLegBlockReason } from './types';
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

/**
 * H1 fix: decides whether a remove-liquidity whose OWN receipt paid the
 * wallet exactly 0 TOKEN is a genuine, complete USDG-only close.
 *
 * Why 0 TOKEN is legitimate: every entry is a ONE-SIDED USDG position
 * deliberately placed out of range (`computeLpRange.ts`, P0-4's mint
 * guard). If price never trades into the range, the liquidity is still
 * 100% USDG when OOR_TIMEOUT (or any other trigger) closes it, and the
 * burn pays out USDG only -- 0 TOKEN principal and 0 TOKEN fees (fees only
 * accrue while in range).
 *
 * What is NOT USDG-only: a position that traded INTO its range and back
 * out on the USDG side. Its principal converts back to USDG along the
 * curve, but while it was in range it earned fees in whichever token
 * traders paid in -- typically TOKEN on the way in -- and the burn pays
 * those accrued TOKEN fees out together with the USDG. Its receipt
 * therefore normally shows `tokenProceedsRaw > 0` and it takes the regular
 * TOKEN swap path, never this one. (It only lands here in the unusual case
 * where every in-range fee happened to be paid in USDG.)
 *
 * Why the USDG amount is ALSO checked: with 0 TOKEN out, the liquidity sat
 * entirely on the USDG side, where the burn of liquidity L returns
 * amount(L) rounded DOWN. The mint sized L from `entryUsdgRaw` itself
 * (`Position.fromAmount0`/`fromAmount1` in `positions/mintTx.ts`), so
 * amount(L) is the deposited USDG minus wei-level rounding, and any
 * USDG-denominated fees only ADD to it. A genuine USDG-only burn therefore
 * returns >= `entryUsdgRaw` minus a few wei. A USDG-only receipt that
 * returns materially LESS (or nothing) is inconsistent with a one-sided
 * close -- TOKEN that should exist went somewhere else, or the
 * position/receipt is not what the DB believes -- so it is an ANOMALY,
 * never auto-closed.
 *
 * The 99% floor is an APPLICATION-LEVEL classification bound, not an
 * on-chain guarantee. It is NOT what the remove-liquidity calldata
 * enforces: the SDK's `burnAmountsWithSlippage` derives the calldata's
 * `amount0Min`/`amount1Min` from the position's amounts at a price moved
 * by +/- `REMOVE_LIQUIDITY_SLIPPAGE_BPS`, which for a fully out-of-range
 * position is 100% of the amount when the price is far from the range but
 * can be FAR lower than 99% when the price sits near the range edge. The
 * floor only reuses that constant's NUMBER (1%) as a margin. It is
 * conservative for the USDG-only case because the expected shortfall
 * (rounding) is many orders of magnitude smaller than 1% of any real
 * entry, so no genuine USDG-only close is ever rejected by it. It is a
 * SECONDARY sanity check: the primary proof is the receipt's
 * `tokenProceedsRaw === 0n` (only zero-hook pools are ever selected, and
 * TAKE_PAIR pays the wallet itself, so the burn's TOKEN cannot be routed
 * elsewhere). The floor catches gross inconsistencies (nothing or far too
 * little USDG came back); it cannot by itself detect a SMALL missing TOKEN
 * amount, and does not claim to.
 *
 * Pure and exported for direct unit testing.
 */
export function classifyUsdgOnlyRemoval(
  entryUsdgRaw: bigint,
  usdgProceedsRaw: bigint,
): { ok: true } | { ok: false; reason: string } {
  if (usdgProceedsRaw <= 0n) {
    return { ok: false, reason: `remove-liquidity paid 0 TOKEN and ${usdgProceedsRaw} USDG -- a one-sided USDG close must return USDG; manual review required` };
  }
  const minUsdg = (entryUsdgRaw * BigInt(10_000 - config.rules.exits.REMOVE_LIQUIDITY_SLIPPAGE_BPS)) / 10_000n;
  if (usdgProceedsRaw < minUsdg) {
    return {
      ok: false,
      reason: `remove-liquidity paid 0 TOKEN but only ${usdgProceedsRaw} USDG (< ${minUsdg}, the one-sided floor for entry ${entryUsdgRaw}) -- inconsistent with a USDG-only close; manual review required`,
    };
  }
  return { ok: true };
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
    /** Stale-writer fix: the swap attempt number these deps belong to -- see `swapTx.ts`'s `BuildSwapDepsOptions.swapAttemptCount`. */
    options: { swapAttemptCount: number },
  ) => TxSafetyDeps<SwapVerifyData>;
  buildApproveDeps?: (tokenAddress: Address, spender: Address, amountInRaw: bigint) => TxSafetyDeps<ApproveVerifyData>;
  /** Injectable for tests -- defaults to the real on-chain ERC20 reads. */
  readTokenBalance?: (tokenAddress: Address, wallet: Address) => Promise<bigint>;
  readAllowance?: (tokenAddress: Address, owner: Address, spender: Address) => Promise<bigint>;
  /**
   * H1: injectable for tests -- defaults to the real receipt-scoped ERC20
   * `Transfer(... -> wallet)` decoder (`blockchain/erc20.ts`). Used ONLY to
   * recover a legacy remove-liquidity attempt (verified by an older build,
   * so its verifyData has no `tokenProceedsRaw`) whose wallet TOKEN balance
   * reads 0: the attempt's own confirmed receipt is re-read to PROVE the
   * burn paid 0 TOKEN before it is treated as a USDG-only close.
   */
  readTransfersTo?: (txHash: `0x${string}`, tokenAddress: Address, wallet: Address) => Promise<bigint>;
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
      // Conditional on THIS close attempt (stale-writer fix): a worker whose
      // close has already been superseded or finalized reverts nothing.
      const reverted = await deps.positions.markExitFailed(position.id, position.closeIdempotencyKey);
      if (!reverted) {
        return { outcome: 'PENDING', reason: 'position is no longer CLOSING under this close attempt (another worker moved it on) -- nothing reverted' };
      }
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
    const resumeSwapDeps = buildSwapDeps(position.id, position.tokenAddress, null, deps.swapExecutor, deps.exitStates, { swapAttemptCount: exitState.swapAttemptCount });
    const resumedSwap = await executeCriticalTransaction(swapKey, 'exit:swap', resumeSwapDeps, deps.txAttempts);
    return settleSwapLeg(resumedSwap, position, exitState, deps, removeKey, swapKey);
  }

  // H1 fix: "is there TOKEN to swap" is decided from the remove-liquidity
  // leg's OWN receipt (`tokenProceedsRaw`), not inferred from the live
  // wallet balance. The old code read the live balance and threw on 0 --
  // but a one-sided USDG position that never traded into its range burns
  // to USDG only, so 0 TOKEN is the NORMAL outcome of the strategy's most
  // common "never filled" close (OOR_TIMEOUT), and every such position was
  // stranded at CLOSING forever: slot and token never freed, its returned
  // USDG counted both in the wallet and as deployed. Three cases:
  //   - receipt says 0 TOKEN   -> USDG-only close, validated by
  //                               `classifyUsdgOnlyRemoval`, no swap;
  //   - receipt says > 0 TOKEN -> the existing swap flow, unchanged
  //                               (including the invariant throw below if
  //                               that TOKEN is somehow no longer in the
  //                               wallet -- still a genuine anomaly);
  //   - legacy attempt (no tokenProceedsRaw recorded) -> the old
  //                               live-balance behavior, EXCEPT that a 0
  //                               balance is now checked against the
  //                               attempt's own receipt instead of thrown.
  const removal = removeResult.data;
  let removalTokenProceedsRaw: bigint | undefined = removal.tokenProceedsRaw;
  let removalUsdgProceedsRaw: bigint | undefined = (removal as Partial<RemoveLiquidityVerifyData>).usdgProceedsRaw;
  let amountInRaw: bigint | null = null;
  if (removalTokenProceedsRaw === undefined) {
    amountInRaw = await readTokenBalance(position.tokenAddress, wallet);
    if (amountInRaw <= 0n) {
      const txHash = removeResult.attempt.txHash;
      if (!txHash) {
        return { outcome: 'PENDING', reason: `remove-liquidity is VERIFIED with no recorded TOKEN proceeds and no txHash to re-read them from -- manual review required` };
      }
      const readTransfersTo = deps.readTransfersTo ?? readErc20TransfersTo;
      try {
        removalTokenProceedsRaw = await readTransfersTo(txHash, position.tokenAddress, wallet);
        removalUsdgProceedsRaw ??= await readTransfersTo(txHash, config.quoteAsset.ADDRESS as Address, wallet);
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        return { outcome: 'PENDING', reason: `could not re-read the remove-liquidity receipt to prove its TOKEN proceeds: ${message}` };
      }
    }
  }

  if (removalTokenProceedsRaw === 0n) {
    const usdgProceedsRaw = removalUsdgProceedsRaw ?? 0n;
    const check = classifyUsdgOnlyRemoval(position.entryUsdgRaw, usdgProceedsRaw);
    if (!check.ok) {
      const warnLog = deps.warnLog ?? ((event, data) => { console.warn(event, data); });
      warnLog('exit_usdg_only_close_anomaly', { positionId: position.id, reason: check.reason });
      // Stays CLOSING (still counted as deployed -- conservative) and is
      // surfaced by reconciliation's CLOSING_ALREADY_REMOVED check.
      return { outcome: 'PENDING', reason: check.reason };
    }
    return finalizeClose(position, exitState, deps, removeKey, null, usdgProceedsRaw);
  }

  amountInRaw ??= await readTokenBalance(position.tokenAddress, wallet);
  if (amountInRaw <= 0n) {
    throw new Error(`position ${position.id}: remove-liquidity is VERIFIED and paid ${removalTokenProceedsRaw ?? 'unknown'} TOKEN, but TOKEN balance reads 0 -- invariant violated`);
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

  // TOKEN-leg unactionability (e.g. residual TOKEN fees too small for the
  // Trading API to route, "no route", or an unverifiable price impact):
  // deliberately NOT resolved by skipping the swap. There is no vetted,
  // safe way today to call an amount "negligible" -- no configured dust
  // value, no oracle beyond this pool's own manipulable spot price, no
  // ETH->USDG price to weigh against gas, opaque API error bodies, and no
  // Position field to record retained TOKEN -- so dropping the swap could
  // silently discard real value and under-report realized proceeds. The
  // TOKEN is instead RETAINED in the wallet, the position stays CLOSING
  // (its capital still counted as deployed -- conservative), no gas is
  // spent, `swapAttemptCount` is NOT bumped (nothing was attempted), and
  // the SAME attempt is retried next tick. What changed is only that this
  // is an explicit, structured, logged deferral (`exit_token_leg_unactionable`,
  // carrying the receipt-proven TOKEN amount) instead of an exception
  // surfacing through `runExitCycle`'s catch -- the outcome it produced
  // (PENDING, stays CLOSING) is unchanged. An operator-approved dust
  // policy would be required to go further; see the H1 follow-up report.
  const warnLog = deps.warnLog ?? ((event: string, data?: Record<string, unknown>) => { console.warn(event, data); });
  const tokenLegContext = {
    positionId: position.id,
    receiptTokenProceedsRaw: removalTokenProceedsRaw === undefined ? null : removalTokenProceedsRaw.toString(),
    walletTokenAmountRaw: amountInRaw.toString(),
    tokenDecimals: position.tokenDecimals,
  };
  // Unroutable TOKEN leg: the block is recorded DURABLY on ExitState (for
  // THIS swap attempt only) so it survives restarts and is operator-visible
  // (GET /positions/stuck, Telegram /stuck) -- classified
  // OPERATOR_ACTION_REQUIRED once it has lasted longer than the existing
  // stuck-surfacing policy (see exits/closingRecovery.ts). The position
  // still stays CLOSING and is still retried every tick; nothing is closed,
  // settled or valued. Logged only when a block STARTS or CHANGES reason --
  // not on every 15s retry.
  const noteBlocked = async (cause: SwapLegBlockReason, extra: Record<string, unknown>): Promise<void> => {
    let change: 'NEW' | 'UNCHANGED' | 'STALE' = 'NEW';
    try {
      change = await deps.exitStates.recordSwapLegBlocked(position.id, exitState.swapAttemptCount, cause, new Date());
    } catch {
      // Recording is observability only -- never turns a safe deferral into a failure.
    }
    if (change === 'NEW') warnLog('exit_token_leg_unactionable', { ...tokenLegContext, cause, ...extra });
  };
  let quote: SwapQuote;
  try {
    quote = await deps.swapExecutor.getQuote(position.tokenAddress, amountInRaw, slippageBps);
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    await noteBlocked('QUOTE_UNAVAILABLE', { error: message });
    return {
      outcome: 'PENDING',
      reason: `exit swap quote unavailable for ${amountInRaw} TOKEN (${message}) -- TOKEN retained in the wallet, position stays CLOSING, retried next tick`,
    };
  }
  logImpact(position.id, quote.priceImpactPct);
  if (shouldBlockForPriceImpact(quote.priceImpactPct, config.rules.exits.IMPACT_CHECK_ENABLED, config.rules.priceImpact.MAX_EXIT_IMPACT_PCT)) {
    await noteBlocked('PRICE_IMPACT_BLOCKED', { priceImpactPct: quote.priceImpactPct });
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
  // The swap can proceed now -- the TOKEN leg is no longer blocked.
  await deps.exitStates.clearSwapLegBlocked(position.id, exitState.swapAttemptCount);

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
          // From THIS attempt's count only: if another worker already
          // recorded this same failure, the counter is not bumped twice.
          await deps.exitStates.incrementSwapAttemptFrom(position.id, exitState.swapAttemptCount);
          return { outcome: 'SWAP_FAILED_RETRY_PENDING', reason: approveResult.reason };
        }
        return { outcome: 'PENDING', reason: approveResult.reason };
      }
    }
  }

  const swapDeps = buildSwapDeps(position.id, position.tokenAddress, quote, deps.swapExecutor, deps.exitStates, { swapAttemptCount: exitState.swapAttemptCount });
  const swapResult = await executeCriticalTransaction(swapKey, 'exit:swap', swapDeps, deps.txAttempts);
  return settleSwapLeg(swapResult, position, exitState, deps, removeKey, swapKey);
}

/** Shared outcome mapping for a fresh swap attempt and a resumed signed one. */
async function settleSwapLeg(
  swapResult: ExecutionResult<SwapVerifyData>,
  position: PositionRecord,
  exitState: { pendingCloseReason: string | null; swapAttemptCount: number },
  deps: ExecuteExitDeps,
  removeKey: string,
  swapKey: string,
): Promise<ExitExecutionOutcome> {
  if (!swapResult.ok) {
    if (!swapResult.resumable) {
      // Definitive, but Tx A is ALREADY VERIFIED -- LP is gone, cannot
      // revert to ACTIVE. Bump the counter so the next retry gets fresh
      // approve/swap keys; position stays CLOSING (correct -- see doc comment above).
      // From THIS attempt's count only (stale-writer fix): two workers that
      // both observe the same definitive failure advance the counter once,
      // never skipping a slippage tier.
      await deps.exitStates.incrementSwapAttemptFrom(position.id, exitState.swapAttemptCount);
      return { outcome: 'SWAP_FAILED_RETRY_PENDING', reason: swapResult.reason };
    }
    // Ambiguous, including "confirmed but proceeds not yet measured" --
    // same key next tick, which resumes via the signed-attempt path above.
    // Same-attempt swap race: a worker that lost ownership of this attempt
    // (its checkpoint write failed the version check, or its attempt number
    // is no longer current) stopped BEFORE building on it, signing or
    // broadcasting -- not a failure, no gas spent. Surfaced once per
    // occurrence, never on a quiet tick.
    if (/not at expected version|stale worker, not building/.test(swapResult.reason)) {
      const warnLog = deps.warnLog ?? ((event: string, data?: Record<string, unknown>) => { console.warn(event, data); });
      warnLog('exit_swap_attempt_ownership_lost', { positionId: position.id, swapKey, reason: swapResult.reason });
    }
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
      // H1: a remove-liquidity whose own receipt paid 0 TOKEN had nothing to
      // swap -- its USDG is the WHOLE realized amount; there is no swap leg
      // to wait for (or to add, so nothing can be counted twice).
      const removeTokenProceeds =
        typeof removeProceeds === 'object' && removeProceeds !== null && 'tokenProceedsRaw' in removeProceeds
          ? (removeProceeds as RemoveLiquidityVerifyData).tokenProceedsRaw
          : undefined;
      if (removeTokenProceeds === 0n) return removeUsdg;
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
 * completed path, the C3 resume path (swap already found VERIFIED on
 * entry, before any live balance read), and the H1 USDG-only path
 * (`swapKey === null`: no swap leg exists, and `usdgOnlyProceedsRaw` is the
 * remove-liquidity receipt's already-validated USDG amount -- the ENTIRE
 * realized proceeds, taken as-is, never summed with anything).
 */
async function finalizeClose(
  position: PositionRecord,
  exitState: { pendingCloseReason: string | null },
  deps: Pick<ExecuteExitDeps, 'positions' | 'warnLog' | 'txAttempts'>,
  removeKey: string,
  swapKey: string | null,
  usdgOnlyProceedsRaw?: bigint,
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
  // `markClosed` SETS the value (never increments), so a retried
  // finalization after a crash writes the same deterministic number again
  // -- there is no path that adds proceeds on top of a persisted value.
  const realizedUsdgRaw = swapKey === null ? (usdgOnlyProceedsRaw ?? null) : await computeRealizedProceeds(deps, removeKey, swapKey);
  // Conditional on still CLOSING under THIS close attempt (stale-writer
  // fix): a late duplicate finalization -- e.g. a worker that outlived its
  // claim lease -- writes nothing and reports PENDING instead of CLOSED, so
  // the close (and its cooldown) is recorded exactly once.
  const closed = await deps.positions.markClosed(position.id, new Date(), closeReason, realizedUsdgRaw, position.closeIdempotencyKey ?? undefined);
  if (!closed) {
    return { outcome: 'PENDING', reason: 'position was already finalized (or moved on) by another worker -- nothing written' };
  }
  return { outcome: 'CLOSED' };
}
