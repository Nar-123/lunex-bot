import { scheduleInterval } from '../discovery/scheduler';
import { config } from '../config';
import type { PositionRepository } from '../positions/types';
import { computePositionMetrics } from './computePositionMetrics';
import type { LivePositionStateProvider, PoolPriceProvider, PositionMetricsResult } from './types';

export interface MonitoringDeps {
  positions: PositionRepository;
  livePositionState: LivePositionStateProvider;
  poolPrice: PoolPriceProvider;
  onMetrics: (results: PositionMetricsResult[]) => void | Promise<void>;
}

/**
 * One monitoring pass: for every confirmed ACTIVE position, read its live
 * on-chain state + the pool's current price, compute metrics, and report
 * them via `onMetrics`. A single position's read/compute failing never
 * aborts the whole cycle -- every other active position still gets
 * monitored, matching the spec's "runs independently" framing at the
 * per-position level too.
 */
export async function runMonitoringCycle(deps: MonitoringDeps): Promise<PositionMetricsResult[]> {
  const activePositions = await deps.positions.findAllActive();
  const results: PositionMetricsResult[] = [];

  for (const position of activePositions) {
    if (!position.positionTokenId) {
      results.push({
        ok: false,
        positionId: position.id,
        reason: 'position is ACTIVE but has no positionTokenId recorded (data inconsistency)',
      });
      continue;
    }
    try {
      const [live, poolPrice] = await Promise.all([
        deps.livePositionState.getLiveState(position),
        deps.poolPrice.getPriceState(position.pool),
      ]);
      results.push(computePositionMetrics(position, live, poolPrice));
    } catch (err) {
      results.push({
        ok: false,
        positionId: position.id,
        reason: `failed to read live state: ${err instanceof Error ? err.message : String(err)}`,
      });
    }
  }

  await deps.onMetrics(results);
  return results;
}

/**
 * Starts the 15-second monitoring loop (spec section 7), independent of
 * the 30-minute discovery/screening cycle -- reuses `discovery/scheduler.ts`'s
 * `scheduleInterval` (same re-entrancy guard: a slow cycle never overlaps
 * the next tick) rather than a second interval-runner implementation.
 * Returns a `stop()` function.
 */
export function startMonitoring(deps: MonitoringDeps): () => void {
  return scheduleInterval(
    async () => {
      await runMonitoringCycle(deps);
    },
    {
      intervalMs: config.rules.monitoring.INTERVAL_MS,
      runImmediately: true,
      onError: (err) => {
        // Temporary: replaced by the shared logger once a logging module
        // exists (same caveat as discovery/gmgnCliClient.ts's onTokenInfoFailure).
        console.error('[monitoring] cycle failed:', err instanceof Error ? err.message : err);
      },
    },
  );
}
