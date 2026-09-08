import { Router } from 'express';
import { isStuckAttempt } from '../../execution/stuckAttempt';
import { config } from '../../config';
import type { AppDeps } from '../../composition/types';

/**
 * `GET /positions/stuck` -- pure surfacing of two already-built primitives,
 * zero new stuck-detection logic: `findNonTerminal()` + `isStuckAttempt`
 * (Module 6) for stuck transaction attempts, `findStuckSwapRetries`
 * (Module 8) for stuck exit-swap retries. Same threshold
 * (`EXITS.SWAP_RETRY.STUCK_THRESHOLD`) already used by
 * `composition/exitCycle.ts`'s log surfacing.
 */
export function createStuckRouter(deps: AppDeps): Router {
  const router = Router();

  router.get('/', async (_req, res) => {
    const nonTerminal = await deps.txAttempts.findNonTerminal();
    const stuckAttempts = nonTerminal.filter((a) => isStuckAttempt(a));
    const stuckSwapRetryPositionIds = await deps.exitStates.findStuckSwapRetries(config.rules.exits.SWAP_RETRY.STUCK_THRESHOLD);

    res.status(200).json({
      stuckTransactionAttempts: stuckAttempts.map((a) => ({
        id: a.id,
        idempotencyKey: a.idempotencyKey,
        purpose: a.purpose,
        status: a.status,
        attemptCount: a.attemptCount,
        firstAttemptedAt: a.firstAttemptedAt,
      })),
      stuckSwapRetryPositionIds,
    });
  });

  return router;
}
