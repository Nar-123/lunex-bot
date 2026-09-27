import { redactSecrets } from './redactError';
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
  | 'EXECUTOR_MISMATCH'
  | 'SIGN_TRANSACTION_FAILED'
  | 'SIGNED_CHECKPOINT_PERSIST_FAILED'
  | 'BROADCAST_FAILED'
  | 'BROADCAST_AMBIGUOUS'
  | 'BROADCAST_REJECTED_FEE_TOO_LOW'
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

const MAX_ERROR_LENGTH = 800; // room for viem's short message + the provider Details line

/**
 * Bounded, secret-safe error text for persistence/logging. RPC errors from
 * viem embed the request URL (the provider API key lives in its path) and
 * the request body (for a broadcast: the signed payload) -- neither may be
 * written to the database or the journal. The provider's own `Details:` text
 * (the real cause) and its JSON-RPC code ARE kept -- see `redactError.ts`.
 */
export function safeErrorMessage(err: unknown): string {
  // viem's RpcError carries the provider's JSON-RPC code (e.g. -32000); keep it.
  const rpcCode = err instanceof Error ? (err as Error & { code?: unknown }).code : undefined;
  const code = typeof rpcCode === 'number' ? ` [code ${String(rpcCode)}]` : '';
  const raw = err instanceof Error ? `${err.name}${code}: ${err.message}` : String(err);
  return redactSecrets(raw)
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
  let attempt: TransactionAttemptRecord;
  const existing = await repo.find(idempotencyKey);
  if (existing) {
    attempt = existing;
  } else {
    try {
      attempt = await repo.create(idempotencyKey, purpose);
    } catch (err) {
      // Same-key race across PROCESSES: two workers can both see `find` return
      // null, and only one `create` can win -- `idempotencyKey` is unique, so
      // the loser's insert is rejected. That rejection is not a failure of the
      // OPERATION, it is proof the operation already has a row: re-read it and
      // resume that one. Anything else would either create a second attempt for
      // one logical operation (defeating the whole idempotency contract, and
      // able to produce two payloads) or report a FAILED verdict for a
      // transaction nothing has even tried yet.
      //
      // Deliberately not matched against a Prisma error code: the test is
      // "does the row exist now?", which is the fact that actually decides.
      // If it does not, the create failed for a real reason and that error
      // propagates unchanged.
      const raced = await repo.find(idempotencyKey);
      if (!raced) throw err instanceof Error ? err : new Error(String(err));
      log('attempt_create_raced', {
        idempotencyKey,
        purpose,
        resumedExistingId: raced.id,
        resumedStatus: raced.status,
        createError: safeErrorMessage(err),
      });
      attempt = raced;
    }
  }

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
        // RPC-failover fix: the chain's `pending` count is a FLOOR, not the
        // answer. Ordered failover means consecutive nonce reads can be
        // served by different providers, and `pending` is precisely what
        // providers disagree about right after a broadcast -- one has the
        // transaction in its mempool, the next does not. Persisted local
        // state (crash-durable, shared by every writer on this database, and
        // unable to lag a mempool) decides the rest. See
        // `nonceAllocation.ts`. A throw from any of these three reads lands
        // in this same NONCE checkpoint: nothing is persisted, no nonce is
        // consumed, and the outer catch keeps the attempt resumable -- never
        // FAILED just because one provider was unreachable or stale.
        const chainPendingNonce = await deps.getNonce();
        // Allocate AND persist in one database transaction, scoped to the
        // current executor. `ExecutorMutex` (above) serializes callers inside
        // THIS process; it cannot serialize a second bot process sharing this
        // database, and a read-then-write allocation would let both compute the
        // same nonce from the same snapshot. The repository takes a
        // cross-process write lock and the DB's partial unique index on
        // (executorAddress, nonce) is the backstop.
        const reservation = await repo.reserveNonce({
          attemptId: attempt.id,
          expectedVersion: attempt.version,
          chainPendingNonce,
        });
        attempt = reservation.attempt;
        if (reservation.adjustedBy !== null) {
          // Not an error: the expected, designed outcome when a provider is
          // stale or another attempt still holds a nonce. Logged because a
          // persistent stream of these says a provider is lagging badly.
          log('nonce_allocation_adjusted', {
            idempotencyKey,
            purpose,
            chainPendingNonce,
            allocatedNonce: reservation.nonce,
            adjustedBy: reservation.adjustedBy,
            skipped: reservation.skipped,
          });
        }
      }
      const lockedNonce = attempt.nonce;
      if (lockedNonce === null) {
        throw new Error('invariant violated: status is past NONCE_ASSIGNED but nonce is missing');
      }

      // EXECUTOR-OWNERSHIP FENCE.
      //
      // Invariant: a nonce is owned by the executor that RESERVED it, and an
      // attempt is never re-signed under a different wallet.
      //
      // `find(idempotencyKey)` is deliberately not executor-scoped -- the key is
      // globally unique and a terminal attempt's cached result must be readable
      // whoever asks. But that means a rotation (`PRIVATE_KEY` replaced) leaves
      // older non-terminal attempts reachable, and re-signing one would produce
      // a payload from the NEW key carrying the OLD wallet's nonce. On a fresh
      // account that nonce is far in the future: a node accepts it into the
      // mempool and it never mines -- no broadcast error, no revert, nothing to
      // classify. The quietest possible failure, so it is refused here.
      //
      // Only RE-SIGNING is fenced. An attempt already past SIGNED carries a
      // payload the owning executor produced and may legitimately still be in
      // flight; re-broadcasting those exact bytes and verifying them uses no key
      // at all, so crash recovery for the previous wallet's transaction is
      // preserved. Resume under the SAME executor is untouched.
      if (notYetReached(attempt.status, 'SIGNED') && attempt.nonce !== null) {
        const owner = attempt.executorAddress ?? null;
        const current = repo.executorAddress || null;
        if (owner !== current) {
          const message =
            `attempt holds nonce ${lockedNonce} reserved by executor ${owner ?? 'unknown/legacy'}, ` +
            `but this process signs as ${current ?? 'unknown'} -- refusing to re-sign another wallet's nonce. ` +
            'Retire this attempt (new idempotencyKey) instead of resuming it.';
          report('EXECUTOR_MISMATCH', message, attempt, { nonce: lockedNonce, owner, current });
          // Resumable, never FAILED: this is an ownership/configuration fact, not
          // a verdict about the transaction. It surfaces through the existing
          // stuck-attempt reporting so an operator decides what to retire.
          return ambiguousFailure(message, attempt);
        }
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
          } else if (classification.kind === 'FEE_TOO_LOW') {
            // Deterministic node-side rejection: "max fee per gas less than
            // block base fee". THIS broadcast was not accepted -- but an
            // EARLIER broadcast of these exact bytes may have been, so the
            // receipt under our own hash is still checked first. Otherwise
            // the attempt stays SIGNED with the SAME payload (same nonce,
            // same hash): the next tick re-broadcasts identical bytes, which
            // the node accepts once the base fee is back under the signed
            // price. Never FAILED (the payload is not dead), never re-signed
            // (that would create a second payload for this nonce).
            let receipt: Awaited<ReturnType<typeof deps.getReceiptIfAvailable>> = null;
            try {
              receipt = await deps.getReceiptIfAvailable(lockedTxHash);
            } catch {
              // Receipt lookup failed: the rejection itself is still known -- stay resumable with the specific code.
            }
            if (receipt) {
              attempt = await repo.update(attempt.id, { status: 'SENT' }, attempt.version);
            } else {
              report('BROADCAST_REJECTED_FEE_TOO_LOW', message, attempt, { txHash: lockedTxHash, signedGasPrice: gasPrice.toString(), retry: 'same-signed-bytes' });
              attempt = await repo.update(attempt.id, {
                lastError: `[BROADCAST_REJECTED_FEE_TOO_LOW] rejected by node (not accepted); same signed tx re-broadcast next tick: ${message}`.slice(0, MAX_ERROR_LENGTH),
              }, attempt.version);
              return ambiguousFailure(`broadcast rejected: fee below current base fee -- same signed transaction retried next tick: ${message}`, attempt);
            }
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
