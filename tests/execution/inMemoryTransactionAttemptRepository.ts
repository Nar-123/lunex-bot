import type { TransactionAttemptRecord, TransactionAttemptRepository } from '../../src/execution/types';
import { StaleTransactionAttemptWriteError } from '../../src/execution/types';

/** In-memory test double -- fast, no DB -- so `executeCriticalTransaction`'s state machine can be tested in isolation. The real Prisma-backed repository has its own dedicated integration test. */
export class InMemoryTransactionAttemptRepository implements TransactionAttemptRepository {
  private byKey = new Map<string, TransactionAttemptRecord>();
  private nextId = 1;

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

  async findByKeyPrefixes(prefixes: readonly string[]): Promise<TransactionAttemptRecord[]> {
    if (prefixes.length === 0) return [];
    return [...this.byKey.values()].filter((r) => prefixes.some((p) => r.idempotencyKey.startsWith(p))).map((r) => ({ ...r }));
  }

  /** Test helper: how many attempts exist -- used to assert idempotency (no duplicate rows created). */
  size(): number {
    return this.byKey.size;
  }
}
