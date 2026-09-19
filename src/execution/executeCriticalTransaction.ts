import { TX_ATTEMPT_STATUS_ORDER } from './types';
import type {
  ExecutionResult,
  TransactionAttemptRecord,
  TransactionAttemptRepository,
  TxAttemptStatus,
  TxSafetyDeps,
} from './types';
import { classifyBroadcastError } from './classifyBroadcastError';
import { isStuckAttempt } from './stuckAttempt';
import { withExecutorLock } from './executorMutex';

function statusIndex(status: TxAttemptStatus): number {
  const idx = (TX_ATTEMPT_STATUS_ORDER as readonly string[]).indexOf(status);
  return idx; // FAILED is not in the list -> -1, only ever compared as a terminal case handled separately
}

/** True if `current` has not yet reached `target` in the pipeline -- i.e. the work for `target` still needs doing. */
function notYetReached(current: TxAttemptStatus, target: (typeof TX_ATTEMPT_STATUS_ORDER)[number]): boolean {
  return statusIndex(current) < statusIndex(target);
}

function ambiguousFailure(reason: string, attempt: TransactionAttemptRecord): ExecutionResult<never> {
  return { ok: false, reason, resumable: true, stuck: isStuckAttempt(attempt), attempt };
}

function definitiveFailure(reason: string, attempt: TransactionAttemptRecord): ExecutionResult<never> {
  return { ok: false, reason, resumable: false, stuck: false, attempt };
}

/**
 * Handles a cached VERIFIED attempt (the crash-recovery short-circuit).
 *
 * The operation this attempt represents ALREADY SUCCEEDED on-chain -- that
 * is what VERIFIED means. This function's only job is producing the
 * `TVerifyData` payload the caller needs (e.g. `openPosition.ts`'s
 * `mintResult.data.positionTokenId`); it must NEVER fabricate that payload
 * (the historical bug: `undefined as TVerifyData`) and must NEVER
 * downgrade an already-successful operation to FAILED just because the
 * payload isn't immediately available.
 *
 * Normal case: `verifyData` was persisted atomically with `status:
 * 'VERIFIED'` (see the bottom of `executeCriticalTransaction`) -- return
 * it directly, no I/O.
 *
 * Recovery case (a legacy attempt verified before `verifyData` existed, or
 * any other gap): re-run `verifyOnChain` against the already-confirmed
 * `txHash`. This is safe to repeat -- `verifyOnChain` is a read-only
 * on-chain check, never a re-broadcast -- and it is the SAME generic
 * mechanism every `TxSafetyDeps` implementation already provides, so this
 * fix is not specific to mint/openPosition; it protects every current and
 * future caller of this function. If reconstruction itself fails or
 * throws, the result stays `resumable: true` -- never FAILED -- since a
 * VERIFIED attempt already has definitive on-chain proof of success; only
 * our local read-model is temporarily unavailable.
 */
async function resumeVerified<TVerifyData>(
  attempt: TransactionAttemptRecord,
  deps: TxSafetyDeps<TVerifyData>,
  repo: TransactionAttemptRepository,
): Promise<ExecutionResult<TVerifyData>> {
  if (attempt.verifyData !== null && attempt.verifyData !== undefined) {
    return { ok: true, data: attempt.verifyData as TVerifyData, attempt };
  }
  if (!attempt.txHash) {
    // Should be unreachable for any real VERIFIED row (txHash is set at
    // SIGNED, long before VERIFIED) -- but never crash/never fabricate data.
    return ambiguousFailure(
      'VERIFIED attempt is missing both verifyData and txHash -- cannot reconstruct, manual review required',
      attempt,
    );
  }
  try {
    const reverify = await deps.verifyOnChain(attempt.txHash, attempt);
    if (!reverify.ok) {
      return ambiguousFailure(`VERIFIED attempt's data could not be reconstructed yet: ${reverify.reason}`, attempt);
    }
    const updated = await repo.update(attempt.id, { verifyData: reverify.data }, attempt.version);
    return { ok: true, data: reverify.data, attempt: updated };
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    return ambiguousFailure(`VERIFIED attempt's data reconstruction threw, resume required: ${message}`, attempt);
  }
}

/**
 * Orchestrates the mandatory transaction-safety pipeline (spec section
 * 10): Build -> Simulate -> Gas Check -> Nonce Check -> Send -> Wait
 * Receipt -> Verify On-chain -> Update State.
 *
 * Idempotency / crash recovery, the whole point of this function:
 *  - `idempotencyKey` identifies ONE logical operation. Calling this
 *    again with the same key never re-does a step already checkpointed
 *    in storage -- it resumes from the last persisted status.
 *  - A `VERIFIED` attempt returns its cached success immediately (never
 *    re-executes anything for an already-completed operation).
 *  - A `FAILED` attempt returns its cached failure immediately with
 *    `resumable: false` -- a *definitive* failure is never silently
 *    retried by calling this function again; a caller who wants to try
 *    again must start a genuinely new attempt (new idempotencyKey).
 *  - Any other outcome returns `resumable: true` and intentionally does
 *    NOT advance status past the last real checkpoint, so calling this
 *    function again with the same key picks up exactly where it left
 *    off. The only ways to reach `FAILED` are backed by a definitive
 *    on-chain fact, a pre-broadcast check, or a synchronous rejection
 *    from the node that's unambiguous about THIS exact payload (see
 *    `classifyBroadcastError.ts`) -- never a bare network/RPC error.
 *  - The raw signed transaction and its hash are computed and persisted
 *    (status `SIGNED`) BEFORE the network call that broadcasts it, so an
 *    ambiguous broadcast failure always leaves us knowing exactly what
 *    hash to look up on resume, and a synchronous rejection can be
 *    disambiguated against that same hash before being trusted.
 *  - `attemptCount`/`firstAttemptedAt`/`stuck` track how long a
 *    `resumable: true` attempt has been ambiguous -- not to auto-retry
 *    or auto-notify (Telegram stays on-demand-only per spec), purely so
 *    a stuck attempt is queryable instead of indistinguishable from one
 *    that's about to resolve on its own.
 */
export async function executeCriticalTransaction<TVerifyData = unknown>(
  idempotencyKey: string,
  purpose: string,
  deps: TxSafetyDeps<TVerifyData>,
  repo: TransactionAttemptRepository,
): Promise<ExecutionResult<TVerifyData>> {
  // Explicitly typed non-null (rather than inferred from `repo.find`'s
  // nullable return) so TypeScript doesn't re-widen `attempt` to include
  // `null` inside the nested `withExecutorLock` closure below -- a `let`
  // inferred from a nullable initializer loses its narrowed non-null type
  // across closure boundaries even when a human can see it's always set.
  let attempt: TransactionAttemptRecord = (await repo.find(idempotencyKey)) ?? (await repo.create(idempotencyKey, purpose));

  if (attempt.status === 'VERIFIED') {
    return resumeVerified(attempt, deps, repo);
  }
  if (attempt.status === 'FAILED') {
    return definitiveFailure(attempt.lastError ?? 'previously failed', attempt);
  }

  // P1-5 fix: this update sits OUTSIDE the main try/catch below (by
  // original design -- attemptCount/firstAttemptedAt bookkeeping isn't
  // part of the pipeline proper), but it can now throw
  // `StaleTransactionAttemptWriteError` (a concurrent writer -- a
  // genuinely different process sharing this DB -- already advanced this
  // attempt between the `find`/`create` above and here). Given its own
  // try/catch, identical in spirit to the main one below: never let this
  // bookkeeping write crash the caller or fabricate a FAILED verdict --
  // treat it exactly like any other unexpected/ambiguous failure.
  try {
    attempt = await repo.update(attempt.id, {
      attemptCount: attempt.attemptCount + 1,
      firstAttemptedAt: attempt.firstAttemptedAt ?? new Date(),
    }, attempt.version);
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    const latest = (await repo.find(idempotencyKey)) ?? attempt;
    return ambiguousFailure(`unexpected error, resume required: ${message}`, latest);
  }

  try {
    if (notYetReached(attempt.status, 'BUILT')) {
      const tx = await deps.buildTransaction();
      attempt = await repo.update(attempt.id, { status: 'BUILT', txRequest: tx }, attempt.version);
    }
    const tx = attempt.txRequest;
    if (!tx) {
      throw new Error('invariant violated: status is past BUILT but txRequest is missing');
    }

    if (notYetReached(attempt.status, 'SIMULATED')) {
      const sim = await deps.simulate(tx);
      if (!sim.ok) {
        attempt = await repo.update(attempt.id, {
          status: 'FAILED',
          failureCode: 'SIMULATION_REJECTED',
          lastError: sim.reason,
        }, attempt.version);
        return definitiveFailure(sim.reason, attempt);
      }
      attempt = await repo.update(attempt.id, { status: 'SIMULATED' }, attempt.version);
    }

    if (notYetReached(attempt.status, 'GAS_CHECKED')) {
      const gasLimit = await deps.estimateGas(tx);
      const gasPrice = await deps.getGasPrice();
      const gasCheck = await deps.checkGasAffordable(gasLimit, gasPrice);
      if (!gasCheck.ok) {
        attempt = await repo.update(attempt.id, {
          status: 'FAILED',
          failureCode: 'GAS_UNAFFORDABLE',
          lastError: gasCheck.reason,
        }, attempt.version);
        return definitiveFailure(gasCheck.reason, attempt);
      }
      attempt = await repo.update(attempt.id, { status: 'GAS_CHECKED', gasLimit, gasPrice }, attempt.version);
    }
    const gasLimit = attempt.gasLimit;
    const gasPrice = attempt.gasPrice;
    if (gasLimit === null || gasPrice === null) {
      throw new Error('invariant violated: status is past GAS_CHECKED but gasLimit/gasPrice is missing');
    }

    // C7 fix: the entire nonce-assignment -> sign -> broadcast span is
    // serialized process-wide (see executorMutex.ts's doc comment for why
    // -- two independently-scheduled cycles can otherwise both read the
    // same pending nonce and sign different payloads under it). The
    // locked callback re-fetches the freshest persisted `attempt` state
    // FIRST, before deciding what work remains: without this, a second
    // concurrent call for the SAME idempotencyKey that queued behind the
    // lock would act on a stale in-memory snapshot and redundantly
    // re-assign a nonce/re-sign, clobbering the first call's progress.
    const lockOutcome = await withExecutorLock(async (): Promise<ExecutionResult<TVerifyData> | null> => {
      attempt = (await repo.find(attempt.idempotencyKey)) ?? attempt;

      if (notYetReached(attempt.status, 'NONCE_ASSIGNED')) {
        const nonce = await deps.getNonce();
        attempt = await repo.update(attempt.id, { status: 'NONCE_ASSIGNED', nonce }, attempt.version);
      }
      const lockedNonce = attempt.nonce;
      if (lockedNonce === null) {
        throw new Error('invariant violated: status is past NONCE_ASSIGNED but nonce is missing');
      }

      if (notYetReached(attempt.status, 'SIGNED')) {
        const signed = await deps.signTransaction(tx, lockedNonce, gasLimit, gasPrice);
        attempt = await repo.update(attempt.id, { status: 'SIGNED', rawTx: signed.raw, txHash: signed.hash }, attempt.version);
      }
      const lockedRawTx = attempt.rawTx;
      const lockedTxHash = attempt.txHash;
      if (!lockedRawTx || !lockedTxHash) {
        throw new Error('invariant violated: status is past SIGNED but rawTx/txHash is missing');
      }

      if (notYetReached(attempt.status, 'SENT')) {
        try {
          await deps.broadcastRaw(lockedRawTx);
          attempt = await repo.update(attempt.id, { status: 'SENT' }, attempt.version);
        } catch (err) {
          const message = err instanceof Error ? err.message : String(err);
          const classification = classifyBroadcastError(message);

          if (classification.kind === 'ALREADY_KNOWN') {
            // Our exact payload is already in the mempool -- not a failure.
            attempt = await repo.update(attempt.id, { status: 'SENT' }, attempt.version);
          } else if (classification.kind === 'DEFINITIVE_REJECTED') {
            attempt = await repo.update(attempt.id, {
              status: 'FAILED',
              failureCode: 'BROADCAST_REJECTED',
              lastError: classification.reason,
            }, attempt.version);
            return definitiveFailure(classification.reason, attempt);
          } else if (classification.kind === 'POSSIBLY_OURS') {
            // "nonce too low" / "replacement underpriced" -- could mean an
            // unrelated tx consumed this nonce (payload permanently dead)
            // OR our own earlier broadcast of this exact payload already
            // landed. Never guess: check for a receipt under OUR hash.
            let receipt: Awaited<ReturnType<typeof deps.getReceiptIfAvailable>>;
            try {
              receipt = await deps.getReceiptIfAvailable(lockedTxHash);
            } catch (checkErr) {
              // Couldn't even determine that much -- stay ambiguous, don't
              // guess either way.
              const checkMessage = checkErr instanceof Error ? checkErr.message : String(checkErr);
              attempt = await repo.update(attempt.id, {
                lastError: `broadcast rejected (${message}); receipt check failed too: ${checkMessage}`,
              }, attempt.version);
              return ambiguousFailure(`broadcast rejected, receipt check failed, resume required: ${message}`, attempt);
            }
            if (receipt) {
              // It's genuinely ours and already landed -- proceed normally.
              attempt = await repo.update(attempt.id, { status: 'SENT' }, attempt.version);
            } else {
              attempt = await repo.update(attempt.id, {
                status: 'FAILED',
                failureCode: 'BROADCAST_REJECTED',
                lastError: `broadcast rejected (${message}) and no receipt found for our own tx hash -- this nonce/payload is dead`,
              }, attempt.version);
              return definitiveFailure(`broadcast rejected: ${message}`, attempt);
            }
          } else {
            // AMBIGUOUS: unrecognized error -- timeout, connection refused,
            // RPC 5xx, etc. H3 fix: the hash is already known (persisted at
            // SIGNED) -- cheaply check for a receipt under it before giving
            // up the tick, exactly like the POSSIBLY_OURS branch above.
            // Real non-geth "already imported"/transport-flavored messages
            // that don't match a known pattern land here, and the
            // transaction may already be mined even though the broadcast
            // CALL itself errored (e.g. the response was lost after the
            // node accepted it). Never marked FAILED regardless of outcome
            // -- an unfound receipt stays exactly as resumable as before.
            let receipt: Awaited<ReturnType<typeof deps.getReceiptIfAvailable>>;
            try {
              receipt = await deps.getReceiptIfAvailable(lockedTxHash);
            } catch {
              // Couldn't even determine that much -- stay ambiguous, don't guess either way.
              attempt = await repo.update(attempt.id, { lastError: `broadcast uncertain: ${message}` }, attempt.version);
              return ambiguousFailure(`broadcast uncertain, resume required: ${message}`, attempt);
            }
            if (receipt) {
              // It's actually mined -- proceed normally, never FAILED.
              attempt = await repo.update(attempt.id, { status: 'SENT' }, attempt.version);
            } else {
              attempt = await repo.update(attempt.id, { lastError: `broadcast uncertain: ${message}` }, attempt.version);
              return ambiguousFailure(`broadcast uncertain, resume required: ${message}`, attempt);
            }
          }
        }
      }
      return null;
    });
    if (lockOutcome) return lockOutcome;

    const txHash = attempt.txHash;
    if (!txHash) {
      throw new Error('invariant violated: status is past SIGNED but txHash is missing');
    }

    if (notYetReached(attempt.status, 'CONFIRMED')) {
      const receipt = await deps.waitForReceipt(txHash);
      if (receipt.status === 'reverted') {
        attempt = await repo.update(attempt.id, {
          status: 'FAILED',
          failureCode: 'REVERTED',
          lastError: 'transaction reverted on-chain',
        }, attempt.version);
        return definitiveFailure('transaction reverted on-chain', attempt);
      }
      attempt = await repo.update(attempt.id, { status: 'CONFIRMED' }, attempt.version);
    }

    const verification = await deps.verifyOnChain(txHash, attempt);
    if (!verification.ok) {
      if (verification.resumable === true) {
        // P1 fix: the confirmed transaction's effect is not in doubt -- only
        // a read needed to finish verifying it failed. Marking FAILED here
        // would let callers treat an already-landed transaction as never
        // having happened (the exit flow would revert a burned LP to
        // ACTIVE, or retry an already-filled swap). Status stays CONFIRMED,
        // so the next call with this key skips straight back to this step.
        attempt = await repo.update(attempt.id, { lastError: verification.reason }, attempt.version);
        return ambiguousFailure(`confirmed on-chain, verification incomplete, resume required: ${verification.reason}`, attempt);
      }
      attempt = await repo.update(attempt.id, {
        status: 'FAILED',
        failureCode: 'VERIFICATION_FAILED',
        lastError: verification.reason,
      }, attempt.version);
      return definitiveFailure(verification.reason, attempt);
    }
    // Status and verifyData written together in ONE update call so a
    // crash between them is impossible -- the whole point of this fix
    // (see resumeVerified() above for why a status-only write was unsafe).
    attempt = await repo.update(attempt.id, { status: 'VERIFIED', verifyData: verification.data }, attempt.version);
    return { ok: true, data: verification.data, attempt };
  } catch (err) {
    // Any unexpected throw (RPC blip during simulate/estimateGas/wait, a
    // bug, etc.): never mark FAILED here -- that would require deciding
    // "definitively did not happen" without on-chain evidence. Status
    // stays at the last successfully persisted checkpoint; calling this
    // again with the same idempotencyKey resumes.
    const message = err instanceof Error ? err.message : String(err);
    const latest = (await repo.find(idempotencyKey)) ?? attempt;
    return ambiguousFailure(`unexpected error, resume required: ${message}`, latest);
  }
}

/** Record helper re-exported for callers that just want a fresh view of an attempt (e.g. a `/status` report). */
export async function getTransactionAttempt(
  idempotencyKey: string,
  repo: TransactionAttemptRepository,
): Promise<TransactionAttemptRecord | null> {
  return repo.find(idempotencyKey);
}
