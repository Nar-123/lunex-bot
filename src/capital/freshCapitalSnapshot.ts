import type { CapitalSnapshot } from './types';

/**
 * The minimal per-position facts capital accounting needs -- one row per
 * NON-CLOSED (OPENING/ACTIVE/CLOSING) position. `closeIdempotencyKey` is
 * what locates a CLOSING position's exit-leg TransactionAttempts (H2).
 */
export interface CapitalPositionRow {
  id: string;
  status: string;
  entryUsdgRaw: bigint;
  closeIdempotencyKey?: string | null;
}

/** H2: the fields of a TransactionAttempt capital accounting reads. */
export interface ExitLegAttempt {
  idempotencyKey: string;
  status: string;
  verifyData: unknown;
}

/**
 * H2: a transaction at one of these statuses MAY already be mined (its
 * USDG effect may already be in the wallet) but has not been VERIFIED, so
 * its USDG effect is not yet known. `executeCriticalTransaction` persists
 * SIGNED (with the txHash) BEFORE it broadcasts, so any exit transaction
 * that could possibly have landed on-chain is at least SIGNED in the DB --
 * there is no unrecorded window.
 */
const POSSIBLY_MINED_UNVERIFIED = new Set(['SIGNED', 'SENT', 'CONFIRMED']);

/** The exit-leg key prefix for a close attempt -- matches `executeExit.ts`'s `${closeIdempotencyKey}:removeLiquidity` / `:swap:N` / `:approve:N` derivation. */
export function exitLegKeyPrefix(closeIdempotencyKey: string): string {
  return `${closeIdempotencyKey}:`;
}

function measuredUsdgProceeds(verifyData: unknown): bigint | null {
  if (typeof verifyData !== 'object' || verifyData === null || !('usdgProceedsRaw' in verifyData)) return null;
  const value = verifyData.usdgProceedsRaw;
  return typeof value === 'bigint' ? value : null;
}

/**
 * H2: how much of one position's entry capital is STILL deployed (not yet
 * back in the wallet as USDG), for capital-accounting purposes.
 *
 *   OPENING / ACTIVE                     -> entryUsdgRaw (unchanged)
 *   CLOSING, remove-liquidity absent /
 *     pre-broadcast / FAILED             -> entryUsdgRaw (the LP is intact)
 *   CLOSING, remove-liquidity VERIFIED, fully converted (the burn paid 0
 *     TOKEN, or a swap leg of THIS close is VERIFIED) -> 0: everything is
 *     back in the wallet as USDG; any shortfall versus entry is a realized
 *     result, not exposure
 *   CLOSING, remove-liquidity VERIFIED, TOKEN still awaiting its swap
 *     -> max(entry - R, 0), R = the remove-liquidity receipt's USDG
 *     proceeds: the COST-BASIS residual of the unconverted TOKEN. Every
 *     other deployed position is carried at cost (entry) too, so each
 *     position's entry capital is represented EXACTLY ONCE: the returned R
 *     inside the on-chain balance, the remainder here.
 *   Before H2 the full `entryUsdgRaw` stayed deployed until CLOSED, so R
 *   (and any verified swap proceeds) was counted twice: in the wallet
 *   balance AND in the deployed figure.
 *   ANY remove/swap leg SIGNED/SENT/CONFIRMED (possibly mined, not yet
 *   verified), or a VERIFIED leg whose USDG proceeds were never measured
 *   (a legacy attempt) -> UNRESOLVED: the USDG it returned may or may not
 *   already be in the wallet and its size is unknown, so no figure can be
 *   given without risking a double count. The caller fails closed.
 *
 * Approve legs move no USDG and are ignored. FAILED legs contribute
 * nothing: a FAILED remove-liquidity never burned the LP (the exit reverts
 * the position to ACTIVE), and a FAILED swap never delivered USDG through
 * a verified receipt (executeExit retries it under a fresh key).
 */
export function assessRemainingExposure(
  row: CapitalPositionRow,
  exitLegAttempts: readonly ExitLegAttempt[],
): { ok: true; exposureUsdgRaw: bigint; returnedUsdgRaw: bigint } | { ok: false; reason: string } {
  if (row.status !== 'CLOSING' || !row.closeIdempotencyKey) {
    return { ok: true, exposureUsdgRaw: row.entryUsdgRaw, returnedUsdgRaw: 0n };
  }
  const prefix = exitLegKeyPrefix(row.closeIdempotencyKey);
  const removeKey = `${prefix}removeLiquidity`;
  const isSwapKey = (key: string): boolean => /^swap:\d+$/.test(key.slice(prefix.length));
  const legs = exitLegAttempts.filter((a) => a.idempotencyKey === removeKey || (a.idempotencyKey.startsWith(prefix) && isSwapKey(a.idempotencyKey)));

  const inFlight = legs.find((a) => POSSIBLY_MINED_UNVERIFIED.has(a.status));
  if (inFlight) {
    return {
      ok: false,
      reason: `CLOSING position ${row.id}: exit leg ${inFlight.idempotencyKey} is ${inFlight.status} (possibly mined, not yet verified) -- its USDG effect on the wallet is unknown`,
    };
  }

  const remove = legs.find((a) => a.idempotencyKey === removeKey);
  if (remove?.status !== 'VERIFIED') {
    return { ok: true, exposureUsdgRaw: row.entryUsdgRaw, returnedUsdgRaw: 0n };
  }
  const removeUsdg = measuredUsdgProceeds(remove.verifyData);
  if (removeUsdg === null) {
    return { ok: false, reason: `CLOSING position ${row.id}: remove-liquidity is VERIFIED but its USDG proceeds were never measured (legacy attempt)` };
  }

  let swapUsdg = 0n;
  const verifiedSwaps = legs.filter((a) => a.idempotencyKey !== removeKey && a.status === 'VERIFIED');
  for (const swap of verifiedSwaps) {
    const proceeds = measuredUsdgProceeds(swap.verifyData);
    if (proceeds === null) {
      return { ok: false, reason: `CLOSING position ${row.id}: swap ${swap.idempotencyKey} is VERIFIED but its USDG proceeds were never measured (legacy attempt)` };
    }
    swapUsdg += proceeds;
  }

  const returned = removeUsdg + swapUsdg;
  // Fully converted back to USDG -- nothing of this position is deployed
  // any more; any shortfall versus entry is a REALIZED result (already
  // reflected in the wallet balance), not exposure. This is the case once
  // the burn paid no TOKEN at all (H1 USDG-only) or a swap has VERIFIED
  // (the swap sells the whole TOKEN balance).
  const removeTokenProceeds = (remove.verifyData as { tokenProceedsRaw?: unknown }).tokenProceedsRaw;
  if (removeTokenProceeds === 0n || verifiedSwaps.length > 0) {
    return { ok: true, exposureUsdgRaw: 0n, returnedUsdgRaw: returned };
  }
  // TOKEN still awaiting its swap: carry its unrecovered cost basis.
  return { ok: true, exposureUsdgRaw: row.entryUsdgRaw > removeUsdg ? row.entryUsdgRaw - removeUsdg : 0n, returnedUsdgRaw: returned };
}

/**
 * The ONE place the capital snapshot is derived from a raw on-chain USDG
 * balance plus the non-closed position rows (and, for CLOSING rows, their
 * exit-leg attempts) -- shared by `positions/capitalSnapshotProvider.ts`
 * (the per-cycle sizing read) and `PositionRepository.createIfCapitalAllows`
 * (the write-time re-check under `CapitalLock`), so the two can never
 * disagree about semantics:
 *
 *   reservedForOpening   = sum(entryUsdgRaw for OPENING)
 *   freeUsdgBalance      = onChainBalance - reservedForOpening   (never < 0)
 *   totalDeployedUsdg    = sum(assessRemainingExposure(row))     (H2)
 *   activePositionsCount = number of non-closed rows (a CLOSING position
 *                          still occupies its slot until CLOSED)
 *
 * INVARIANT -- what the allocator's `free + deployed` base means: every
 * position's entry capital is counted exactly once, at cost -- either as
 * USDG physically in the wallet (OPENING capital that has not left the
 * wallet yet is moved out of "free" by the reservation) or as remaining
 * deployed exposure, never both. With W = raw on-chain USDG:
 *
 *   free + deployed = W + sum(entry: ACTIVE and CLOSING-before-remove)
 *                       + sum(unconverted residual: CLOSING-after-remove)
 *
 * where the residual is 0 once the position is fully back in USDG and
 * max(entry - USDG the burn returned, 0) while TOKEN awaits its swap.
 *
 * (OPENING cancels: subtracted from W, added to deployed.) USDG a CLOSING
 * position has already returned to the wallet (inside W) is therefore no
 * longer ALSO inside its deployed figure. Pre-H2 the last term was the
 * full entry, counting the returned USDG twice (1000 wallet + 350 entry =
 * 1350 for a true ~1000). This is a cost-basis figure, not mark-to-market:
 * TOKEN awaiting its swap is carried at its unrecovered cost, exactly as
 * every ACTIVE position is carried at entry.
 *
 * `exitLegAttempts` MUST cover every CLOSING row's legs and be read AFTER
 * the on-chain balance (see `PositionCapitalSnapshotProvider.getSnapshot`
 * for why the order matters). `null` means "not available": any CLOSING row
 * then makes the snapshot unresolved (fail closed) instead of silently
 * reverting to the old double-counting figure. An unresolved snapshot
 * still carries numbers (affected rows at full entry, for display only)
 * plus `accountingUnresolvedReason`, which `decideCapitalAllocation`
 * refuses to size against.
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
export function deriveCapitalSnapshot(
  onChainBalance: bigint,
  rows: readonly CapitalPositionRow[],
  exitLegAttempts: readonly ExitLegAttempt[] | null,
): CapitalSnapshot {
  let totalDeployedUsdg = 0n;
  let unresolved: string | undefined;
  for (const row of rows) {
    if (row.status === 'CLOSING' && exitLegAttempts === null) {
      unresolved ??= `CLOSING position ${row.id}: exit-leg attempts were not provided, so USDG it may have returned cannot be accounted for`;
      totalDeployedUsdg += row.entryUsdgRaw;
      continue;
    }
    const assessed = assessRemainingExposure(row, exitLegAttempts ?? []);
    if (!assessed.ok) {
      unresolved ??= assessed.reason;
      totalDeployedUsdg += row.entryUsdgRaw;
      continue;
    }
    totalDeployedUsdg += assessed.exposureUsdgRaw;
  }
  const reservedForOpening = rows.filter((p) => p.status === 'OPENING').reduce((sum, p) => sum + p.entryUsdgRaw, 0n);
  const freeUsdgBalance = onChainBalance > reservedForOpening ? onChainBalance - reservedForOpening : 0n;
  return {
    freeUsdgBalance,
    totalDeployedUsdg,
    activePositionsCount: rows.length,
    ...(unresolved !== undefined && { accountingUnresolvedReason: unresolved }),
  };
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
