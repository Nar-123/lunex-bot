import { Router } from 'express';
import { isStuckAttempt } from '../../execution/stuckAttempt';
import { config } from '../../config';
import { filterToClosingPositions } from '../../exits/stuckSwapRetries';
import { runReconciliation } from '../../reconciliation/runReconciliation';
import type { AppDeps } from '../../composition/types';
import { assessClosingRecovery } from '../../exits/closingRecovery';
import { exitLegKeyPrefix } from '../../capital/freshCapitalSnapshot';

/**
 * `GET /positions/stuck` -- pure surfacing of already-built primitives, no
 * new stuck-detection logic of its own: `findNonTerminal()` +
 * `isStuckAttempt` (Module 6) for stuck transaction attempts,
 * `findStuckSwapRetries` (Module 8) for stuck exit-swap retries, and (H5)
 * `runReconciliation`'s on-chain <-> DB divergence findings -- the exact
 * same reconciliation check `composition/exitCycle.ts` already runs every
 * 15s tick, surfaced here on-demand too. The wallet-wide orphan-NFT scan
 * is deliberately skipped on this on-demand path (`includeOrphanScan:
 * false`) -- an API request should never trigger an expensive whole-wallet
 * log scan; that one only runs on the exit cycle's own cadence (see
 * exitCycle.ts's doc comment).
 */
export function createStuckRouter(deps: AppDeps): Router {
  const router = Router();

  router.get('/', async (_req, res) => {
    const nonTerminal = await deps.txAttempts.findNonTerminal();
    const stuckAttempts = nonTerminal.filter((a) => isStuckAttempt(a));
    // H16 fix -- see exits/stuckSwapRetries.ts's doc comment.
    const rawStuckSwapRetryPositionIds = await deps.exitStates.findStuckSwapRetries(config.rules.exits.SWAP_RETRY.STUCK_THRESHOLD);
    const currentlyClosing = await deps.positions.findAllClosing();
    const stuckSwapRetryPositionIds = filterToClosingPositions(rawStuckSwapRetryPositionIds, currentlyClosing.map((p) => p.id));
    const reconciliation = await runReconciliation(
      {
        positions: deps.positions,
        txAttempts: deps.txAttempts,
        exitStates: deps.exitStates,
        livePositionState: deps.livePositionState,
        ownedNftLister: deps.ownedNftLister,
        nftOwnerChecker: deps.nftOwnerChecker,
        positionIdentityChecker: deps.positionIdentityChecker,
        walletAddress: deps.walletAddress,
      },
      { includeOrphanScan: false },
    );

    // Unroutable TOKEN leg: every CLOSING position's exit phase, derived
    // ONLY from durable state (no live quote/balance read), with
    // `operatorActionRequired` set by the existing stuck policies. Read-only.
    const now = new Date();
    const closingPositions = [];
    for (const position of currentlyClosing) {
      const legs = position.closeIdempotencyKey ? await deps.txAttempts.findByKeyPrefixes([exitLegKeyPrefix(position.closeIdempotencyKey)]) : [];
      const r = assessClosingRecovery(position, legs, await deps.exitStates.getOrCreate(position.id), now);
      closingPositions.push({
        ...r,
        tokenResidualRaw: r.tokenResidualRaw === null ? null : r.tokenResidualRaw.toString(),
        usdgRecoveredRaw: r.usdgRecoveredRaw === null ? null : r.usdgRecoveredRaw.toString(),
      });
    }

    res.status(200).json({
      closingPositions,
      operatorActionRequiredPositionIds: closingPositions.filter((c) => c.operatorActionRequired).map((c) => c.positionId),
      stuckTransactionAttempts: stuckAttempts.map((a) => ({
        id: a.id,
        idempotencyKey: a.idempotencyKey,
        purpose: a.purpose,
        status: a.status,
        attemptCount: a.attemptCount,
        firstAttemptedAt: a.firstAttemptedAt,
      })),
      stuckSwapRetryPositionIds,
      reconciliation: {
        findings: reconciliation.findings,
        rpcHealthy: reconciliation.rpcHealthy,
        checkedAt: reconciliation.checkedAt,
      },
    });
  });

  return router;
}
