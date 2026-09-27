/**
 * Authoritative nonce allocation for the executor wallet.
 *
 * ## The hole RPC failover opened
 *
 * `viemTxSteps.getCurrentNonce()` asks the chain for
 * `getTransactionCount({ blockTag: 'pending' })`. Before `rpcTransport.ts`
 * that question always went to ONE provider, so its answer was at least
 * self-consistent. With ordered failover the same question can now be
 * answered by a DIFFERENT provider on the next call -- and `pending` is the
 * one thing providers routinely disagree about, because it depends on that
 * node's own mempool view. Immediately after a broadcast:
 *
 *   - provider A accepted the transaction and reports pending = N + 1;
 *   - provider B has not seen it yet (independent mempool, or it is simply
 *     behind) and still reports pending = N.
 *
 * If the next critical transaction's nonce read lands on B, it allocates N a
 * second time and signs a DIFFERENT payload under it. Only one of the two can
 * ever mine. `ExecutorMutex` cannot prevent this: it serializes the
 * allocate -> sign -> broadcast span so the two never interleave, but a
 * perfectly serialized second caller still gets a stale answer from B.
 * `classifyBroadcastError` then has to disambiguate a "nonce too low"
 * rejection after the fact -- a safety net for a rare event, not a
 * substitute for allocating correctly.
 *
 * ## The rule
 *
 * The chain says where to START looking; local persisted state -- which
 * survives a crash, is shared by every writer on this database, and cannot lag
 * a mempool the way a provider can -- says which values are already taken.
 * Walk up from `chainPendingNonce` and return the first nonce that is neither
 * already SIGNED by us nor RESERVED by another unfinished attempt.
 *
 * That single rule covers every case, with no heuristic about how stale a
 * provider might be:
 *
 *  - provider stale by any amount: the nonces it has not caught up to are
 *    exactly the ones in `signedAtOrAbove`, so they are skipped;
 *  - an attempt that reserved a nonce but has not signed yet still blocks it
 *    (`reserved`), because a reservation is real from the moment it persists;
 *  - an attempt that failed BEFORE signing never appears in either set, so its
 *    nonce is reclaimed -- important, because the chain will sit at that value
 *    forever and allocating above it would leave every later transaction
 *    unmineable behind a hole nothing will ever fill;
 *  - a mined nonce below `chainPendingNonce` is simply never considered.
 *
 * ## Why the walk starts at the chain and not at our own maximum
 *
 * An earlier revision of this file raised the floor to
 * `max(chainPendingNonce, highestSignedNonce + 1)`. That is wrong across an
 * executor IDENTITY change: storage outlives `PRIVATE_KEY`, so after a key
 * rotation the old wallet's rows still name its nonces while the new account
 * starts at 0. The floor became `oldMax + 1` (in this project's own migration,
 * 1610 against a wallet at nonce 0), and that transaction is signed, accepted
 * into a mempool as a far-future nonce, and never mines -- no broadcast error,
 * no revert, nothing to classify. Starting at the chain's own answer and only
 * ever SKIPPING specific taken values makes the rotation a non-event: none of
 * the old wallet's nonces are at or above 0... they are, but they are skipped
 * individually, and a gap of 1609 free values means the walk stops at 0
 * immediately.
 *
 * This function is pure -- no clock, no I/O, no chain access -- so every
 * adversarial provider-disagreement scenario is directly testable.
 */

export interface NonceAllocationInput {
  /** `eth_getTransactionCount(executor, 'pending')`, whichever provider answered. */
  chainPendingNonce: number;
  /**
   * Nonces held by OTHER unfinished attempts (the caller excludes its own
   * row). Any attempt at/after NONCE_ASSIGNED counts: a reservation is real
   * from the moment it is persisted, before anything is signed.
   */
  reserved: readonly number[];
  /**
   * Nonces >= `chainPendingNonce` for which a signed payload exists in storage
   * (`rawTx` persisted), terminal attempts included. Such a nonce is either
   * already mined (and this provider has not caught up) or still in flight --
   * either way it is spent. Values below `chainPendingNonce` are irrelevant and
   * need not be supplied.
   */
  signedAtOrAbove: readonly number[];
}

export interface NonceAllocation {
  nonce: number;
  /**
   * Why the result differs from `chainPendingNonce`, for the operator log.
   * `null` when the chain's answer was taken as-is.
   */
  adjustedBy: 'ALREADY_SIGNED' | 'RESERVED_BY_ANOTHER_ATTEMPT' | null;
  /** How many values the walk skipped -- a steady rise means a provider is lagging badly. */
  skipped: number;
}

function assertNonNegativeInt(value: number, label: string): void {
  if (!Number.isInteger(value) || value < 0) {
    throw new Error(`${label} must be a non-negative integer, got ${String(value)}`);
  }
}

/**
 * Picks the nonce for a brand-new allocation. Never called on resume -- an
 * attempt that already persisted a nonce reuses that exact value, which is
 * what makes a resumed attempt re-sign identical bytes instead of creating a
 * second payload.
 */
export function allocateNonce(input: NonceAllocationInput): NonceAllocation {
  assertNonNegativeInt(input.chainPendingNonce, 'chainPendingNonce');
  for (const nonce of input.reserved) assertNonNegativeInt(nonce, 'reserved nonce');
  for (const nonce of input.signedAtOrAbove) assertNonNegativeInt(nonce, 'signed nonce');

  const signed = new Set(input.signedAtOrAbove);
  const reserved = new Set(input.reserved);
  let candidate = input.chainPendingNonce;
  let hitSigned = false;
  let hitReserved = false;
  // Terminates: both sets are finite, so at most `signed.size + reserved.size`
  // values can be skipped.
  while (signed.has(candidate) || reserved.has(candidate)) {
    if (signed.has(candidate)) hitSigned = true;
    if (reserved.has(candidate)) hitReserved = true;
    candidate += 1;
  }

  const skipped = candidate - input.chainPendingNonce;
  // Reporting preference: a reservation names a specific live attempt, which is
  // the more actionable of the two when both applied.
  const adjustedBy = hitReserved ? 'RESERVED_BY_ANOTHER_ATTEMPT' : hitSigned ? 'ALREADY_SIGNED' : null;
  return { nonce: candidate, adjustedBy, skipped };
}
