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
  | 'VERIFICATION_FAILED';

export interface TxRequest {
  to: Address;
  data: `0x${string}`;
  value: bigint;
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
export class StaleTransactionAttemptWriteError extends Error {
  constructor(id: string, expectedVersion: number) {
    super(`TransactionAttempt ${id} was not at expected version ${expectedVersion} -- a different writer has since updated it`);
    this.name = 'StaleTransactionAttemptWriteError';
  }
}

export interface TransactionAttemptRepository {
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
