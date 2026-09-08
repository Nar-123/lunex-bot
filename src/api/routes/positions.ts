import { Router } from 'express';
import { runMonitoringCycle } from '../../monitoring/monitorPositions';
import type { PositionMetricsResult } from '../../monitoring/types';
import { config } from '../../config';
import type { AppDeps } from '../../composition/types';

/** Pure, same inline-calc style as `cooldown/cooldownLogic.ts`'s `computeCooldownStatus` -- not new business logic, just reshaping an already-persisted timestamp into elapsed/remaining. */
function computeOorStatus(oorStartedAt: Date | null, now: number = Date.now()): { outOfRange: boolean; elapsedMs: number; remainingMs: number } {
  if (!oorStartedAt) return { outOfRange: false, elapsedMs: 0, remainingMs: config.rules.exits.OOR.GRACE_WINDOW_MS };
  const elapsedMs = now - oorStartedAt.getTime();
  return { outOfRange: true, elapsedMs, remainingMs: Math.max(0, config.rules.exits.OOR.GRACE_WINDOW_MS - elapsedMs) };
}

async function getActivePositionsPayload(deps: AppDeps) {
  let metrics: PositionMetricsResult[] = [];
  await runMonitoringCycle({
    positions: deps.positions,
    livePositionState: deps.livePositionState,
    poolPrice: deps.poolPrice,
    onMetrics: (results) => {
      metrics = results;
    },
  });
  // Re-read separately (not reused from inside runMonitoringCycle, which
  // doesn't return the records themselves) -- `findAllActive` is cheap
  // and this is a read endpoint, not a hot path.
  const active = await deps.positions.findAllActive();

  const byId = new Map(metrics.map((m) => [m.positionId, m]));
  const now = Date.now();
  return Promise.all(
    active.map(async (position) => {
      const metric = byId.get(position.id);
      const exitState = await deps.exitStates.getOrCreate(position.id);
      const oor = computeOorStatus(exitState.oorStartedAt, now);
      return {
        id: position.id,
        tokenAddress: position.tokenAddress,
        tokenSymbol: position.tokenSymbol,
        entryUsdgRaw: position.entryUsdgRaw.toString(),
        openedAt: position.openedAt,
        metrics:
          metric && metric.ok
            ? {
                ok: true,
                currentPriceUsdgPerToken: metric.currentPriceUsdgPerToken,
                entryPriceUsdgPerToken: metric.entryPriceUsdgPerToken,
                pnlPct: metric.pnlPct,
                currentValueUsdgRaw: metric.currentValueUsdgRaw.toString(),
                feesEarnedUsdgRaw: metric.feesEarnedUsdgRaw.toString(),
                yieldPct: metric.yieldPct,
                inRange: metric.inRange,
              }
            : { ok: false, reason: metric && !metric.ok ? metric.reason : 'no metrics read this request' },
        oor,
      };
    }),
  );
}

/**
 * `?status=closed` branch -- Module 11's `/report` command. Deliberately
 * plain `PositionRecord` fields only, NO `computePositionMetrics` call
 * (see `PositionRepository.findAllClosed`'s doc comment for why a closed
 * position's PNL/fee can't be computed that way) -- `realizedPnl`/
 * `feesEarnedUsdgRaw` are honestly reported as unavailable rather than
 * guessed, per the flagged gap in README's Module 11 section.
 */
async function getClosedPositionsPayload(deps: AppDeps) {
  const closed = await deps.positions.findAllClosed();
  return closed.map((position) => ({
    id: position.id,
    tokenAddress: position.tokenAddress,
    tokenSymbol: position.tokenSymbol,
    entryUsdgRaw: position.entryUsdgRaw.toString(),
    closedAt: position.closedAt,
    closeReason: position.closeReason,
    realizedPnlAvailable: false,
  }));
}

/**
 * `GET /positions` -- reuses Module 7's `runMonitoringCycle` in full (via
 * `onMetrics` capturing its results) rather than re-reading live
 * state/computing metrics itself, zipped with the `PositionRecord`s it
 * read and each position's persisted `ExitState.oorStartedAt` (Module 8,
 * already-exposed primitive) for OOR status -- no new price/PNL/fee/yield
 * logic anywhere in this file. `?status=closed` (Module 11) branches to a
 * separate, much simpler shape -- see `getClosedPositionsPayload`.
 */
export function createPositionsRouter(deps: AppDeps): Router {
  const router = Router();

  router.get('/', async (req, res) => {
    if (req.query.status === 'closed') {
      const payload = await getClosedPositionsPayload(deps);
      res.status(200).json({ positions: payload });
      return;
    }
    const payload = await getActivePositionsPayload(deps);
    res.status(200).json({ positions: payload });
  });

  return router;
}
