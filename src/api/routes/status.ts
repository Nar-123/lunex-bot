import { Router } from 'express';
import type { AppDeps } from '../../composition/types';

/**
 * `GET /status` -- reuses `CapitalSnapshotProvider` (Module 5) and
 * `PositionRepository`'s existing per-status finders (Modules 5/8/9A) plus
 * `SettingsRepository.get()` for `paused`. No new computation.
 */
export function createStatusRouter(deps: AppDeps): Router {
  const router = Router();

  router.get('/', async (_req, res) => {
    const [snapshot, active, opening, closing, settings] = await Promise.all([
      deps.capitalSnapshot.getSnapshot(),
      deps.positions.findAllActive(),
      deps.positions.findAllOpening(),
      deps.positions.findAllClosing(),
      deps.settings.get(),
    ]);

    res.status(200).json({
      paused: settings.paused,
      capital: {
        freeUsdgBalance: snapshot.freeUsdgBalance.toString(),
        totalDeployedUsdg: snapshot.totalDeployedUsdg.toString(),
        activePositionsCount: snapshot.activePositionsCount,
        exposurePct:
          snapshot.freeUsdgBalance + snapshot.totalDeployedUsdg > 0n
            ? Number((snapshot.totalDeployedUsdg * 10_000n) / (snapshot.freeUsdgBalance + snapshot.totalDeployedUsdg)) / 100
            : 0,
      },
      positions: {
        active: active.length,
        opening: opening.length,
        closing: closing.length,
      },
    });
  });

  return router;
}
