import type { PositionRepository } from '../positions/types';
import type { TransactionAttemptRepository } from '../execution/types';
import type { ExitStateRepository } from './types';
import { computeRealizedProceeds } from './executeExit';

export interface BackfillRealizedPnlDeps {
  positions: PositionRepository;
  txAttempts: TransactionAttemptRepository;
  exitStates: ExitStateRepository;
}

export interface BackfillRealizedPnlResult {
  /** Positions whose `realizedUsdgRaw` was null and is now populated by THIS run. */
  backfilledPositionIds: string[];
  /** Positions that are CLOSED with `realizedUsdgRaw` still null after this run -- genuinely unmeasurable (legacy verifyData shape, or one/both legs' VERIFIED attempt missing), not silently skipped. */
  stillUnmeasuredPositionIds: string[];
}

/**
 * P1-13 fix: idempotently backfills `realizedUsdgRaw` for every CLOSED
 * position where it is still null, reusing `executeExit.ts`'s
 * `computeRealizedProceeds` -- the EXACT SAME on-chain-measured-proceeds
 * computation a normal close uses, never a second implementation that
 * could silently diverge or double-count.
 *
 * No double-counting, by construction:
 *  - Only CLOSED positions with `realizedUsdgRaw === null` are ever
 *    candidates (an already-measured position is skipped before any
 *    computation even runs).
 *  - The actual write (`PositionRepository.backfillRealizedUsdgRaw`) is a
 *    DB-level CONDITIONAL update (`WHERE ... AND realizedUsdgRaw IS
 *    NULL`) -- even if this function were somehow invoked twice
 *    concurrently for the same position, only one write can ever land;
 *    the second is a no-op, never a second addition.
 *  - Nothing here ever re-derives or re-sums an ALREADY-set
 *    `realizedUsdgRaw` -- there is no code path that reads a non-null
 *    value and writes a new one on top of it.
 *
 * Idempotent, by construction: running this repeatedly is always safe --
 * the first run backfills whatever it can; every subsequent run finds
 * nothing left to do for those same positions (their `realizedUsdgRaw` is
 * no longer null) and only picks up genuinely NEW closes that still lack
 * one.
 *
 * `ExitState.swapAttemptCount` is read to derive the CURRENT (i.e. final,
 * successful) swap attempt's key -- the exact same derivation
 * `executeExit.ts` itself uses at close time (`${closeIdempotencyKey}:swap:
 * ${swapAttemptCount}`). `ExitState` rows are never deleted on close (no
 * pruning exists anywhere in this codebase), so this reads back the SAME
 * count that was current at the moment this position actually closed.
 *
 * Read-heavy, single-pass, no batching/pagination -- acceptable for an
 * on-demand/startup backfill over a bot's own (bounded) position history;
 * revisit if the CLOSED table ever grows large enough for this to matter.
 */
export async function backfillRealizedPnl(deps: BackfillRealizedPnlDeps): Promise<BackfillRealizedPnlResult> {
  const closed = await deps.positions.findAllClosed();
  const backfilledPositionIds: string[] = [];
  const stillUnmeasuredPositionIds: string[] = [];

  for (const position of closed) {
    if (position.realizedUsdgRaw !== null) continue; // already measured -- never touched, never double-counted
    if (!position.closeIdempotencyKey) {
      stillUnmeasuredPositionIds.push(position.id);
      continue;
    }

    const removeKey = `${position.closeIdempotencyKey}:removeLiquidity`;
    const exitState = await deps.exitStates.getOrCreate(position.id);
    const swapKey = `${position.closeIdempotencyKey}:swap:${exitState.swapAttemptCount}`;
    const realizedUsdgRaw = await computeRealizedProceeds({ txAttempts: deps.txAttempts }, removeKey, swapKey);

    if (realizedUsdgRaw === null) {
      stillUnmeasuredPositionIds.push(position.id);
      continue;
    }

    const updated = await deps.positions.backfillRealizedUsdgRaw(position.id, realizedUsdgRaw);
    if (updated) {
      backfilledPositionIds.push(position.id);
    }
    // If `updated` is null, the conditional update found nothing to do --
    // a concurrent backfill run already set it between our read and our
    // write. That position IS measured now, just not by this call, so it
    // belongs in neither list here (never double-counted, never
    // misreported as "still unmeasured").
  }

  return { backfilledPositionIds, stillUnmeasuredPositionIds };
}
