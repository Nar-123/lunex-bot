import type { PrismaClient } from '@prisma/client';
import { getPrismaClient } from '../storage/prismaClient';
import type {
  TransactionAttemptRecord,
  TransactionAttemptRepository,
  TxAttemptStatus,
  TxFailureCode,
  TxRequest,
} from './types';
import { NonceReservationUnavailableError, StaleTransactionAttemptWriteError } from './types';
import { allocateNonce } from './nonceAllocation';

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
  executorAddress: string | null;
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
    executorAddress: row.executorAddress,
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
 * H2: every attempt whose idempotencyKey starts with one of `prefixes` --
 * used by capital accounting to read a CLOSING position's exit legs
 * (`${closeIdempotencyKey}:removeLiquidity`, `...:swap:N`, `...:approve:N`)
 * in one query. Takes the Prisma client (or an interactive-transaction
 * client) explicitly so `PositionRepository.createIfCapitalAllows` can run
 * the IDENTICAL read inside its CapitalLock transaction. An empty prefix
 * list reads nothing (never "everything").
 */
export async function findAttemptsByKeyPrefixes(
  client: Pick<PrismaClient, 'transactionAttempt'>,
  prefixes: readonly string[],
): Promise<TransactionAttemptRecord[]> {
  if (prefixes.length === 0) return [];
  const rows = await client.transactionAttempt.findMany({
    where: { OR: prefixes.map((prefix) => ({ idempotencyKey: { startsWith: prefix } })) },
  });
  return rows.map(toRecord);
}

/**
 * Persistent (never in-memory-only, per the project's storage principles
 * -- this is the state a crashed process resumes from) backing store for
 * `executeCriticalTransaction`'s idempotency/resume logic.
 */
/** SQLITE_BUSY / Prisma transaction-timeout shapes -- contention, never a verdict. */
function isLockContention(message: string): boolean {
  return /SQLITE_BUSY|database is locked|P2028|Transaction API error|Unable to start a transaction|Transaction already closed|timed out/i.test(
    message,
  );
}

/** The partial unique index on (executorAddress, nonce) rejecting a concurrent claim. */
function isNonceUniqueViolation(message: string): boolean {
  return /UNIQUE constraint failed|P2002/i.test(message) && /nonce|executor/i.test(message);
}

const NONCE_LOCK_ID = 'singleton';
/** Raised from Prisma's 5s default for the same reason PositionRepository raises it: a queued caller genuinely waits. */
const NONCE_TX_TIMEOUT_MS = 20_000;

export class PrismaTransactionAttemptRepository implements TransactionAttemptRepository {
  /**
   * `executorAddress` scopes every nonce decision to one wallet. Stored
   * lowercased so comparisons never depend on checksum casing. It is a
   * constructor argument rather than something this module derives itself so
   * the repository stays free of wallet/RPC imports and a test can pin an
   * identity explicitly.
   */
  private readonly executor: string;

  constructor(
    private readonly prisma: PrismaClient = getPrismaClient(),
    executorAddress?: string,
  ) {
    if (executorAddress !== undefined && executorAddress.trim() === '') {
      throw new Error('executorAddress must be a non-empty address when provided');
    }
    this.executor = (executorAddress ?? '').toLowerCase();
  }

  /** The executor identity every nonce query and reservation is scoped to. */
  get executorAddress(): string {
    return this.executor;
  }

  async find(idempotencyKey: string): Promise<TransactionAttemptRecord | null> {
    const row = await this.prisma.transactionAttempt.findUnique({ where: { idempotencyKey } });
    return row ? toRecord(row) : null;
  }

  async create(idempotencyKey: string, purpose: string): Promise<TransactionAttemptRecord> {
    const row = await this.prisma.transactionAttempt.create({
      data: { idempotencyKey, purpose, status: 'PENDING', executorAddress: this.executor || null },
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

  findByKeyPrefixes(prefixes: readonly string[]): Promise<TransactionAttemptRecord[]> {
    return findAttemptsByKeyPrefixes(this.prisma, prefixes);
  }

  /**
   * Nonce allocation's "already spent" set -- see the interface doc.
   * `rawTx: not null` is the precise predicate: a payload exists for that
   * nonce, so it is mined or in flight. Terminal rows are deliberately
   * included, since a VERIFIED attempt's nonce is the most certainly-spent of
   * all. `gte: minNonce` keeps the read proportional to what the allocator can
   * actually skip rather than to the whole attempt history.
   */
  async findSignedNoncesAtOrAbove(minNonce: number): Promise<number[]> {
    const rows = await this.prisma.transactionAttempt.findMany({
      // Scoped to THIS executor: a previous wallet's signed nonces say nothing
      // about this account, and treating them as spent would push a rotated
      // wallet into a far-future nonce that can never mine.
      where: { executorAddress: this.executor || null, rawTx: { not: null }, nonce: { not: null, gte: minNonce } },
      orderBy: { nonce: 'asc' },
      select: { nonce: true },
    });
    return rows.map((row) => row.nonce as number);
  }

  /**
   * Allocate + persist in ONE transaction -- see the interface doc for why a
   * read followed by a write is not sufficient across processes.
   *
   * Order inside the transaction matters: the `NonceLock` upsert is a real
   * WRITE and runs FIRST, so SQLite escalates to a write lock before the reads
   * below. SQLite's default deferred transaction takes only a shared lock at
   * BEGIN, which two processes may hold simultaneously -- both would then read
   * the same sets and allocate the same nonce. This is the identical technique
   * (and the identical reasoning) as `PositionRepository`'s CapitalLock.
   */
  async reserveNonce(input: { attemptId: string; expectedVersion: number; chainPendingNonce: number }): Promise<{
    attempt: TransactionAttemptRecord;
    nonce: number;
    adjustedBy: 'ALREADY_SIGNED' | 'RESERVED_BY_ANOTHER_ATTEMPT' | null;
    skipped: number;
  }> {
    const executor = this.executor || null;
    try {
      return await this.prisma.$transaction(
        async (tx) => {
          // 1. take the cross-process write lock (first statement, and a write)
          await tx.nonceLock.upsert({
            where: { id: NONCE_LOCK_ID },
            create: { id: NONCE_LOCK_ID, touchedAt: new Date() },
            update: { touchedAt: new Date() },
          });

          // 2. read the spent + reserved sets for THIS executor, inside the lock
          const [signedRows, reservedRows] = await Promise.all([
            tx.transactionAttempt.findMany({
              where: { executorAddress: executor, rawTx: { not: null }, nonce: { not: null, gte: input.chainPendingNonce } },
              select: { nonce: true },
            }),
            tx.transactionAttempt.findMany({
              where: {
                executorAddress: executor,
                nonce: { not: null },
                status: { notIn: ['VERIFIED', 'FAILED'] },
                id: { not: input.attemptId },
              },
              select: { nonce: true },
            }),
          ]);

          // 3. decide (pure), then 4. persist under the same lock and the CAS
          const allocation = allocateNonce({
            chainPendingNonce: input.chainPendingNonce,
            reserved: reservedRows.map((r) => r.nonce as number),
            signedAtOrAbove: signedRows.map((r) => r.nonce as number),
          });
          const result = await tx.transactionAttempt.updateMany({
            where: { id: input.attemptId, version: input.expectedVersion },
            // Stamp the owner alongside the nonce: whichever executor reserves
            // a nonce owns it. Without this, an attempt created under a previous
            // wallet would keep that label while holding a nonce allocated from
            // THIS wallet's view, and the unique index would scope it wrongly.
            data: {
              status: 'NONCE_ASSIGNED',
              nonce: allocation.nonce,
              executorAddress: executor,
              version: { increment: 1 },
            },
          });
          if (result.count === 0) throw new StaleTransactionAttemptWriteError(input.attemptId, input.expectedVersion);
          const row = await tx.transactionAttempt.findUniqueOrThrow({ where: { id: input.attemptId } });
          return { attempt: toRecord(row), nonce: allocation.nonce, adjustedBy: allocation.adjustedBy, skipped: allocation.skipped };
        },
        { timeout: NONCE_TX_TIMEOUT_MS, maxWait: NONCE_TX_TIMEOUT_MS },
      );
    } catch (err) {
      if (err instanceof StaleTransactionAttemptWriteError) throw err;
      const message = err instanceof Error ? err.message : String(err);
      // Both of these mean "somebody else got there first, try again next
      // tick" -- nothing was signed and no nonce was consumed.
      if (isNonceUniqueViolation(message)) {
        throw new NonceReservationUnavailableError(
          `another attempt already holds that nonce for this executor (database rejected the claim): ${message}`,
          'NONCE_TAKEN',
        );
      }
      if (isLockContention(message)) {
        throw new NonceReservationUnavailableError(`nonce reservation lock unavailable: ${message}`, 'LOCK_CONTENTION');
      }
      throw err instanceof Error ? err : new Error(message);
    }
  }

  async findNonTerminal(): Promise<TransactionAttemptRecord[]> {
    const rows = await this.prisma.transactionAttempt.findMany({
      where: { status: { notIn: TERMINAL_STATUSES } },
      orderBy: { firstAttemptedAt: 'asc' },
    });
    return rows.map(toRecord);
  }
}
