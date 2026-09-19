import { TX_ATTEMPT_STATUS_ORDER } from './types';
import type {
  ExecutionResult,
  TransactionAttemptRecord,
  TransactionAttemptRepository,
  TxAttemptStatus,
  TxSafetyDeps,
} from './types';
import { config } from '../config';
import { classifyBroadcastError } from './classifyBroadcastError';
import { isStuckAttempt } from './stuckAttempt';
import { ExecutorLockTimeoutError, withExecutorLock } from './executorMutex';

/**
 * Stuck-transaction incident: which pipeline step an unexpected failure
 * came from. Before this, every throw after NONCE_ASSIGNED fell into one
 * generic catch that neither logged nor persisted the error -- the
 * production attempt sat at NONCE_ASSIGNED with `lastError = null` while
 * being retried every 15s.
 */
export type CriticalStepCode =
  | 'ATTEMPT_BOOKKEEPING_CONFLICT'
  | 'BUILD_FAILED'
  | 'SIMULATE_FAILED'
  | 'GAS_CHECK_FAILED'
  | 'EXECUTOR_BUSY'
  | 'NONCE_FAILED'
  | 'SIGN_TRANSACTION_FAILED'
  | 'SIGNED_CHECKPOINT_PERSIST_FAILED'
  | 'BROADCAST_FAILED'
  | 'BROADCAST_AMBIGUOUS'
  | 'RECEIPT_WAIT_FAILED'
  | 'VERIFICATION_FAILED'
  | 'CHECKPOINT_PERSIST_FAILED';

type Checkpoint = 'BUILD' | 'SIMULATE' | 'GAS_CHECK' | 'EXECUTOR_LOCK' | 'NONCE' | 'SIGN' | 'SIGNED_PERSIST' | 'BROADCAST' | 'RECEIPT_WAIT' | 'VERIFY' | 'PERSIST';

const CHECKPOINT_CODE: Record<Checkpoint, CriticalStepCode> = {
  BUILD: 'BUILD_FAILED',
  SIMULATE: 'SIMULATE_FAILED',
  GAS_CHECK: 'GAS_CHECK_FAILED',
  EXECUTOR_LOCK: 'EXECUTOR_BUSY',
  NONCE: 'NONCE_FAILED',
  SIGN: 'SIGN_TRANSACTION_FAILED',
  SIGNED_PERSIST: 'SIGNED_CHECKPOINT_PERSIST_FAILED',
  BROADCAST: 'BROADCAST_AMBIGUOUS',
  RECEIPT_WAIT: 'RECEIPT_WAIT_FAILED',
  VERIFY: 'VERIFICATION_FAILED',
  PERSIST: 'CHECKPOINT_PERSIST_FAILED',
};

export type CriticalTxLog = (event: string, data: Record<string, unknown>) => void;

export interface ExecuteCriticalTransactionOptions {
  /** Structured warning sink. Defaults to a JSON line on stderr in the app's log format (lands in the service journal). */
  log?: CriticalTxLog;
  /** How long to wait for the executor lock before giving up for this tick. Defaults to `RESUME_CLAIM_FRESHNESS_MS`. */
  lockWaitMs?: number;
}

const defaultLog: CriticalTxLog = (event, data) => {
  console.warn(JSON.stringify({ ts: new Date().toISOString(), level: 'warn', event, ...data }));
};

const MAX_ERROR_LENGTH = 500;

/**
 * Bounded, secret-safe error text for persistence/logging. RPC errors from
 * viem embed the request URL (the provider API key lives in its path) and
 * the request body (for a broadcast: the signed payload) -- neither may be
 * written to the database or the journal.
 */
export function safeErrorMessage(err: unknown): string {
  const raw = err instanceof Error ? `${err.name}: ${err.message}` : String(err);
  return raw
    .replace(/(https?:\/\/[^/\s"'`]+)[^\s"'`]*/gi, '$1/<redacted>')
    .replace(/Request body:[\s\S]*$/i, 'Request body: <redacted>')
    .replace(/0x[0-9a-fA-F]{130,}/g, (m) => `0x<redacted ${(m.length - 2) / 2} bytes>`)
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, MAX_ERROR_LENGTH);
}

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
  options: ExecuteCriticalTransactionOptions = {},
): Promise<ExecutionResult<TVerifyData>> {
  const log = options.log ?? defaultLog;
  const lockWaitMs = options.lockWaitMs ?? config.rules.execution.RESUME_CLAIM_FRESHNESS_MS;
  let checkpoint: Checkpoint = 'BUILD';
  const report = (code: CriticalStepCode, message: string, a: TransactionAttemptRecord | null, extra: Record<string, unknown> = {}): void => {
    log('critical_tx_step_failed', { idempotencyKey, purpose, status: a?.status ?? null, checkpoint, code, error: message, ...extra });
  };
  /** Best-effort: persist `[CODE] message` as lastError without ever throwing (a stale/unreachable DB must not mask the original failure). */
  const persistLastError = async (code: CriticalStepCode, message: string): Promise<TransactionAttemptRecord | null> => {
    try {
      const latest = await repo.find(idempotencyKey);
      if (!latest || latest.status === 'FAILED' || latest.status === 'VERIFIED') return latest;
      return await repo.update(latest.id, { lastError: `[${code}] ${message}`.slice(0, MAX_ERROR_LENGTH) }, latest.version);
    } catch {
      return null;
    }
  };
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
    const message = safeErrorMessage(err);
    const latest = (await repo.find(idempotencyKey)) ?? attempt;
    // A concurrent writer advanced this attempt -- a concurrency signal, not
    // a step failure: logged, not persisted (the row belongs to that writer).
    report('ATTEMPT_BOOKKEEPING_CONFLICT', message, latest);
    return ambiguousFailure(`unexpected error, resume required: ${message}`, latest);
  }

  try {
    checkpoint = 'BUILD';
    if (notYetReached(attempt.status, 'BUILT')) {
      const tx = await deps.buildTransaction();
      attempt = await repo.update(attempt.id, { status: 'BUILT', txRequest: tx }, attempt.version);
    }
    const tx = attempt.txRequest;
    if (!tx) {
      throw new Error('invariant violated: status is past BUILT but txRequest is missing');
    }

    checkpoint = 'SIMULATE';
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

    checkpoint = 'GAS_CHECK';
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
    checkpoint = 'EXECUTOR_LOCK';
    const lockOutcome = await withExecutorLock(async (): Promise<ExecutionResult<TVerifyData> | null> => {
      attempt = (await repo.find(attempt.idempotencyKey)) ?? attempt;

      // Fence re-check (stuck-transaction incident audit): this re-read can
      // observe a TERMINAL row written by another writer while this worker
      // queued for the lock -- above all H3's OPENING_TIMEOUT fence
      // (`expireStaleOpening`). `statusIndex('FAILED')` is -1, so without
      // this check every "not yet reached" test below was TRUE for a FAILED
      // row: a fenced attempt was resurrected -- fresh nonce, signed,
      // broadcast -- for a position already FAILED. Terminal rows are final.
      if (attempt.status === 'FAILED') {
        return definitiveFailure(attempt.lastError ?? 'attempt was finalized FAILED by another writer -- not proceeding', attempt);
      }
      if (attempt.status === 'VERIFIED') {
        return resumeVerified(attempt, deps, repo);
      }

      checkpoint = 'NONCE';
      if (notYetReached(attempt.status, 'NONCE_ASSIGNED')) {
        const nonce = await deps.getNonce();
        attempt = await repo.update(attempt.id, { status: 'NONCE_ASSIGNED', nonce }, attempt.version);
      }
      const lockedNonce = attempt.nonce;
      if (lockedNonce === null) {
        throw new Error('invariant violated: status is past NONCE_ASSIGNED but nonce is missing');
      }

      if (notYetReached(attempt.status, 'SIGNED')) {
        checkpoint = 'SIGN';
        let signed: { raw: `0x${string}`; hash: `0x${string}` };
        try {
          signed = await deps.signTransaction(tx, lockedNonce, gasLimit, gasPrice);
        } catch (err) {
          // Signing is LOCAL computation (viemTxSteps.signTx -- no network):
          // a throw is deterministic, retrying the same inputs cannot help,
          // and no payload was produced or persisted, so nothing can have
          // been broadcast. That is a definitive pre-broadcast fact -- FAILED,
          // with the exact error recorded (the incident retried this forever
          // with lastError = null). The assigned nonce was never used.
          const message = safeErrorMessage(err);
          report('SIGN_TRANSACTION_FAILED', message, attempt, { nonce: lockedNonce });
          attempt = await repo.update(attempt.id, {
            status: 'FAILED',
            failureCode: 'SIGN_TRANSACTION_FAILED',
            lastError: `[SIGN_TRANSACTION_FAILED] ${message}`.slice(0, MAX_ERROR_LENGTH),
          }, attempt.version);
          return definitiveFailure(`signing failed: ${message}`, attempt);
        }
        // A throw here (stale CAS -- another writer moved the row -- or a DB
        // error) loses only an UNPERSISTED signed payload, which therefore
        // was never broadcast: resumable (outer catch). The resume re-signs
        // under the SAME persisted nonce (never a new one).
        checkpoint = 'SIGNED_PERSIST';
        attempt = await repo.update(attempt.id, { status: 'SIGNED', rawTx: signed.raw, txHash: signed.hash }, attempt.version);
      }
      const lockedRawTx = attempt.rawTx;
      const lockedTxHash = attempt.txHash;
      if (!lockedRawTx || !lockedTxHash) {
        throw new Error('invariant violated: status is past SIGNED but rawTx/txHash is missing');
      }

      if (notYetReached(attempt.status, 'SENT')) {
        checkpoint = 'BROADCAST';
        try {
          await deps.broadcastRaw(lockedRawTx);
          attempt = await repo.update(attempt.id, { status: 'SENT' }, attempt.version);
        } catch (err) {
          const message = safeErrorMessage(err);
          const classification = classifyBroadcastError(err instanceof Error ? err.message : String(err));

          if (classification.kind === 'ALREADY_KNOWN') {
            // Our exact payload is already in the mempool -- not a failure.
            attempt = await repo.update(attempt.id, { status: 'SENT' }, attempt.version);
          } else if (classification.kind === 'DEFINITIVE_REJECTED') {
            report('BROADCAST_FAILED', message, attempt, { txHash: lockedTxHash });
            attempt = await repo.update(attempt.id, {
              status: 'FAILED',
              failureCode: 'BROADCAST_REJECTED',
              lastError: safeErrorMessage(classification.reason),
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
              const checkMessage = safeErrorMessage(checkErr);
              report('BROADCAST_AMBIGUOUS', `${message}; receipt check failed: ${checkMessage}`, attempt, { txHash: lockedTxHash });
              attempt = await repo.update(attempt.id, {
                lastError: `[BROADCAST_AMBIGUOUS] broadcast rejected (${message}); receipt check failed too: ${checkMessage}`.slice(0, MAX_ERROR_LENGTH),
              }, attempt.version);
              return ambiguousFailure(`broadcast rejected, receipt check failed, resume required: ${message}`, attempt);
            }
            if (receipt) {
              // It's genuinely ours and already landed -- proceed normally.
              attempt = await repo.update(attempt.id, { status: 'SENT' }, attempt.version);
            } else {
              report('BROADCAST_FAILED', message, attempt, { txHash: lockedTxHash });
              attempt = await repo.update(attempt.id, {
                status: 'FAILED',
                failureCode: 'BROADCAST_REJECTED',
                lastError: `broadcast rejected (${message}) and no receipt found for our own tx hash -- this nonce/payload is dead`.slice(0, MAX_ERROR_LENGTH),
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
              report('BROADCAST_AMBIGUOUS', message, attempt, { txHash: lockedTxHash });
              attempt = await repo.update(attempt.id, { lastError: `[BROADCAST_AMBIGUOUS] broadcast uncertain: ${message}`.slice(0, MAX_ERROR_LENGTH) }, attempt.version);
              return ambiguousFailure(`broadcast uncertain, resume required: ${message}`, attempt);
            }
            if (receipt) {
              // It's actually mined -- proceed normally, never FAILED.
              attempt = await repo.update(attempt.id, { status: 'SENT' }, attempt.version);
            } else {
              report('BROADCAST_AMBIGUOUS', message, attempt, { txHash: lockedTxHash });
              attempt = await repo.update(attempt.id, { lastError: `[BROADCAST_AMBIGUOUS] broadcast uncertain: ${message}`.slice(0, MAX_ERROR_LENGTH) }, attempt.version);
              return ambiguousFailure(`broadcast uncertain, resume required: ${message}`, attempt);
            }
          }
        }
      }
      return null;
    }, { label: idempotencyKey, maxWaitMs: lockWaitMs });
    if (lockOutcome) return lockOutcome;

    const txHash = attempt.txHash;
    if (!txHash) {
      throw new Error('invariant violated: status is past SIGNED but txHash is missing');
    }

    checkpoint = 'RECEIPT_WAIT';
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

    checkpoint = 'VERIFY';
    const verification = await deps.verifyOnChain(txHash, attempt);
    if (!verification.ok) {
      if (verification.resumable === true) {
        // P1 fix: the confirmed transaction's effect is not in doubt -- only
        // a read needed to finish verifying it failed. Marking FAILED here
        // would let callers treat an already-landed transaction as never
        // having happened (the exit flow would revert a burned LP to
        // ACTIVE, or retry an already-filled swap). Status stays CONFIRMED,
        // so the next call with this key skips straight back to this step.
        report('VERIFICATION_FAILED', safeErrorMessage(verification.reason), attempt, { resumable: true });
        attempt = await repo.update(attempt.id, { lastError: verification.reason }, attempt.version);
        return ambiguousFailure(`confirmed on-chain, verification incomplete, resume required: ${verification.reason}`, attempt);
      }
      report('VERIFICATION_FAILED', safeErrorMessage(verification.reason), attempt, { resumable: false });
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
    // Stuck-transaction incident: the failing step is now named, logged and
    // persisted (best-effort) instead of vanishing. Status is still NOT
    // advanced or failed -- every step reaching here is either pre-broadcast
    // and transient, or post-broadcast and therefore ambiguous on-chain.
    const message = safeErrorMessage(err);
    const code: CriticalStepCode = err instanceof ExecutorLockTimeoutError ? 'EXECUTOR_BUSY' : CHECKPOINT_CODE[checkpoint];
    const persisted = await persistLastError(code, message);
    const latest = persisted ?? (await repo.find(idempotencyKey).catch(() => null)) ?? attempt;
    report(code, message, latest, err instanceof ExecutorLockTimeoutError ? { lockHolder: err.holder?.label ?? null } : {});
    return ambiguousFailure(`[${code}] unexpected error, resume required: ${message}`, latest);
  }
}

/** Record helper re-exported for callers that just want a fresh view of an attempt (e.g. a `/status` report). */
export async function getTransactionAttempt(
  idempotencyKey: string,
  repo: TransactionAttemptRepository,
): Promise<TransactionAttemptRecord | null> {
  return repo.find(idempotencyKey);
}
