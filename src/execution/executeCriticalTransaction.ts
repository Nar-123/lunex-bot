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
  let attempt = await repo.find(idempotencyKey);
  if (!attempt) {
    attempt = await repo.create(idempotencyKey, purpose);
  }

  if (attempt.status === 'VERIFIED') {
    return { ok: true, data: undefined as TVerifyData, attempt };
  }
  if (attempt.status === 'FAILED') {
    return definitiveFailure(attempt.lastError ?? 'previously failed', attempt);
  }

  attempt = await repo.update(attempt.id, {
    attemptCount: attempt.attemptCount + 1,
    firstAttemptedAt: attempt.firstAttemptedAt ?? new Date(),
  });

  try {
    if (notYetReached(attempt.status, 'BUILT')) {
      const tx = await deps.buildTransaction();
      attempt = await repo.update(attempt.id, { status: 'BUILT', txRequest: tx });
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
        });
        return definitiveFailure(sim.reason, attempt);
      }
      attempt = await repo.update(attempt.id, { status: 'SIMULATED' });
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
        });
        return definitiveFailure(gasCheck.reason, attempt);
      }
      attempt = await repo.update(attempt.id, { status: 'GAS_CHECKED', gasLimit, gasPrice });
    }
    const gasLimit = attempt.gasLimit;
    const gasPrice = attempt.gasPrice;
    if (gasLimit === null || gasPrice === null) {
      throw new Error('invariant violated: status is past GAS_CHECKED but gasLimit/gasPrice is missing');
    }

    if (notYetReached(attempt.status, 'NONCE_ASSIGNED')) {
      const nonce = await deps.getNonce();
      attempt = await repo.update(attempt.id, { status: 'NONCE_ASSIGNED', nonce });
    }
    const nonce = attempt.nonce;
    if (nonce === null) {
      throw new Error('invariant violated: status is past NONCE_ASSIGNED but nonce is missing');
    }

    if (notYetReached(attempt.status, 'SIGNED')) {
      const signed = await deps.signTransaction(tx, nonce, gasLimit, gasPrice);
      attempt = await repo.update(attempt.id, { status: 'SIGNED', rawTx: signed.raw, txHash: signed.hash });
    }
    const rawTx = attempt.rawTx;
    const txHash = attempt.txHash;
    if (!rawTx || !txHash) {
      throw new Error('invariant violated: status is past SIGNED but rawTx/txHash is missing');
    }

    if (notYetReached(attempt.status, 'SENT')) {
      try {
        await deps.broadcastRaw(rawTx);
        attempt = await repo.update(attempt.id, { status: 'SENT' });
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        const classification = classifyBroadcastError(message);

        if (classification.kind === 'ALREADY_KNOWN') {
          // Our exact payload is already in the mempool -- not a failure.
          attempt = await repo.update(attempt.id, { status: 'SENT' });
        } else if (classification.kind === 'DEFINITIVE_REJECTED') {
          attempt = await repo.update(attempt.id, {
            status: 'FAILED',
            failureCode: 'BROADCAST_REJECTED',
            lastError: classification.reason,
          });
          return definitiveFailure(classification.reason, attempt);
        } else if (classification.kind === 'POSSIBLY_OURS') {
          // "nonce too low" / "replacement underpriced" -- could mean an
          // unrelated tx consumed this nonce (payload permanently dead)
          // OR our own earlier broadcast of this exact payload already
          // landed. Never guess: check for a receipt under OUR hash.
          let receipt: Awaited<ReturnType<typeof deps.getReceiptIfAvailable>>;
          try {
            receipt = await deps.getReceiptIfAvailable(txHash);
          } catch (checkErr) {
            // Couldn't even determine that much -- stay ambiguous, don't
            // guess either way.
            const checkMessage = checkErr instanceof Error ? checkErr.message : String(checkErr);
            attempt = await repo.update(attempt.id, {
              lastError: `broadcast rejected (${message}); receipt check failed too: ${checkMessage}`,
            });
            return ambiguousFailure(`broadcast rejected, receipt check failed, resume required: ${message}`, attempt);
          }
          if (receipt) {
            // It's genuinely ours and already landed -- proceed normally.
            attempt = await repo.update(attempt.id, { status: 'SENT' });
          } else {
            attempt = await repo.update(attempt.id, {
              status: 'FAILED',
              failureCode: 'BROADCAST_REJECTED',
              lastError: `broadcast rejected (${message}) and no receipt found for our own tx hash -- this nonce/payload is dead`,
            });
            return definitiveFailure(`broadcast rejected: ${message}`, attempt);
          }
        } else {
          // AMBIGUOUS: unrecognized error -- timeout, connection refused,
          // RPC 5xx, etc. Never marked FAILED; hash/rawTx already
          // persisted at SIGNED, so resume can retry broadcast safely.
          attempt = await repo.update(attempt.id, { lastError: `broadcast uncertain: ${message}` });
          return ambiguousFailure(`broadcast uncertain, resume required: ${message}`, attempt);
        }
      }
    }

    if (notYetReached(attempt.status, 'CONFIRMED')) {
      const receipt = await deps.waitForReceipt(txHash);
      if (receipt.status === 'reverted') {
        attempt = await repo.update(attempt.id, {
          status: 'FAILED',
          failureCode: 'REVERTED',
          lastError: 'transaction reverted on-chain',
        });
        return definitiveFailure('transaction reverted on-chain', attempt);
      }
      attempt = await repo.update(attempt.id, { status: 'CONFIRMED' });
    }

    const verification = await deps.verifyOnChain(txHash);
    if (!verification.ok) {
      attempt = await repo.update(attempt.id, {
        status: 'FAILED',
        failureCode: 'VERIFICATION_FAILED',
        lastError: verification.reason,
      });
      return definitiveFailure(verification.reason, attempt);
    }
    attempt = await repo.update(attempt.id, { status: 'VERIFIED' });
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
