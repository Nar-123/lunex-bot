import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { Address } from 'viem';
import { execSync } from 'node:child_process';
import { existsSync, rmSync } from 'node:fs';
import path from 'node:path';
import { PrismaClient } from '@prisma/client';
import { PrismaBetterSqlite3 } from '@prisma/adapter-better-sqlite3';
import { PrismaPositionRepository } from '../../src/positions/positionRepository';
import { PrismaTransactionAttemptRepository } from '../../src/execution/transactionAttemptRepository';
import { makeCreateInput } from './fixtures';

/**
 * The production maintenance path, against a REAL SQLite database created by
 * the REAL migrations -- because that is the code that will touch production,
 * and because the guards that matter most (the version+null-field CAS in the
 * UPDATE's WHERE clause, and the all-or-nothing transaction) exist only in the
 * Prisma implementation and cannot be exercised through the in-memory double.
 */

const PROJECT_ROOT = path.resolve(__dirname, '../..');
const TEST_DB_PATH = path.resolve(PROJECT_ROOT, 'data', 'test-fence-obsolete.db');
const TEST_DB_URL = `file:${TEST_DB_PATH}`;

function cleanupDbFiles(): void {
  for (const suffix of ['', '-journal', '-wal', '-shm']) {
    const file = TEST_DB_PATH + suffix;
    if (existsSync(file)) rmSync(file);
  }
}

let prisma: PrismaClient;
let repo: PrismaPositionRepository;
let attempts: PrismaTransactionAttemptRepository;

beforeAll(() => {
  cleanupDbFiles();
  execSync('npx prisma migrate deploy', { cwd: PROJECT_ROOT, env: { ...process.env, DATABASE_URL: TEST_DB_URL }, stdio: 'pipe' });
  const adapter = new PrismaBetterSqlite3({ url: TEST_DB_URL });
  prisma = new PrismaClient({ adapter });
  repo = new PrismaPositionRepository(prisma);
  attempts = new PrismaTransactionAttemptRepository(prisma);
}, 30_000);

afterAll(async () => {
  await prisma.$disconnect();
  cleanupDbFiles();
});

let seq = 0;
/** Reproduces the production shape: CLOSED via dust settlement, VERIFIED approve + removeLiquidity, one never-signed PENDING swap leg. */
async function productionShape(over: { swap?: Record<string, unknown>; close?: boolean } = {}) {
  seq += 1;
  const token = `0x${seq.toString(16).padStart(40, '0')}` as Address;
  const created = await repo.create(makeCreateInput({ entryUsdgRaw: 500n * 10n ** 18n, tokenAddress: token }));
  await repo.markActive(created.id, String(seq), new Date());
  const closeKey = `exit:${created.id}:${seq}`;
  await repo.markClosing(created.id, closeKey);

  for (const [name, purpose, nonce] of [['remove', 'exit:removeLiquidity', 1603], ['approve', 'exit:approve', 1604]] as const) {
    await prisma.transactionAttempt.create({
      data: {
        id: `${closeKey}:${name}`, idempotencyKey: `${closeKey}:${name}:0`, purpose, status: 'VERIFIED',
        nonce, txHash: `0x${'aa'.repeat(32)}`, rawTx: '0xsigned', attemptCount: 1, updatedAt: new Date(), version: 3,
      },
    });
  }
  const swapId = `${closeKey}:swap`;
  await prisma.transactionAttempt.create({
    data: {
      id: swapId, idempotencyKey: `${closeKey}:swap:0`, purpose: 'exit:swap', status: 'PENDING',
      nonce: null, txHash: null, rawTx: null, attemptCount: 2101, updatedAt: new Date(), version: 4203,
      lastError: '[BUILD_FAILED] SwapQuoteValidationError: not an approved execution target',
      ...over.swap,
    },
  });
  if (over.close !== false) await repo.markClosed(created.id, new Date(), 'DUST_SETTLEMENT', 20915201n, closeKey);
  return { positionId: created.id, closeKey, swapId };
}

describe('fenceObsoleteExitAttempts (real SQLite DB, real migration)', () => {
  it('fences the stale swap leg and leaves the VERIFIED legs and the position byte-identical', async () => {
    const ctx = await productionShape();
    const positionBefore = await prisma.position.findUnique({ where: { id: ctx.positionId } });
    const verifiedBefore = await prisma.transactionAttempt.findMany({ where: { status: 'VERIFIED', idempotencyKey: { startsWith: `${ctx.closeKey}:` } }, orderBy: { id: 'asc' } });

    const out = await repo.fenceObsoleteExitAttempts([ctx.positionId], new Date());

    expect(out).toEqual([expect.objectContaining({ outcome: 'FENCED', purpose: 'exit:swap', statusBefore: 'PENDING', attemptCount: 2101 })]);
    const swap = await prisma.transactionAttempt.findUnique({ where: { id: ctx.swapId } });
    expect(swap).toMatchObject({ status: 'FAILED', failureCode: 'LIFECYCLE_CLOSED', nonce: null, txHash: null, rawTx: null, version: 4204 });
    expect(swap?.lastError).toMatch(/never reached SIGNED/);
    expect(swap?.attemptCount).toBe(2101); // history preserved, not reset

    expect(await prisma.position.findUnique({ where: { id: ctx.positionId } })).toEqual(positionBefore);
    expect(await prisma.transactionAttempt.findMany({ where: { status: 'VERIFIED', idempotencyKey: { startsWith: `${ctx.closeKey}:` } }, orderBy: { id: 'asc' } })).toEqual(verifiedBefore);
  });

  it('is idempotent: a second and third run rewrite nothing and do not bump the version', async () => {
    const ctx = await productionShape();
    await repo.fenceObsoleteExitAttempts([ctx.positionId], new Date());
    const afterFirst = await prisma.transactionAttempt.findUnique({ where: { id: ctx.swapId } });

    const second = await repo.fenceObsoleteExitAttempts([ctx.positionId], new Date());
    const third = await repo.fenceObsoleteExitAttempts([ctx.positionId], new Date());

    expect(second[0]).toMatchObject({ outcome: 'SKIPPED', reason: 'ALREADY_TERMINAL' });
    expect(third[0]).toMatchObject({ outcome: 'SKIPPED', reason: 'ALREADY_TERMINAL' });
    expect(await prisma.transactionAttempt.findUnique({ where: { id: ctx.swapId } })).toEqual(afterFirst);
  });

  it.each([
    ['a nonce', { nonce: 1610 }, 'NONCE_ASSIGNED'],
    ['a txHash', { txHash: `0x${'cc'.repeat(32)}` }, 'TX_HASH_PRESENT'],
    ['a raw signed transaction', { rawTx: '0xdeadbeef' }, 'RAW_TX_PRESENT'],
    ['a SIGNED status', { status: 'SIGNED' }, 'POSSIBLY_BROADCAST'],
    ['a SENT status', { status: 'SENT' }, 'POSSIBLY_BROADCAST'],
    ['a CONFIRMED status', { status: 'CONFIRMED' }, 'POSSIBLY_BROADCAST'],
  ])('refuses a swap leg holding %s and writes nothing', async (_label, swap, reason) => {
    const ctx = await productionShape({ swap });
    const before = await prisma.transactionAttempt.findUnique({ where: { id: ctx.swapId } });

    const out = await repo.fenceObsoleteExitAttempts([ctx.positionId], new Date());

    expect(out[0]).toMatchObject({ outcome: 'SKIPPED', reason });
    expect(await prisma.transactionAttempt.findUnique({ where: { id: ctx.swapId } })).toEqual(before);
  });

  it('refuses a position that is still CLOSING and writes nothing', async () => {
    const ctx = await productionShape({ close: false });
    const before = await prisma.transactionAttempt.findUnique({ where: { id: ctx.swapId } });

    expect(await repo.fenceObsoleteExitAttempts([ctx.positionId], new Date())).toEqual([{ positionId: ctx.positionId, outcome: 'POSITION_NOT_CLOSED' }]);
    expect(await prisma.transactionAttempt.findUnique({ where: { id: ctx.swapId } })).toEqual(before);
  });

  it('never touches a non-swap leg, even a non-terminal one, on a CLOSED position', async () => {
    const ctx = await productionShape();
    await prisma.transactionAttempt.create({
      data: { id: `${ctx.closeKey}:extra`, idempotencyKey: `${ctx.closeKey}:approve:1`, purpose: 'exit:approve', status: 'PENDING', attemptCount: 3, updatedAt: new Date(), version: 1 },
    });

    const out = await repo.fenceObsoleteExitAttempts([ctx.positionId], new Date());

    expect(out.filter((r) => r.outcome === 'FENCED')).toHaveLength(1);
    expect(await prisma.transactionAttempt.findUnique({ where: { id: `${ctx.closeKey}:extra` } })).toMatchObject({ status: 'PENDING', version: 1 });
  });

  it('never touches another position, including another CLOSED one that was not named', async () => {
    const named = await productionShape();
    const other = await productionShape();
    const otherBefore = await prisma.transactionAttempt.findUnique({ where: { id: other.swapId } });

    await repo.fenceObsoleteExitAttempts([named.positionId], new Date());

    expect(await prisma.transactionAttempt.findUnique({ where: { id: other.swapId } })).toEqual(otherBefore);
  });

  it('the batch is ALL-OR-NOTHING: when a CAS matches no row, the whole transaction rolls back', async () => {
    const a = await productionShape();
    const b = await productionShape();

    // A genuine CAS mismatch is close to unreachable once SQLite's write lock
    // is held (the same reason `expireStaleOpening` calls its equivalent
    // branch "unreachable"), so rather than stage a fake race, this drives the
    // guard directly: the SECOND updateMany reports 0 rows matched. What is
    // under test is the consequence -- the first row's write must not survive.
    const realTransaction = prisma.$transaction.bind(prisma);
    let updates = 0;
    (prisma as unknown as { $transaction: unknown }).$transaction = ((fn: (tx: unknown) => unknown) =>
      (realTransaction as (cb: (tx: unknown) => unknown) => unknown)((tx: unknown) => {
        const t = tx as TxLike;
        const realUpdateMany = t.transactionAttempt.updateMany.bind(t.transactionAttempt);
        return fn({
          ...t,
          transactionAttempt: {
            ...t.transactionAttempt,
            findMany: t.transactionAttempt.findMany.bind(t.transactionAttempt),
            updateMany: async (...args: never[]) => {
              updates += 1;
              if (updates === 2) return { count: 0 };
              return realUpdateMany(...args);
            },
          },
          position: { ...t.position, findUnique: t.position.findUnique.bind(t.position) },
        });
      })) as never;

    await expect(repo.fenceObsoleteExitAttempts([a.positionId, b.positionId], new Date())).rejects.toThrow(/CAS matched 0 rows/);

    (prisma as unknown as { $transaction: unknown }).$transaction = realTransaction;

    // The first position's write must have been rolled back with the transaction.
    expect(await prisma.transactionAttempt.findUnique({ where: { id: a.swapId } })).toMatchObject({ status: 'PENDING', failureCode: null, version: 4203 });
    expect(await prisma.transactionAttempt.findUnique({ where: { id: b.swapId } })).toMatchObject({ status: 'PENDING', failureCode: null, version: 4203 });
  });

  it('concurrent cleanup of the same position is safe: fenced exactly once, no error', async () => {
    const ctx = await productionShape();

    const [x, y] = await Promise.all([
      repo.fenceObsoleteExitAttempts([ctx.positionId], new Date()),
      repo.fenceObsoleteExitAttempts([ctx.positionId], new Date()),
    ]);

    const outcomes = [...x, ...y].map((r) => r.outcome).sort();
    expect(outcomes).toEqual(['FENCED', 'SKIPPED']);
    const row = await prisma.transactionAttempt.findUnique({ where: { id: ctx.swapId } });
    expect(row).toMatchObject({ status: 'FAILED', failureCode: 'LIFECYCLE_CLOSED', version: 4204 }); // bumped exactly once
  });

  /**
   * Defence in depth. The classifier decides from a row it READ; the UPDATE
   * re-asserts the same facts in its WHERE clause so the write is refused if
   * the row is not still exactly what was read. Nothing in normal operation
   * can make the two disagree (the transaction holds SQLite's write lock),
   * which is precisely why these two tests have to manufacture the
   * disagreement: they hand the classifier a doctored view of a row whose real
   * state would forbid the write.
   */
  type Row = Record<string, unknown>;
  /** Named members, not an index signature: `noUncheckedIndexedAccess` would otherwise make every lookup `| undefined`. */
  interface TxLike {
    transactionAttempt: { findMany: (...a: never[]) => Promise<Row[]>; updateMany: (...a: never[]) => Promise<unknown> };
    position: { findUnique: (...a: never[]) => Promise<unknown> };
  }

  function withDoctoredRead(doctor: (row: Row) => Row): () => void {
    const realTransaction = prisma.$transaction.bind(prisma);
    (prisma as unknown as { $transaction: unknown }).$transaction = ((fn: (tx: unknown) => unknown) =>
      (realTransaction as (cb: (tx: unknown) => unknown) => unknown)((tx: unknown) => {
        const t = tx as TxLike;
        const findMany = t.transactionAttempt.findMany.bind(t.transactionAttempt);
        return fn({
          ...t,
          transactionAttempt: {
            ...t.transactionAttempt,
            updateMany: t.transactionAttempt.updateMany.bind(t.transactionAttempt),
            findMany: async (...args: never[]) => (await findMany(...args)).map(doctor),
          },
          position: { ...t.position, findUnique: t.position.findUnique.bind(t.position) },
        });
      })) as never;
    return () => { (prisma as unknown as { $transaction: unknown }).$transaction = realTransaction; };
  }

  it('the UPDATE refuses a row that really holds a nonce, even if the read claimed otherwise', async () => {
    const ctx = await productionShape({ swap: { nonce: 1610 } });
    const before = await prisma.transactionAttempt.findUnique({ where: { id: ctx.swapId } });
    const restore = withDoctoredRead((row) => ({ ...row, nonce: null })); // classifier is lied to

    await expect(repo.fenceObsoleteExitAttempts([ctx.positionId], new Date())).rejects.toThrow(/CAS matched 0 rows/);

    restore();
    // The row still holds its nonce and was NOT rewritten: the WHERE clause caught what the classifier missed.
    expect(await prisma.transactionAttempt.findUnique({ where: { id: ctx.swapId } })).toEqual(before);
  });

  it('the UPDATE refuses a row whose version moved after it was read', async () => {
    const ctx = await productionShape();
    const before = await prisma.transactionAttempt.findUnique({ where: { id: ctx.swapId } });
    const restore = withDoctoredRead((row) => ({ ...row, version: (row.version as number) + 999 })); // stale read

    await expect(repo.fenceObsoleteExitAttempts([ctx.positionId], new Date())).rejects.toThrow(/CAS matched 0 rows/);

    restore();
    expect(await prisma.transactionAttempt.findUnique({ where: { id: ctx.swapId } })).toEqual(before);
  });

  it('removes the row from findNonTerminal(), which is what stuck reporting counts', async () => {
    const ctx = await productionShape();
    const stuckBefore = await attempts.findNonTerminal();
    expect(stuckBefore.some((a) => a.id === ctx.swapId)).toBe(true);

    await repo.fenceObsoleteExitAttempts([ctx.positionId], new Date());

    const stuckAfter = await attempts.findNonTerminal();
    expect(stuckAfter.some((a) => a.id === ctx.swapId)).toBe(false);
  });

  it('an unknown id and an empty list write nothing', async () => {
    const ctx = await productionShape();
    const before = await prisma.transactionAttempt.findUnique({ where: { id: ctx.swapId } });
    expect(await repo.fenceObsoleteExitAttempts([], new Date())).toEqual([]);
    expect(await repo.fenceObsoleteExitAttempts(['nope'], new Date())).toEqual([{ positionId: 'nope', outcome: 'POSITION_NOT_FOUND' }]);
    expect(await prisma.transactionAttempt.findUnique({ where: { id: ctx.swapId } })).toEqual(before);
  });
});
