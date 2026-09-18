import type { PrismaClient } from '@prisma/client';
import { getPrismaClient } from '../storage/prismaClient';
import type {
  TransactionAttemptRecord,
  TransactionAttemptRepository,
  TxAttemptStatus,
  TxFailureCode,
  TxRequest,
} from './types';
import { StaleTransactionAttemptWriteError } from './types';

interface PrismaRow {
  id: string;
  idempotencyKey: string;
  purpose: string;
  status: string;
  txRequest: string | null;
  gasLimit: bigint | null;
  gasPrice: bigint | null;
  nonce: number | null;
  rawTx: string | null;
  txHash: string | null;
  lastError: string | null;
  verifyData: string | null;
  failureCode: string | null;
  attemptCount: number;
  firstAttemptedAt: Date | null;
  version: number;
}

function toRecord(row: PrismaRow): TransactionAttemptRecord {
  return {
    id: row.id,
    idempotencyKey: row.idempotencyKey,
    purpose: row.purpose,
    status: row.status as TxAttemptStatus,
    txRequest: row.txRequest ? (JSON.parse(row.txRequest, jsonReviver) as TxRequest) : null,
    gasLimit: row.gasLimit,
    gasPrice: row.gasPrice,
    nonce: row.nonce,
    rawTx: (row.rawTx as `0x${string}` | null) ?? null,
    txHash: (row.txHash as `0x${string}` | null) ?? null,
    lastError: row.lastError,
    verifyData: row.verifyData !== null ? (JSON.parse(row.verifyData, jsonReviver) as unknown) : null,
    failureCode: row.failureCode as TxFailureCode | null,
    attemptCount: row.attemptCount,
    firstAttemptedAt: row.firstAttemptedAt,
    version: row.version,
  };
}

/** `TxRequest.value` is a bigint -- JSON has no bigint literal, so it's round-tripped as a tagged string. */
function jsonReplacer(_key: string, value: unknown): unknown {
  return typeof value === 'bigint' ? `bigint:${value.toString()}` : value;
}
function jsonReviver(_key: string, value: unknown): unknown {
  return typeof value === 'string' && value.startsWith('bigint:') ? BigInt(value.slice('bigint:'.length)) : value;
}

const TERMINAL_STATUSES = ['VERIFIED', 'FAILED'];

/**
 * Persistent (never in-memory-only, per the project's storage principles
 * -- this is the state a crashed process resumes from) backing store for
 * `executeCriticalTransaction`'s idempotency/resume logic.
 */
export class PrismaTransactionAttemptRepository implements TransactionAttemptRepository {
  constructor(private readonly prisma: PrismaClient = getPrismaClient()) {}

  async find(idempotencyKey: string): Promise<TransactionAttemptRecord | null> {
    const row = await this.prisma.transactionAttempt.findUnique({ where: { idempotencyKey } });
    return row ? toRecord(row) : null;
  }

  async create(idempotencyKey: string, purpose: string): Promise<TransactionAttemptRecord> {
    const row = await this.prisma.transactionAttempt.create({
      data: { idempotencyKey, purpose, status: 'PENDING' },
    });
    return toRecord(row);
  }

  async update(
    id: string,
    patch: Partial<Omit<TransactionAttemptRecord, 'id' | 'idempotencyKey' | 'version'>>,
    expectedVersion?: number,
  ): Promise<TransactionAttemptRecord> {
    const data = {
      ...(patch.purpose !== undefined && { purpose: patch.purpose }),
      ...(patch.status !== undefined && { status: patch.status }),
      ...(patch.txRequest !== undefined && { txRequest: JSON.stringify(patch.txRequest, jsonReplacer) }),
      ...(patch.gasLimit !== undefined && { gasLimit: patch.gasLimit }),
      ...(patch.gasPrice !== undefined && { gasPrice: patch.gasPrice }),
      ...(patch.nonce !== undefined && { nonce: patch.nonce }),
      ...(patch.rawTx !== undefined && { rawTx: patch.rawTx }),
      ...(patch.txHash !== undefined && { txHash: patch.txHash }),
      ...(patch.lastError !== undefined && { lastError: patch.lastError }),
      ...(patch.verifyData !== undefined && {
        verifyData: patch.verifyData === null ? null : JSON.stringify(patch.verifyData, jsonReplacer),
      }),
      ...(patch.failureCode !== undefined && { failureCode: patch.failureCode }),
      ...(patch.attemptCount !== undefined && { attemptCount: patch.attemptCount }),
      ...(patch.firstAttemptedAt !== undefined && { firstAttemptedAt: patch.firstAttemptedAt }),
    };

    if (expectedVersion === undefined) {
      // No prior read to pin against -- unconditional, same as before P1-5.
      const row = await this.prisma.transactionAttempt.update({ where: { id }, data: { ...data, version: { increment: 1 } } });
      return toRecord(row);
    }

    // P1-5 fix: a single conditional UPDATE -- the WHERE clause (id AND
    // CURRENT version matches what the caller last read) and the SET
    // (apply the patch AND bump version) are evaluated and applied by the
    // database as one atomic operation, so a stale writer's conditional
    // update simply matches ZERO rows instead of clobbering a newer one.
    const result = await this.prisma.transactionAttempt.updateMany({
      where: { id, version: expectedVersion },
      data: { ...data, version: { increment: 1 } },
    });
    if (result.count === 0) {
      throw new StaleTransactionAttemptWriteError(id, expectedVersion);
    }
    const row = await this.prisma.transactionAttempt.findUniqueOrThrow({ where: { id } });
    return toRecord(row);
  }

  async findNonTerminal(): Promise<TransactionAttemptRecord[]> {
    const rows = await this.prisma.transactionAttempt.findMany({
      where: { status: { notIn: TERMINAL_STATUSES } },
      orderBy: { firstAttemptedAt: 'asc' },
    });
    return rows.map(toRecord);
  }
}
