/**
 * Fencing obsolete, never-signed exit legs of a CLOSED lifecycle.
 *
 * ## The situation this exists for
 *
 * When an exit's TOKEN swap leg is blocked by something deterministic (the
 * production case: the Trading API kept returning the deprecated SwapProxy,
 * which `validateSwapQuote` refuses), the swap attempt row stays at PENDING
 * and its `attemptCount` climbs on every tick. If the position is then closed
 * by another route -- an operator dust settlement, a manual token settlement --
 * the lifecycle is over but the attempt row is still non-terminal. It is
 * harmless (it never reached SIGNED, so it can never broadcast) but it is
 * counted forever by `findNonTerminal()`, i.e. by `stuck_transaction_attempts`
 * and `/positions/stuck` -- noise that would mask a genuinely stuck attempt.
 *
 * ## Why FAILED, and not a new status or a DELETE
 *
 * `FAILED` is the existing terminal status and the existing mechanism:
 * `expireStaleOpening` already fences a never-signed mint/approve exactly this
 * way (`OPENING_TIMEOUT`). `executeCriticalTransaction` checks for `FAILED`
 * twice -- once on entry and again after taking the executor lock -- precisely
 * so a fenced attempt can never be resurrected, re-nonced, signed or broadcast.
 * Marking these rows terminal therefore *strengthens* the no-broadcast
 * guarantee rather than merely tidying a report.
 *
 * Deleting the rows was considered and rejected on two grounds:
 *   1. it destroys the audit trail (thousands of build attempts and the
 *      recorded router-mismatch diagnosis that explains the whole incident);
 *   2. it is not safe: `executeCriticalTransaction` does
 *      `repo.find(key) ?? repo.create(key, purpose)`, so a deleted row is
 *      simply recreated at PENDING by any later call with the same key. A
 *      DELETE would re-open the very resumption path a fence closes.
 *
 * ## Why a new failure code
 *
 * Every existing `TxFailureCode` asserts something about the chain
 * (simulation, gas, broadcast, revert, verification) or about an OPENING
 * timeout. Reusing one would make these rows read as failed blockchain
 * transactions, which they are not -- they never produced a transaction at
 * all. `LIFECYCLE_CLOSED` states the actual fact: obsolete because the
 * position's lifecycle ended by another route, before this leg was ever
 * signed. `failureCode` is a nullable TEXT column, so this needs no migration.
 */

/** Statuses at or past which a transaction may already be on the wire (`SIGNED` is persisted BEFORE broadcasting). Never fence one of these. */
export const POSSIBLY_BROADCAST_STATUSES: ReadonlySet<string> = new Set(['SIGNED', 'SENT', 'CONFIRMED']);

/** Already-final rows are left exactly as they are. */
export const TERMINAL_ATTEMPT_STATUSES: ReadonlySet<string> = new Set(['VERIFIED', 'FAILED']);

export type StaleExitSkipReason =
  | 'POSITION_NOT_CLOSED'
  | 'NOT_EXIT_SWAP_LEG'
  | 'ALREADY_TERMINAL'
  | 'POSSIBLY_BROADCAST'
  | 'NONCE_ASSIGNED'
  | 'TX_HASH_PRESENT'
  | 'RAW_TX_PRESENT';

export type StaleExitAttemptDecision = { action: 'FENCE' } | { action: 'SKIP'; reason: StaleExitSkipReason };

/** The one purpose this cleanup may ever touch. */
export const CLEANABLE_PURPOSE = 'exit:swap';

/** Same cap `executeCriticalTransaction` uses for `lastError`. */
export const MAX_LAST_ERROR_LENGTH = 800;

/**
 * The only fields a fencing decision may depend on. Structural on purpose, so
 * both a `TransactionAttemptRecord` and a raw Prisma row satisfy it without a
 * mapping step that could quietly drop one of these safety signals.
 */
export interface StaleExitAttemptView {
  purpose: string;
  status: string;
  nonce: number | null;
  txHash: string | null;
  rawTx: string | null;
}

/** Structural for the same reason as `StaleExitAttemptView`. */
export interface StaleExitPositionView {
  id: string;
  status: string;
  closeReason: string | null;
}

/**
 * Decides whether ONE attempt of ONE position may be fenced. Pure, total, and
 * deliberately ordered so that every "this might have reached the chain"
 * signal is checked independently: a row is fenced only if the lifecycle is
 * over AND the row is a swap leg AND it is non-terminal AND its status is
 * pre-signing AND it holds no nonce, no txHash and no raw signed transaction.
 * Any one of those is enough to refuse.
 */
export function classifyStaleExitAttempt(position: Pick<StaleExitPositionView, 'status'>, attempt: StaleExitAttemptView): StaleExitAttemptDecision {
  if (position.status !== 'CLOSED') return { action: 'SKIP', reason: 'POSITION_NOT_CLOSED' };
  if (attempt.purpose !== CLEANABLE_PURPOSE) return { action: 'SKIP', reason: 'NOT_EXIT_SWAP_LEG' };
  if (TERMINAL_ATTEMPT_STATUSES.has(attempt.status)) return { action: 'SKIP', reason: 'ALREADY_TERMINAL' };
  if (POSSIBLY_BROADCAST_STATUSES.has(attempt.status)) return { action: 'SKIP', reason: 'POSSIBLY_BROADCAST' };
  // Independent of status: any of these means the pipeline got further than
  // the row's status suggests, so the row is not a build-stage leftover.
  if (attempt.nonce !== null) return { action: 'SKIP', reason: 'NONCE_ASSIGNED' };
  if (attempt.txHash !== null) return { action: 'SKIP', reason: 'TX_HASH_PRESENT' };
  if (attempt.rawTx !== null) return { action: 'SKIP', reason: 'RAW_TX_PRESENT' };
  return { action: 'FENCE' };
}

/** The `lastError` written onto a fenced row -- states the fact, never implies a chain failure. */
export function lifecycleClosedReason(position: StaleExitPositionView, attemptCount: number): string {
  return (
    `[LIFECYCLE_CLOSED] position ${position.id} is ${position.status}` +
    (position.closeReason ? ` (${position.closeReason})` : '') +
    ` -- this exit swap leg never reached SIGNED (no nonce, no txHash, no raw transaction) after ${attemptCount} build attempts,` +
    ' so it is obsolete and is fenced terminal. Nothing was ever sent to the chain.'
  );
}
