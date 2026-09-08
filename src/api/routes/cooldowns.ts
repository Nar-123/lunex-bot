import { Router } from 'express';
import type { AppDeps } from '../../composition/types';

/** `GET /cooldowns` -- `cooldown/cooldownRepository.ts`'s `findAllActive` (Module 10 addition, reuses the existing `computeCooldownStatus` calculator internally). */
export function createCooldownsRouter(deps: AppDeps): Router {
  const router = Router();

  router.get('/', async (_req, res) => {
    const cooldowns = await deps.cooldown.findAllActive();
    res.status(200).json({ cooldowns });
  });

  return router;
}
