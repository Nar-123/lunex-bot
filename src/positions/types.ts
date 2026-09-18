import type { Address } from 'viem';
import type { CapitalRules } from '../capital/types';

export type PositionStatus = 'OPENING' | 'ACTIVE' | 'CLOSING' | 'CLOSED' | 'FAILED';

export interface PositionPoolContext {
  poolId: `0x${string}`;
  currency0: Address;
  currency1: Address;
  fee: number;
  tickSpacing: number;
  hooks: Address;
}

export interface PositionRecord {
  id: string;
  tokenAddress: Address;
  tokenSymbol: string;
  tokenDecimals: number;
  pool: PositionPoolContext;
  tickLower: number;
  tickUpper: number;
  positionTokenId: string | null;
  /** Amount deployed at entry (35% of free USDG balance at the time), raw units -- the PNL basis, never recomputed. */
  entryUsdgRaw: bigint;
  entrySqrtPriceX96: bigint;
  entryTick: number;
  status: PositionStatus;
  openIdempotencyKey: string;
  closeIdempotencyKey: string | null;
  openedAt: Date | null;
  closedAt: Date | null;
  closeReason: string | null;
  /**
   * VALIDATION PHASE: total USDG (raw) the exit actually returned to the
   * wallet, measured from the two exit transactions' confirmed receipts.
   * null = not measured (legacy rows, or receipts that couldn't be
   * decoded) -- honestly unavailable, never a 0 placeholder. Realized PnL
   * = this - entryUsdgRaw, computed at read time by reporting only.
   */
  realizedUsdgRaw: bigint | null;
}

export interface CreatePositionInput {
  tokenAddress: Address;
  tokenSymbol: string;
  tokenDecimals: number;
  pool: PositionPoolContext;
  tickLower: number;
  tickUpper: number;
  entryUsdgRaw: bigint;
  entrySqrtPriceX96: bigint;
  entryTick: number;
  openIdempotencyKey: string;
}

/**
 * P1-2 fix: thrown by `create()` when a real DB-level partial unique index
 * (`Position_tokenAddress_active_unique` -- see `prisma/schema.prisma`'s
 * doc comment on the `Position` model) rejects the insert because a
 * non-closed (OPENING/ACTIVE/CLOSING) position for this SAME token already
 * exists. This is what makes "1 token = 1 non-closed position" atomic:
 * before this fix, `filters/rules/duplicatePosition.ts`'s `findActiveByToken`
 * check and the eventual `create()` call were two separate reads/writes
 * with an unguarded gap between them (pool selection, range computation)
 * that two concurrent candidates for the same token could both pass. Now,
 * even if both candidates get this far, only the FIRST `create()` can
 * succeed -- the second fails with this specific, catchable error instead
 * of silently creating a second row for the same token.
 */
export class DuplicateActiveTokenPositionError extends Error {
  constructor(public readonly tokenAddress: Address) {
    super(`a non-closed (OPENING/ACTIVE/CLOSING) position for token ${tokenAddress} already exists`);
    this.name = 'DuplicateActiveTokenPositionError';
  }
}

export type CreateIfCapitalAllowsResult =
  | { ok: true; record: PositionRecord }
  | { ok: false; reason: string };

export interface PositionRepository {
  /** Throws `DuplicateActiveTokenPositionError` (P1-2) if a non-closed position for `input.tokenAddress` already exists -- see that error's doc comment. Never silently creates a second row for the same token. */
  create(input: CreatePositionInput): Promise<PositionRecord>;
  /**
   * P1-1 fix: atomically re-validates the capital cap AGAINST A FRESH
   * READ of `totalDeployedUsdg`/`activePositionsCount` (taken inside the
   * SAME database transaction as the insert, not the possibly-now-stale
   * values `screeningCycle.ts` used minutes/steps earlier to size this
   * candidate and select its pool/range) before actually creating the row.
   *
   * P1-1 cross-process hardening: the caller supplies a READER for the
   * RAW on-chain USDG balance (`CapitalSnapshotProvider.readOnChainUsdgBalance`),
   * never a pre-derived `freeUsdgBalance`. This method reads the
   * non-closed rows, THEN the raw balance, then -- holding `CapitalLock`
   * -- re-reads the rows, verifies via `checkCapitalStateConsistent` that
   * nothing which could have moved the balance changed in between (fails
   * closed otherwise), and derives free/deployed/count from that ONE fresh
   * row set via `deriveCapitalSnapshot` (both in
   * `capital/freshCapitalSnapshot.ts`). The earlier version paired a
   * caller-supplied free balance (already net of the OPENING rows that
   * existed at sizing time) with a fresh deployed sum, double-counting any
   * OPENING row created by another process in between -- see that file's
   * doc comment. Lock contention (SQLITE_BUSY / transaction timeout) and a
   * failed balance read both return `{ok: false}` with nothing written.
   *
   * Reuses `capital/decideCapitalAllocation` itself (never duplicates its
   * cap logic) against the freshly-read snapshot; if the ALREADY-DECIDED
   * `input.entryUsdgRaw` no longer fits the freshly-recomputed remaining
   * capacity (a concurrent reservation ate it in the meantime) OR the
   * active-position count has since reached its cap, this returns `{ok:
   * false}` and creates NOTHING -- it deliberately does not try to
   * re-negotiate a smaller size, since the pool/range this candidate was
   * already matched to was chosen for the ORIGINAL size and resizing here
   * would silently invalidate that earlier decision.
   */
  createIfCapitalAllows(input: CreatePositionInput, readOnChainUsdgBalance: () => Promise<bigint>, rules: CapitalRules): Promise<CreateIfCapitalAllowsResult>;
  findById(id: string): Promise<PositionRecord | null>;
  /** The "1 coin = 1 active position" check -- OPENING/ACTIVE/CLOSING all count, CLOSED doesn't. */
  findActiveByToken(tokenAddress: Address): Promise<PositionRecord | null>;
  /** Confirmed, currently-open positions only (status ACTIVE) -- the basis for `monitoring/`'s per-position price/PNL/fee tracking. */
  findAllActive(): Promise<PositionRecord[]>;
  /**
   * CLOSING only -- Module 8's per-tick "resume any exit already in
   * flight" pass. No existing method returns CLOSING-only: `findAllActive`
   * is ACTIVE-only, `findDeployedPositions` is OPENING+ACTIVE+CLOSING
   * (a capital-accounting concern, not a "what needs resuming" one). A
   * position here might be waiting on an ambiguous/ resumable
   * `executeCriticalTransaction` result (retry the SAME idempotencyKey) or
   * mid-swap-retry after remove-liquidity already succeeded (retry with a
   * fresh swap key) -- `exits/executeExit.ts` handles both by simply
   * calling itself again; this method is just "which positions to call it
   * on."
   */
  findAllClosing(): Promise<PositionRecord[]>;
  /**
   * OPENING only -- the mint-side mirror of `findAllClosing()`, for
   * Module 9's per-tick "resume any deploy already in flight" pass.
   * A position here is either genuinely mid-mint (waiting on an
   * ambiguous/resumable `executeCriticalTransaction` result -- e.g. a
   * crash between SIGNED and broadcast, or between broadcast and
   * CONFIRMED) or -- if the process crashed before ever getting a
   * definitive answer -- simply needs `openPosition.ts`'s orchestrator
   * invoked again with the SAME `openIdempotencyKey`, which resumes
   * exactly where it left off (no fresh-key-per-retry pattern here: a
   * single-transaction mint has no "already-verified earlier leg" to
   * protect from duplication the way exits/'s two-transaction flow does).
   */
  findAllOpening(): Promise<PositionRecord[]>;
  /**
   * CLOSED only -- Module 11's `GET /positions?status=closed` (and its
   * `/report` Telegram command). Deliberately returns plain
   * `PositionRecord` fields, never metrics from `computePositionMetrics`
   * -- that function needs LIVE on-chain state (current liquidity,
   * current pool price) a closed position no longer has; calling it here
   * would produce a meaningless number (0 liquidity -> "-100% PNL"), not
   * a real one. See README's Module 11 section for why realized PNL/fee
   * reporting is a flagged, not-yet-built gap rather than something this
   * method tries to approximate.
   */
  findAllClosed(): Promise<PositionRecord[]>;
  /**
   * OPENING + ACTIVE + CLOSING -- the basis for `totalDeployedUsdg`
   * (capital that's committed/at-risk, for the 90% cap). Two rounds of
   * review each found a real gap here, fixed by two DIFFERENT mechanisms
   * -- summing more statuses isn't enough on its own for OPENING:
   *
   *  - CLOSING was originally excluded: its LP hasn't actually been
   *    removed for most of the exit flow, so its capital is neither
   *    "free" (not back in the wallet) nor counted as "deployed." Fixed
   *    by including it in this sum -- no double-count, since it was
   *    never in the on-chain free-balance read either.
   *  - OPENING was already excluded from this sum specifically to avoid
   *    double-counting against the on-chain free-balance read (that
   *    capital IS still sitting in the wallet, unspent, until the mint
   *    transaction is mined). But leaving it out of BOTH this sum AND a
   *    balance adjustment created the mirror-image gap: `freeUsdgBalance`
   *    kept reporting the full pre-deployment balance throughout the
   *    entire OPENING window (which can span the whole
   *    BUILT->SIGNED->SENT->CONFIRMED pipeline, not just a brief instant
   *    -- confirmed by a concrete worked example where three sequential
   *    OPENING attempts, none yet mined, together sized themselves
   *    against the SAME un-decremented balance and collectively
   *    committed more USDG than the wallet ever held). Fixed with BOTH
   *    halves together in `capitalSnapshotProvider.ts`: OPENING amounts
   *    ARE included in this sum, AND are also subtracted from the
   *    reported `freeUsdgBalance` (as a "reservation") so the same money
   *    is never simultaneously "free" and "deployed." See that file's
   *    doc comment for the algebraic proof that this keeps
   *    `freeUsdgBalance + totalDeployedUsdg` equal to the true total
   *    portfolio value for any mix of statuses.
   */
  findDeployedPositions(): Promise<PositionRecord[]>;
  /**
   * OPENING + ACTIVE + CLOSING count -- the basis for the
   * MAX_ACTIVE_POSITIONS (3) cap. Same status set as
   * `findDeployedPositions()` now (a count vs. the full records), kept
   * as a separate method since the two calls serve different consumers.
   */
  countNonClosed(): Promise<number>;
  markActive(id: string, positionTokenId: string, openedAt: Date): Promise<PositionRecord>;
  markClosing(id: string, closeIdempotencyKey: string): Promise<PositionRecord>;
  /**
   * `realizedUsdgRaw` (optional, null = not measured) is persisted in the
   * SAME atomic update as the status transition -- the proceeds and the
   * CLOSED state can never disagree. See `PositionRecord.realizedUsdgRaw`.
   */
  markClosed(id: string, closedAt: Date, closeReason: string, realizedUsdgRaw?: bigint | null): Promise<PositionRecord>;
  /**
   * P1-13 fix: idempotently backfills `realizedUsdgRaw` for a position
   * that is ALREADY CLOSED and whose value is still null (a legacy row,
   * or a close that happened before the proceeds fields existed) --
   * status is never touched, only this one field. A DB-level CONDITIONAL
   * update (`WHERE id = ? AND status = 'CLOSED' AND realizedUsdgRaw IS
   * NULL`), so it is safe to call repeatedly or from a concurrent worker:
   * once a value has been written (by this method OR by the original
   * `markClosed`), every later call is a no-op that changes nothing --
   * there is no double-counting path, because a non-null value can never
   * be overwritten by this method. Returns `null` (not an error) when the
   * condition didn't hold -- either the position isn't CLOSED, or its
   * `realizedUsdgRaw` was already set (by this method or `markClosed`) --
   * the caller should treat that as "nothing to do," not a failure.
   */
  backfillRealizedUsdgRaw(id: string, realizedUsdgRaw: bigint): Promise<PositionRecord | null>;
  /**
   * Terminal, non-consuming status for an OPENING position whose deploy
   * transaction ended in a DEFINITIVE (`resumable: false`) failure from
   * `executeCriticalTransaction` -- the row never became ACTIVE and never
   * will. Added per review (revision 7), asked right after the OPENING-
   * window fix above: that fix made `freeUsdgBalance`/`totalDeployedUsdg`
   * correct on the assumption an OPENING position EVENTUALLY resolves
   * (mines, or gets cleaned up) -- but before this method existed, there
   * was no way for a row to ever leave OPENING except `markActive`. A
   * position whose deploy fails pre-broadcast (SIMULATION_REJECTED,
   * GAS_UNAFFORDABLE), is rejected at broadcast (BROADCAST_REJECTED), or
   * reverts on-chain (REVERTED) never spends the wallet's USDG -- but
   * without this transition it stays OPENING forever, permanently
   * (not just for a mining-delay window) reserving its `entryUsdgRaw` out
   * of `freeUsdgBalance` AND counting it in `totalDeployedUsdg` AND
   * occupying a `countNonClosed` slot, for capital that was actually never
   * spent and is sitting completely free on-chain. Confirmed both by
   * reading the code (no other method can move a row out of OPENING) and
   * by a worked example: a single large stuck-OPENING position can, on
   * its own, push `totalDeployedUsdg` over the 90% cap forever, or three
   * small ones can exhaust `MAX_ACTIVE_POSITIONS` forever -- either way
   * `decideCapitalAllocation` wrongly rejects deployments that the TRUE
   * on-chain balance has ample room for. Deliberately excluded from
   * `NON_CLOSED_STATUSES` (same bucket as CLOSED) -- no changes needed
   * anywhere in `capitalSnapshotProvider.ts` or the deployed/count sums,
   * since "not in that set" is already sufficient; this method's entire
   * job is just making the transition OUT of OPENING possible at all.
   */
  markFailed(id: string): Promise<PositionRecord>;
  /**
   * The exit-side mirror of `markFailed` (Module 8, revision-3-of-Module-8
   * in review terms) -- reverts status CLOSING -> ACTIVE and clears
   * `closeIdempotencyKey` to `null`. Correct ONLY when the exit's
   * remove-liquidity transaction failed DEFINITIVELY (`resumable: false`)
   * BEFORE ever reaching VERIFIED -- at that point nothing has changed
   * on-chain, the LP is still fully intact, so "this position never
   * started exiting" is the true state and ACTIVE is the correct status.
   * Clearing `closeIdempotencyKey` (rather than leaving the dead one in
   * place) is what lets the NEXT exit attempt call `markClosing` with a
   * fresh key instead of `executeCriticalTransaction` returning the same
   * cached FAILED result forever -- exactly the same "give it a real way
   * out" reasoning as `markFailed`'s doc comment, just for the opposite
   * direction of the position lifecycle.
   *
   * MUST NOT be called once remove-liquidity has reached VERIFIED (LP
   * already gone) -- see `exits/executeExit.ts` for the other branch,
   * where a definitive SWAP failure instead stays at CLOSING and retries
   * with a fresh swap-specific key, since there is no LP left to revert to.
   */
  markExitFailed(id: string): Promise<PositionRecord>;
  /**
   * C7 concurrency fix, P0-1 hardened: atomic compare-and-swap claim --
   * succeeds ONLY if `id` is currently at `expectedStatus` AND was not
   * claimed within the last `freshnessMs`. Implemented as a single
   * conditional `UPDATE ... WHERE id = ? AND status = ? AND (claim
   * expired) SET resumeClaimedAt = now, resumeClaimToken = <fresh random
   * token>` so the check-and-set is one atomic database operation, never a
   * racy read-then-write. Callers that fail to claim (return `null`) MUST
   * NOT proceed with any transaction-executing logic for this position
   * this tick -- another cycle already owns it (or owned it moments ago
   * and the claim hasn't expired yet). This is what makes it safe for the
   * 30-minute screening cycle's `openPosition()` and the 15-second exit
   * cycle's OPENING-resume pass to run on independent, unsynchronized
   * schedules (see `composition/app.ts`) without both ever executing a
   * transaction for the SAME position at once.
   *
   * P0-1: returns the winning caller's own claim TOKEN (a fresh random
   * string, unique per call) instead of a plain boolean. The caller MUST
   * hold onto this token and pass the EXACT SAME value to
   * `releaseResumeClaim` -- this is what lets `releaseResumeClaim` verify
   * "am I still the owner of this claim" before clearing it, closing the
   * race a plain boolean claim could not: worker A claims, hangs past
   * `freshnessMs`, worker B legitimately re-claims the now-expired row,
   * THEN worker A finally wakes up and would (under the old unconditional
   * release) delete B's still-active claim out from under it, letting a
   * third worker C claim while B is still mid-flight. Returns `null` if
   * the claim was not won.
   */
  claimForResume(id: string, expectedStatus: 'OPENING' | 'CLOSING', freshnessMs: number): Promise<string | null>;
  /**
   * Releases a claim taken by `claimForResume` -- called unconditionally
   * from the CALLER's perspective (success, definitive failure, OR
   * ambiguous/PENDING outcome) once the claiming call's work is done, so
   * the claim's lifetime matches the ACTUAL duration of the in-flight work
   * (however long a mint/exit takes to mine) rather than a fixed timeout
   * that could otherwise stall a legitimate next attempt. The
   * `freshnessMs` window in `claimForResume` exists purely to recover from
   * the one case this can't cover: the claiming process crashing before
   * ever reaching this release.
   *
   * P0-1: requires the exact `token` returned by the `claimForResume` call
   * that took this claim (`UPDATE ... WHERE id = ? AND resumeClaimToken =
   * ?`). If the token no longer matches -- because the claim already
   * expired and was won by a different worker, or was already released --
   * this is a SAFE NO-OP (returns `false`), never an error and never a
   * mutation of someone else's claim. Callers should not treat a `false`
   * return as a failure to handle; it simply means "there was nothing of
   * mine left to release," which is the correct outcome after losing a
   * claim to expiry.
   */
  releaseResumeClaim(id: string, token: string): Promise<boolean>;
}
