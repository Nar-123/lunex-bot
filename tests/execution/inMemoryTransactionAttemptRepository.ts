import type { TransactionAttemptRecord, TransactionAttemptRepository } from '../../src/execution/types';
import { NonceReservationUnavailableError, StaleTransactionAttemptWriteError } from '../../src/execution/types';
import { allocateNonce } from '../../src/execution/nonceAllocation';

/** In-memory test double -- fast, no DB -- so `executeCriticalTransaction`'s state machine can be tested in isolation. The real Prisma-backed repository has its own dedicated integration test. */
export class InMemoryTransactionAttemptRepository implements TransactionAttemptRepository {
  private byKey = new Map<string, TransactionAttemptRecord>();
  private nextId = 1;
  private readonly executor: string;

  /** Defaults to the unscoped identity (stored as null), matching the real repository's default. */
  constructor(executorAddress = '') {
    this.executor = executorAddress.toLowerCase();
  }

  get executorAddress(): string {
    return this.executor;
  }

  // H3: every read/write returns a COPY, exactly like the real Prisma
  // repository (a fresh object per query). Returning the stored object
  // itself let a caller's "snapshot" silently mutate when ANOTHER writer
  // updated the row, which made the P1-5 version check vacuous in tests --
  // the stale snapshot always carried the new version.
  async find(idempotencyKey: string): Promise<TransactionAttemptRecord | null> {
    const record = this.byKey.get(idempotencyKey);
    return record ? { ...record } : null;
  }

  async create(idempotencyKey: string, purpose: string): Promise<TransactionAttemptRecord> {
    const record: TransactionAttemptRecord = {
      id: String(this.nextId++),
      idempotencyKey,
      purpose,
      status: 'PENDING',
      txRequest: null,
      gasLimit: null,
      gasPrice: null,
      nonce: null,
      rawTx: null,
      txHash: null,
      lastError: null,
      verifyData: null,
      failureCode: null,
      attemptCount: 0,
      firstAttemptedAt: null,
      version: 1,
      executorAddress: this.executor || null,
    };
    this.byKey.set(idempotencyKey, record);
    return { ...record };
  }

  async update(
    id: string,
    patch: Partial<Omit<TransactionAttemptRecord, 'id' | 'idempotencyKey' | 'version'>>,
    expectedVersion?: number,
  ): Promise<TransactionAttemptRecord> {
    for (const record of this.byKey.values()) {
      if (record.id === id) {
        // P1-5 fix: mirrors the real repository's conditional-update
        // semantics -- a stale `expectedVersion` throws instead of
        // silently applying the patch over a newer state.
        if (expectedVersion !== undefined && record.version !== expectedVersion) {
          throw new StaleTransactionAttemptWriteError(id, expectedVersion);
        }
        Object.assign(record, patch);
        record.version += 1;
        return { ...record };
      }
    }
    throw new Error(`no attempt with id ${id}`);
  }

  async findNonTerminal(): Promise<TransactionAttemptRecord[]> {
    return [...this.byKey.values()].filter((r) => r.status !== 'VERIFIED' && r.status !== 'FAILED');
  }

  /** Mirrors the real repository: nonces >= minNonce on rows with a persisted signed payload, terminal rows included, ascending, scoped to this executor. */
  async findSignedNoncesAtOrAbove(minNonce: number): Promise<number[]> {
    return [...this.byKey.values()]
      .filter((r) => this.ownedByExecutor(r) && r.rawTx !== null && r.nonce !== null && r.nonce >= minNonce)
      .map((r) => r.nonce as number)
      .sort((a, b) => a - b);
  }

  private ownedByExecutor(r: TransactionAttemptRecord): boolean {
    return (r.executorAddress ?? null) === (this.executor || null);
  }

  /**
   * Mirrors `PrismaTransactionAttemptRepository.reserveNonce`, including the
   * partial unique index on `(executorAddress, nonce)`: a row that is neither
   * terminal-unsigned nor owned by another executor blocks the nonce, and a
   * violation surfaces as NONCE_TAKEN rather than a silent overwrite.
   *
   * The real atomicity comes from a database write lock; here the whole method
   * is synchronous between awaits, which is the in-process equivalent.
   */
  async reserveNonce(input: { attemptId: string; expectedVersion: number; chainPendingNonce: number }): Promise<{
    attempt: TransactionAttemptRecord;
    nonce: number;
    adjustedBy: 'ALREADY_SIGNED' | 'RESERVED_BY_ANOTHER_ATTEMPT' | null;
    skipped: number;
  }> {
    const mine = [...this.byKey.values()].filter((r) => this.ownedByExecutor(r));
    const signedAtOrAbove = mine
      .filter((r) => r.rawTx !== null && r.nonce !== null && r.nonce >= input.chainPendingNonce)
      .map((r) => r.nonce as number);
    const reserved = mine
      .filter((r) => r.id !== input.attemptId && r.nonce !== null && r.status !== 'VERIFIED' && r.status !== 'FAILED')
      .map((r) => r.nonce as number);
    const allocation = allocateNonce({ chainPendingNonce: input.chainPendingNonce, reserved, signedAtOrAbove });

    // The database's partial unique index, restated: a nonce is claimable only
    // if no other row of this executor holds it outside the reclaimable case
    // (FAILED before signing).
    const clash = mine.find(
      (r) =>
        r.id !== input.attemptId &&
        r.nonce === allocation.nonce &&
        !(r.status === 'FAILED' && r.rawTx === null),
    );
    if (clash) {
      throw new NonceReservationUnavailableError(
        `UNIQUE constraint failed: TransactionAttempt.executorAddress, TransactionAttempt.nonce (${allocation.nonce} held by ${clash.idempotencyKey})`,
        'NONCE_TAKEN',
      );
    }

    const record = [...this.byKey.values()].find((r) => r.id === input.attemptId);
    if (!record) throw new Error(`no attempt with id ${input.attemptId}`);
    if (record.version !== input.expectedVersion) {
      throw new StaleTransactionAttemptWriteError(input.attemptId, input.expectedVersion);
    }
    record.status = 'NONCE_ASSIGNED';
    record.nonce = allocation.nonce;
    record.executorAddress = this.executor || null; // the reserving executor owns the nonce
    record.version += 1;
    return { attempt: { ...record }, nonce: allocation.nonce, adjustedBy: allocation.adjustedBy, skipped: allocation.skipped };
  }

  async findByKeyPrefixes(prefixes: readonly string[]): Promise<TransactionAttemptRecord[]> {
    if (prefixes.length === 0) return [];
    return [...this.byKey.values()].filter((r) => prefixes.some((p) => r.idempotencyKey.startsWith(p))).map((r) => ({ ...r }));
  }

  /** Test helper: how many attempts exist -- used to assert idempotency (no duplicate rows created). */
  size(): number {
    return this.byKey.size;
  }
}
