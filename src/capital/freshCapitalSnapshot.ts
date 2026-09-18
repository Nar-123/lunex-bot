import type { CapitalSnapshot } from './types';

/** The minimal per-position facts capital accounting needs -- one row per NON-CLOSED (OPENING/ACTIVE/CLOSING) position. */
export interface CapitalPositionRow {
  id: string;
  status: string;
  entryUsdgRaw: bigint;
}

/**
 * The ONE place the capital snapshot is derived from a raw on-chain USDG
 * balance plus the non-closed position rows -- shared by
 * `positions/capitalSnapshotProvider.ts` (the per-cycle sizing read) and
 * `PositionRepository.createIfCapitalAllows` (the write-time re-check under
 * `CapitalLock`), so the two can never disagree about semantics:
 *
 *   reservedForOpening = sum(entryUsdgRaw for OPENING)
 *   freeUsdgBalance    = onChainBalance - reservedForOpening   (never < 0)
 *   totalDeployedUsdg  = sum(entryUsdgRaw for OPENING + ACTIVE + CLOSING)
 *
 * See `capitalSnapshotProvider.ts`'s doc comment for the algebraic proof
 * that `freeUsdgBalance + totalDeployedUsdg` equals the true portfolio.
 *
 * P1-1 (cross-process fix): that proof ONLY holds when `onChainBalance` and
 * `rows` describe the SAME moment. Pairing a `freeUsdgBalance` already
 * derived from an OLDER row set with a FRESHER deployed sum double-counts
 * every OPENING row created in between (its capital is counted once as
 * "free" and again as "deployed") -- the exact bug that let three
 * concurrent callers reserve 1050 against a 950 cap. Callers must
 * therefore always pass the RAW balance here, never a pre-derived free
 * balance, and must pair it with rows validated by
 * `checkCapitalStateConsistent` below.
 */
export function deriveCapitalSnapshot(onChainBalance: bigint, rows: readonly CapitalPositionRow[]): CapitalSnapshot {
  const totalDeployedUsdg = rows.reduce((sum, p) => sum + p.entryUsdgRaw, 0n);
  const reservedForOpening = rows.filter((p) => p.status === 'OPENING').reduce((sum, p) => sum + p.entryUsdgRaw, 0n);
  const freeUsdgBalance = onChainBalance > reservedForOpening ? onChainBalance - reservedForOpening : 0n;
  return { freeUsdgBalance, totalDeployedUsdg, activePositionsCount: rows.length };
}

/**
 * P1-1: decides whether a raw on-chain balance read at time T (with
 * `observedBefore` = the non-closed rows read JUST BEFORE T) can still be
 * paired with `fresh` (the non-closed rows re-read under `CapitalLock`,
 * after T) without mis-stating free capital.
 *
 * Why the balance is not simply re-read inside the lock: that would hold
 * SQLite's database-wide write lock across a network RPC, stalling every
 * other writer (the 15s exit cycle included) for as long as the RPC takes.
 * Instead the balance is read OUTSIDE the lock and this check proves,
 * under the lock, that nothing which could have moved that balance
 * happened in the meantime:
 *
 *  - A row that is NEW since `observedBefore` and still OPENING is FINE --
 *    that is exactly a concurrent reservation. Its mint cannot have
 *    debited the balance read before it existed, so `deriveCapitalSnapshot`
 *    correctly subtracts it from the raw balance (the recalculation the
 *    old stale-free-balance code got wrong).
 *  - An observed row still at the SAME status is FINE -- an OPENING row
 *    whose mint lands later still has its capital counted exactly once
 *    (either still in the balance and subtracted, or already debited and
 *    subtracted again: conservative, never over-stating).
 *  - ANY other change -- an observed row changed status (OPENING->ACTIVE
 *    means its mint debited the wallet at an unknown time relative to T;
 *    CLOSING->CLOSED/ACTIVE, OPENING->FAILED likewise), disappeared from the
 *    non-closed set, or a new row appeared already past OPENING -- means
 *    the balance and the rows may no longer describe the same moment. This
 *    FAILS CLOSED (no reservation this attempt); the next screening cycle
 *    simply retries against fresh reads.
 */
export function checkCapitalStateConsistent(
  observedBefore: ReadonlyMap<string, string>,
  fresh: readonly CapitalPositionRow[],
): { ok: true } | { ok: false; reason: string } {
  const freshIds = new Set<string>();
  for (const row of fresh) {
    freshIds.add(row.id);
    const before = observedBefore.get(row.id);
    if (before === undefined) {
      if (row.status !== 'OPENING') {
        return { ok: false, reason: `position ${row.id} appeared as ${row.status} after the on-chain balance was read` };
      }
    } else if (before !== row.status) {
      return { ok: false, reason: `position ${row.id} moved ${before} -> ${row.status} after the on-chain balance was read` };
    }
  }
  for (const [id, status] of observedBefore) {
    if (!freshIds.has(id)) {
      return { ok: false, reason: `position ${id} left ${status} (closed/failed) after the on-chain balance was read` };
    }
  }
  return { ok: true };
}
