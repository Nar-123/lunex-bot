import { v3TickMathUtils } from '../blockchain/uniswapSdk';
import { config } from '../config';
import type { PoolPriceState } from '../monitoring/types';

/**
 * Safety Exit (spec section 8) -- deliberately given CONCRETE, testable
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
  return now.getTime() - metricsFailureSince.getTime() >= config.rules.exits.SAFETY_EXIT.MAX_METRICS_FAILURE_MS;
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
