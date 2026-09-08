import type { TransactionAttemptRecord, TransactionAttemptRepository } from '../../src/execution/types';

/** In-memory test double -- fast, no DB -- so `executeCriticalTransaction`'s state machine can be tested in isolation. The real Prisma-backed repository has its own dedicated integration test. */
export class InMemoryTransactionAttemptRepository implements TransactionAttemptRepository {
  private byKey = new Map<string, TransactionAttemptRecord>();
  private nextId = 1;

  async find(idempotencyKey: string): Promise<TransactionAttemptRecord | null> {
    return this.byKey.get(idempotencyKey) ?? null;
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
      failureCode: null,
      attemptCount: 0,
      firstAttemptedAt: null,
    };
    this.byKey.set(idempotencyKey, record);
    return record;
  }

  async update(
    id: string,
    patch: Partial<Omit<TransactionAttemptRecord, 'id' | 'idempotencyKey'>>,
  ): Promise<TransactionAttemptRecord> {
    for (const record of this.byKey.values()) {
      if (record.id === id) {
        Object.assign(record, patch);
        return record;
      }
    }
    throw new Error(`no attempt with id ${id}`);
  }

  async findNonTerminal(): Promise<TransactionAttemptRecord[]> {
    return [...this.byKey.values()].filter((r) => r.status !== 'VERIFIED' && r.status !== 'FAILED');
  }

  /** Test helper: how many attempts exist -- used to assert idempotency (no duplicate rows created). */
  size(): number {
    return this.byKey.size;
  }
}
