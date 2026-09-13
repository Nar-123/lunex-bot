import { v3TickMathUtils } from '../blockchain/uniswapSdk';
import { config } from '../config';
import type { PoolPriceState } from '../monitoring/types';

/**
 * INFRASTRUCTURE Safety Exit -- renamed in Tier 3 (the `SAFETY_EXIT`
 * trigger name now belongs to Meridian's drawdown-recovery rule in
 * `resolveExitDecision.ts`; this module is unchanged in behaviour and
 * still produces the `INFRA_SAFETY_EXIT` reason). It is a data-integrity
 * guard, NOT a trading rule: it fires when the bot cannot trust what it is
 * reading, not when the market does something.
 *
 * Deliberately given CONCRETE, testable
 * conditions rather than left as a category that never actually fires
 * (flagged explicitly in review before this module started: "jangan
 * biarkan jadi kategori kosong"). Two conditions, both computed here
 * (independent of `resolveExitDecision.ts`, which just takes the resulting
 * boolean -- keeping the priority engine itself free of I/O/read-failure
 * concerns):
 *
 * (a) This position's live metrics have failed to read successfully,
 *     CONTINUOUSLY, for longer than `EXITS.SAFETY_EXIT.MAX_METRICS_FAILURE_MS`.
 *     `metricsFailureSince` is persisted (`ExitState`) precisely so a bot
 *     restart mid-outage doesn't reset the streak to zero.
 * (b) A pool price read that's structurally impossible to trust:
 *     `sqrtPriceX96 <= 0` (a v4 pool's sqrtPriceX96 is always a positive
 *     Q64.96 value once initialized -- zero/negative means either an
 *     uninitialized pool or a corrupted read, neither safe to compute PNL
 *     against) or `tickCurrent` outside Uniswap's own valid tick range
 *     (`TickMath.MIN_TICK`/`MAX_TICK`, re-exposed via
 *     `blockchain/uniswapSdk.ts`'s `v3TickMathUtils` -- the same tick-math
 *     utilities `strategies/` already reuses from v3-sdk, v4 has no native
 *     alternative). Triggers immediately, no timer, since this data can't
 *     be used for anything meaningful regardless of how long it persists.
 */

export function evaluateMetricsFailureSafetyExit(metricsFailureSince: Date | null, now: Date): boolean {
  if (metricsFailureSince === null) return false;
  return now.getTime() - metricsFailureSince.getTime() >= config.rules.exits.INFRA_SAFETY_EXIT.MAX_METRICS_FAILURE_MS;
}

export function isPoolPriceStructurallyInvalid(poolPrice: PoolPriceState): boolean {
  if (poolPrice.sqrtPriceX96 <= 0n) return true;
  if (poolPrice.tickCurrent < v3TickMathUtils.TickMath.MIN_TICK) return true;
  if (poolPrice.tickCurrent > v3TickMathUtils.TickMath.MAX_TICK) return true;
  return false;
}

/**
 * Combines both conditions into the single boolean `resolveExitDecision`
 * takes as `safetyExitTriggered`. `metricsFailureSince` is the value ALREADY
 * persisted before this tick (the orchestrator is responsible for updating
 * and persisting it based on whether this tick's metrics read succeeded --
 * see `runExitCycle.ts`); `poolPrice` is only provided when a read actually
 * succeeded (a failed read is condition (a)'s concern, not (b)'s).
 */
export function evaluateSafetyExit(input: { metricsFailureSince: Date | null; now: Date; poolPrice: PoolPriceState | null }): boolean {
  if (evaluateMetricsFailureSafetyExit(input.metricsFailureSince, input.now)) return true;
  if (input.poolPrice !== null && isPoolPriceStructurallyInvalid(input.poolPrice)) return true;
  return false;
}

/**
 * A repeatedly-failing exit swap is invisible to `execution/`'s own
 * stuck-attempt detection (`stuckAttempt.ts`'s `isStuckAttempt`, keyed off
 * ONE `TransactionAttempt` row's `attemptCount`/age) -- every retry
 * deliberately gets a FRESH idempotencyKey (see `executeExit.ts`'s doc
 * comment for why), so no single row's `attemptCount` ever climbs high
 * enough to flag it. `ExitState.swapAttemptCount` tracks this
 * independently, position-scoped, across all those distinct rows.
 *
 * Deliberately NOT fed back into `resolveExitDecision` -- a stuck swap
 * doesn't mean "stop retrying" (the capital is real, at-risk TOKEN sitting
 * unswapped; giving up would just leave it stuck worse), it means "someone
 * should be able to see this is stuck." Purely a queryable signal (see
 * `ExitStateRepository.findStuckSwapRetries`), not wired to any live
 * alerting yet (Module 9).
 */
export function isSwapRetryStuck(swapAttemptCount: number, threshold: number = config.rules.exits.SWAP_RETRY.STUCK_THRESHOLD): boolean {
  return swapAttemptCount >= threshold;
}

/**
 * H4 fix: a metrics-failure streak that has crossed
 * `MAX_METRICS_FAILURE_MS` is the signature of EITHER a genuine
 * position-specific anomaly (a broken pool, a bad on-chain read for THIS
 * position only) OR a shared RPC/provider outage affecting every position
 * at once -- and every ACTIVE position reads through the SAME transport
 * (`monitoring/positionStateReader.ts`/`poolPrice`), so an outage produces
 * IDENTICAL, PERFECTLY CORRELATED failures across the whole portfolio in
 * the same tick. `resolveExitDecision`'s SAFETY_EXIT branch has no confirm
 * timer and closes immediately -- without this check, a single shared
 * outage lasting past the threshold would trigger a synchronized,
 * simultaneous SAFETY_EXIT for every ACTIVE position at once, a full
 * portfolio liquidation caused by nothing more than the RPC provider
 * having a bad few minutes.
 *
 * `runExitCycle.ts` computes `failingCount`/`totalActiveCount` by reading
 * metrics for every ACTIVE position FIRST, before deciding for any of
 * them (see that file). When every single one is failing at once (and
 * there's more than one to compare against -- with only one active
 * position there is no peer to correlate against, so the existing
 * behavior is preserved exactly), this is treated as a global outage: the
 * metrics-failure SAFETY_EXIT trigger is suppressed for this tick.
 *
 * Critically, this does NOT reset or weaken anything: `metricsFailureSince`
 * keeps counting, still persisted exactly as before. If the outage clears
 * for every position except one, that one position is no longer
 * correlated with its peers and correctly fires SAFETY_EXIT on the very
 * next tick -- a genuinely isolated, still-failing position is never
 * shielded by this check, only a portfolio-wide, all-failing tick is.
 *
 * The OTHER Safety Exit condition (`isPoolPriceStructurallyInvalid`, a
 * successfully-read-but-corrupted/impossible price) is deliberately NOT
 * subject to this correlation check -- it is a data-shape fact about one
 * successful read, not an outage symptom, and stays exactly as
 * immediate/unconditional as before.
 */
export function isMetricsFailureOutageCorrelated(failingCount: number, totalActiveCount: number): boolean {
  return totalActiveCount > 1 && failingCount === totalActiveCount;
}
