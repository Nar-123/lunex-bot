import { Router } from 'express';
import type { AppDeps } from '../../composition/types';

/**
 * `POST /control/pause` / `POST /control/resume` -- the ONLY way `paused`
 * is ever changed (`PATCH /settings` deliberately cannot touch it, see
 * `settings/types.ts`'s `SettingsPatch`). See `screeningCycle.ts` for
 * where this flag is actually enforced (top of the screening cycle only --
 * monitoring/exit are never affected).
 */
export function createControlRouter(deps: AppDeps): Router {
  const router = Router();

  router.post('/pause', async (_req, res) => {
    const settings = await deps.settings.pause();
    res.status(200).json({ paused: settings.paused });
  });

  router.post('/resume', async (_req, res) => {
    const settings = await deps.settings.resume();
    res.status(200).json({ paused: settings.paused });
  });

  return router;
}
