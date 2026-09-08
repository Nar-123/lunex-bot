import { runMonitoringCycle } from '../monitoring/monitorPositions';
import type { PositionMetricsResult } from '../monitoring/types';
import type { AppDeps } from './types';

/**
 * The first 15-second cycle: pure monitoring (Module 7's `runMonitoringCycle`
 * as-is, unmodified), with a summary logged for visibility -- independent
 * of the exit+open-resume cycle (`exitCycle.ts`), which re-reads live
 * state itself rather than consuming this cycle's output, per explicit
 * review ("dua siklus 15 detik yang independen, bukan satu memberi makan
 * yang lain").
 */
export async function runMonitoringLoggingCycle(deps: AppDeps): Promise<PositionMetricsResult[]> {
  return runMonitoringCycle({
    positions: deps.positions,
    livePositionState: deps.livePositionState,
    poolPrice: deps.poolPrice,
    onMetrics: (results) => {
      const ok = results.filter((r) => r.ok).length;
      deps.logger.info('monitoring_cycle', { positionsMonitored: results.length, ok, failed: results.length - ok });
    },
  });
}
