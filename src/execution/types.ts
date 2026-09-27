import type { Address } from 'viem';

/**
 * Linear progression through the mandatory transaction-safety pipeline
 * (spec section 10): Build -> Simulate -> Gas Check -> Nonce Check ->
 * Send -> Wait Receipt -> Verify On-chain -> Update State. `SIGNED` is an
 * extra checkpoint not named in the spec, inserted deliberately: the raw
 * signed transaction (and its hash, computed locally, not from a
 * broadcast response) is persisted BEFORE the network call that could
 * fail ambiguously, which is what makes crash recovery possible without
 * ever risking a double-send under a fresh nonce.
 */
export const TX_ATTEMPT_STATUS_ORDER = [
  'PENDING',
  'BUILT',
  'SIMULATED',
  'GAS_CHECKED',
  'NONCE_ASSIGNED',
  'SIGNED',
  'SENT',
  'CONFIRMED',
  'VERIFIED',
] as const;

export type TxAttemptStatus = (typeof TX_ATTEMPT_STATUS_ORDER)[number] | 'FAILED';

/**
 * WHY a FAILED attempt failed -- added per explicit review so the root
 * cause is queryable without parsing `lastError` free text. Distinguishes
 * "rejected before ever touching the network" (SIMULATION_REJECTED,
 * GAS_UNAFFORDABLE) from "the node synchronously refused this exact
 * broadcast" (BROADCAST_REJECTED -- e.g. nonce too low, insufficient
 * funds) from "accepted and mined, but reverted" (REVERTED) from
 * "confirmed on-chain, but the intended business effect wasn't there"
 * (VERIFICATION_FAILED).
 */
export type TxFailureCode =
  | 'SIMULATION_REJECTED'
  | 'GAS_UNAFFORDABLE'
  | 'BROADCAST_REJECTED'
  | 'REVERTED'
  | 'VERIFICATION_FAILED'
  // Stuck-transaction incident: the LOCAL signer threw. Signing is pure
  // computation (no network), so the throw is deterministic and nothing
  // was produced, persisted or broadcast -- a definitive pre-broadcast fact.
  | 'SIGN_TRANSACTION_FAILED'
  /**
   * H3: written ONLY by `PositionRepository.expireStaleOpening` onto an
   * OPENING position's mint attempt that provably never reached SIGNED
   * (nothing was ever broadcast) -- a fence: the CAS/version bump makes
   * any in-flight worker's later SIGNED write fail, so it can never
   * broadcast, and `executeCriticalTransaction` returns this cached
   * definitive failure for the key forever after.
   */
  | 'OPENING_TIMEOUT'
  /**
   * Written ONLY by `PositionRepository.fenceObsoleteExitAttempts` onto an
   * exit leg of an already-CLOSED position that provably never reached SIGNED
   * (no nonce, no txHash, no rawTx). NOT a blockchain failure: no transaction
   * was ever built to completion, let alone sent. It is a fence -- the
   * CAS/version bump plus `executeCriticalTransaction`'s two FAILED checks
   * mean the leg can never be resumed, signed or broadcast afterwards -- and
   * it removes an obsolete row from `findNonTerminal()`'s stuck reporting.
   */
  | 'LIFECYCLE_CLOSED';

export interface TxRequest {
  to: Address;
  data: `0x${string}`;
  value: bigint;
  /**
   * Same-attempt swap race fix: OPTIONAL builder-owned snapshot of the
   * inputs the calldata was built from (e.g. the exit swap's quote-derived
   * minimum output and USDG baseline). Never sent on-chain -- every viem
   * call picks `to`/`data`/`value` explicitly. It rides INSIDE this object
   * precisely so it is persisted by the SAME version-checked
   * `update({ status: 'BUILT', txRequest })` that persists the calldata:
   * whichever worker wins that compare-and-swap owns BOTH, atomically, and
   * a stale worker's snapshot can never be stored next to another
   * worker's calldata. `verifyOnChain` receives the persisted attempt and
   * reads it back from there.
   */
  buildContext?: unknown;
}

export interface TransactionAttemptRecord {
  id: string;
  idempotencyKey: string;
  purpose: string;
  status: TxAttemptStatus;
  txRequest: TxRequest | null;
  gasLimit: bigint | null;
  gasPrice: bigint | null;
  nonce: number | null;
  rawTx: `0x${string}` | null;
  txHash: `0x${string}` | null;
  lastError: string | null;
  /**
   * The verification payload persisted atomically with status VERIFIED --
   * `unknown` at this layer since the repository is generic across every
   * `TVerifyData` shape (mint's `{positionTokenId, liquidity}`, approve's
   * `{allowanceRaw}`, etc.); `executeCriticalTransaction` is what narrows
   * it back to a caller's concrete `TVerifyData`. Null for legacy rows
   * (VERIFIED before this column existed) or attempts with no verify data.
   */
  verifyData: unknown;
  failureCode: TxFailureCode | null;
  /** How many non-short-circuited calls to `executeCriticalTransaction` this attempt has been through. */
  attemptCount: number;
  /** Set on the first non-short-circuited call -- see `stuckAttempt.ts`. */
  firstAttemptedAt: Date | null;
  /**
   * P1-5 fix: optimistic-concurrency version, incremented by exactly 1 on
   * every successful `update()`. Starts at 1 on `create()`. Read by
   * `executeCriticalTransaction.ts` and passed back as `expectedVersion` on
   * every subsequent `update()` call for the SAME in-flight attempt -- see
   * `update()`'s doc comment below for what a mismatch means.
   */
  version: number;
  /**
   * The executor wallet that owns this attempt's nonce. A nonce is only
   * meaningful for one account, and storage outlives `PRIVATE_KEY`: `null`
   * means the row predates executor scoping, i.e. it belongs to a PREVIOUS
   * wallet. Null never matches a current executor, so a key rotation inherits
   * no nonce history.
   */
  executorAddress: string | null;
}

/**
 * P1-5 fix: thrown by `update()` when `expectedVersion` was provided and no
 * longer matches the row's current version -- i.e. a DIFFERENT writer
 * (another process, or a stale in-memory `attempt` snapshot within this
 * one) has already advanced this attempt since the caller last read it.
 * Deliberately a distinct, catchable error type rather than a generic
 * throw: `executeCriticalTransaction.ts` doesn't need to special-case it at
 * all (a plain throw already gets treated as "ambiguous, resume required"
 * by its existing outer catch, which is exactly the correct, safe
 * response), but future callers that DO want to distinguish "genuinely
 * stale" from "some other failure" can catch this specifically.
 */
/**
 * The nonce could not be reserved right now -- the cross-process reservation
 * lock was unavailable (SQLITE_BUSY/timeout), or the database's
 * `(executorAddress, nonce)` unique index rejected the write because another
 * process took that nonce first.
 *
 * Always AMBIGUOUS, never definitive: nothing was signed and no nonce was
 * consumed, so the caller must resume, not fail. Deliberately distinct from
 * `StaleTransactionAttemptWriteError` so contention can be logged as
 * contention rather than looking like a stale-writer bug.
 */
export class NonceReservationUnavailableError extends Error {
  constructor(
    message: string,
    public readonly kind: 'LOCK_CONTENTION' | 'NONCE_TAKEN',
  ) {
    super(message);
    this.name = 'NonceReservationUnavailableError';
  }
}

export class StaleTransactionAttemptWriteError extends Error {
  constructor(id: string, expectedVersion: number) {
    super(`TransactionAttempt ${id} was not at expected version ${expectedVersion} -- a different writer has since updated it`);
    this.name = 'StaleTransactionAttemptWriteError';
  }
}

export interface TransactionAttemptRepository {
  /**
   * The executor identity this repository scopes nonce state to, lowercased
   * (empty string = unscoped, which stores NULL). Exposed so the pipeline can
   * refuse to RE-SIGN an attempt whose nonce was reserved by a different
   * wallet -- see `executeCriticalTransaction`'s executor-ownership fence.
   */
  readonly executorAddress: string;
  find(idempotencyKey: string): Promise<TransactionAttemptRecord | null>;
  create(idempotencyKey: string, purpose: string): Promise<TransactionAttemptRecord>;
  /**
   * P1-5 fix: `expectedVersion`, when provided, makes this a
   * compare-and-swap: the write is applied ONLY if the row's CURRENT
   * `version` still equals `expectedVersion` (i.e. nobody else has written
   * to this attempt since the caller last read it), and the row's
   * `version` is incremented by 1 on success. If the row has since moved
   * to a different version, throws `StaleTransactionAttemptWriteError`
   * instead of silently overwriting a newer state -- this is what prevents
   * a stale worker (a crashed-and-resumed call, a second process) from
   * clobbering progress a NEWER call already persisted (e.g. regressing
   * status from VERIFIED back to an earlier checkpoint, or overwriting a
   * newer `txHash`/`rawTx`). Omitting `expectedVersion` keeps the old
   * unconditional behavior (used only by call sites that have no prior
   * read to pin against, e.g. a one-shot admin/reporting write).
   */
  update(
    id: string,
    patch: Partial<Omit<TransactionAttemptRecord, 'id' | 'idempotencyKey' | 'version'>>,
    expectedVersion?: number,
  ): Promise<TransactionAttemptRecord>;
  /** Every attempt not yet at a terminal status (VERIFIED/FAILED) -- the basis for stuck-attempt queries (e.g. a future `/status` command). */
  findNonTerminal(): Promise<TransactionAttemptRecord[]>;
  /** H2: every attempt whose idempotencyKey starts with any of `prefixes` (empty list -> empty result) -- capital accounting's read of CLOSING positions' exit legs. */
  findByKeyPrefixes(prefixes: readonly string[]): Promise<TransactionAttemptRecord[]>;
  /**
   * Every nonce >= `minNonce` for which a SIGNED payload was persisted
   * (`rawTx` set), terminal attempts included, in ascending order.
   *
   * Nonce allocation's "already spent" set (see `nonceAllocation.ts`): such a
   * nonce is either already mined -- with this RPC provider simply not caught
   * up -- or still in flight. Either way it must be skipped. VERIFIED and
   * FAILED attempts are terminal and therefore invisible to
   * `findNonTerminal()`, which is exactly why this cannot be derived from that
   * query. Bounded by `minNonce` so a long history is never loaded to allocate
   * one nonce.
   */
  findSignedNoncesAtOrAbove(minNonce: number): Promise<number[]>;
  /**
   * Atomically allocates and persists this attempt's nonce, scoped to the
   * repository's executor identity.
   *
   * This is ONE database transaction, not a read followed by a write:
   * `ExecutorMutex` serializes callers inside a single process, but two bot
   * processes sharing this database have no such mutex, and a read-then-write
   * allocation lets both compute the same nonce from the same snapshot. The
   * implementation therefore takes a cross-process write lock before reading
   * (the same technique `PositionRepository` uses for capital), and the
   * database's partial unique index on `(executorAddress, nonce)` is the
   * backstop if anything still races.
   *
   * `chainPendingNonce` is the chain's answer, used only as the starting point
   * -- see `nonceAllocation.ts` for why it is never taken as authoritative.
   *
   * Throws `NonceReservationUnavailableError` when the lock is unavailable or
   * the nonce was taken concurrently: both mean "resume", never "failed".
   * Throws `StaleTransactionAttemptWriteError` if the attempt moved on.
   */
  reserveNonce(input: {
    attemptId: string;
    expectedVersion: number;
    chainPendingNonce: number;
  }): Promise<{
    attempt: TransactionAttemptRecord;
    nonce: number;
    adjustedBy: 'ALREADY_SIGNED' | 'RESERVED_BY_ANOTHER_ATTEMPT' | null;
    skipped: number;
  }>;
}

export type StepResult<TReason extends string = string> = { ok: true } | { ok: false; reason: TReason };

/**
 * Every step is independently injectable specifically so each one's
 * failure mode can be exercised in isolation in tests -- this is the
 * module the spec calls "paling kritis" and explicitly asks for failure
 * simulation at every stage.
 */
export interface TxSafetyDeps<TVerifyData = unknown> {
  buildTransaction: () => Promise<TxRequest>;
  simulate: (tx: TxRequest) => Promise<StepResult>;
  estimateGas: (tx: TxRequest) => Promise<bigint>;
  getGasPrice: () => Promise<bigint>;
  /** Business-level affordability check (e.g. wallet ETH balance vs. estimated cost, optionally minus a reserve). */
  checkGasAffordable: (gasLimit: bigint, gasPrice: bigint) => Promise<StepResult>;
  getNonce: () => Promise<number>;
  /** Signs locally and returns the raw signed tx + its deterministic hash -- never sends anything itself. */
  signTransaction: (
    tx: TxRequest,
    nonce: number,
    gasLimit: bigint,
    gasPrice: bigint,
  ) => Promise<{ raw: `0x${string}`; hash: `0x${string}` }>;
  /**
   * Broadcasts an already-signed raw transaction. Throwing here does NOT
   * automatically mean "uncertain" any more -- `classifyBroadcastError`
   * inspects the message first; only a genuinely unrecognized/network-
   * level error is treated as uncertain. The hash is already persisted
   * regardless, at the `SIGNED` checkpoint.
   */
  broadcastRaw: (raw: `0x${string}`) => Promise<void>;
  waitForReceipt: (hash: `0x${string}`) => Promise<{ status: 'success' | 'reverted'; blockNumber: bigint }>;
  /**
   * A SINGLE, non-blocking check -- returns `null` if no receipt exists
   * yet (never waits/polls). Used only to disambiguate a "nonce too low" /
   * "replacement transaction underpriced" broadcast rejection: those can
   * mean either "an unrelated tx consumed this nonce" (our signed payload
   * is permanently dead) or "our own earlier broadcast of this exact
   * payload already landed" (not a failure at all) -- this is the only
   * way to tell the two apart instead of guessing.
   */
  getReceiptIfAvailable: (
    hash: `0x${string}`,
  ) => Promise<{ status: 'success' | 'reverted'; blockNumber: bigint } | null>;
  /**
   * Caller-specific: did the intended on-chain effect actually happen
   * (e.g. position NFT exists, balance changed)? `confirmedTxHash` is the
   * hash of the transaction that just reached CONFIRMED (the same one
   * persisted at the SIGNED checkpoint) -- added when `positions/mintTx.ts`
   * needed it to discover a newly-minted position's tokenId from the
   * mint transaction's own ERC721 `Transfer` log (there is no other way to
   * learn a tokenId the PositionManager contract itself assigns -- unlike
   * remove-liquidity/swap, which verify against already-known state, a
   * mint's very identity is only knowable from its own receipt).
   * Backward compatible: a `verifyOnChain` that doesn't need it (every
   * existing implementation) simply declares zero parameters and ignores
   * it, since a function accepting fewer parameters than a type provides
   * is fully valid JS/TS.
   *
   * `resumable: true` on a failure means "the transaction's on-chain
   * effect is already proven (or at least not disproven), but a read
   * needed to COMPLETE verification was unavailable" -- e.g. the exit
   * legs' receipt-log proceeds decode hitting an RPC blip after the
   * liquidity-zero / balance-increase check already passed. The pipeline
   * keeps such an attempt at CONFIRMED (never FAILED) and a later call
   * with the same idempotencyKey re-runs ONLY this function -- nothing is
   * rebuilt, re-signed, or re-broadcast. Omitted/false keeps the original
   * meaning: a definitive VERIFICATION_FAILED.
   */
  verifyOnChain: (
    confirmedTxHash: `0x${string}`,
    /**
     * Same-attempt swap race fix: the persisted attempt being verified, so a
     * verifier can check against the exact inputs its OWN calldata was built
     * from (`attempt.txRequest.buildContext`) instead of shared per-position
     * state another worker may have written. Optional -- verifiers that
     * don't need it simply ignore it.
     */
    attempt?: Pick<TransactionAttemptRecord, 'id' | 'txRequest'>,
  ) => Promise<{ ok: true; data: TVerifyData } | { ok: false; reason: string; resumable?: boolean }>;
}

export type ExecutionResult<TVerifyData = unknown> =
  | { ok: true; data: TVerifyData; attempt: TransactionAttemptRecord }
  | {
      ok: false;
      reason: string;
      resumable: boolean;
      /**
       * True when this attempt has crossed the stuck-attempt thresholds
       * (`config.rules.execution`) -- always `false` for a definitive
       * (`resumable: false`) failure, since those are already terminal,
       * not "stuck." NOT a push notification (Telegram stays on-demand-
       * only) -- just a signal the immediate caller can log/surface
       * on-demand without a separate DB query.
       */
      stuck: boolean;
      attempt: TransactionAttemptRecord;
    };
