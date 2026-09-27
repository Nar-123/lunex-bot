import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { spawn, execSync } from 'node:child_process';
import { existsSync, rmSync } from 'node:fs';
import path from 'node:path';
import { PrismaClient } from '@prisma/client';
import { PrismaBetterSqlite3 } from '@prisma/adapter-better-sqlite3';
import { PrismaTransactionAttemptRepository } from '../../src/execution/transactionAttemptRepository';
import { NonceReservationUnavailableError } from '../../src/execution/types';

/**
 * Nonce reservation against a REAL SQLite database and, for the concurrency
 * cases, REAL separate OS processes.
 *
 * `ExecutorMutex` serializes the allocate -> sign -> broadcast span inside one
 * process. It cannot coordinate two bot processes sharing this database, which
 * is the gap these tests exist to close: allocation is now one transaction that
 * takes a cross-process write lock (`NonceLock`, the same technique
 * `PositionRepository` uses for capital), with a partial unique index on
 * `(executorAddress, nonce)` as the backstop.
 *
 * Everything here is scoped by EXECUTOR: a nonce means nothing without an
 * account, and this table outlives `PRIVATE_KEY`.
 */
const PROJECT_ROOT = path.resolve(__dirname, '../..');
const TEST_DB_PATH = path.resolve(PROJECT_ROOT, 'data', 'test-nonce-reservation.db');
const TEST_DB_URL = `file:${TEST_DB_PATH}`;
const TS_NODE_BIN = require.resolve('ts-node/dist/bin.js');

const EXEC_A = '0x7D22bd54152F8eaD57edb0077A6E9f8A7fC76DDB';
const EXEC_B = '0x65299018ABAaa6bD89aabF689dbEf21Be99ef1Ea';

function cleanupDbFiles(): void {
  for (const suffix of ['', '-journal', '-wal', '-shm']) {
    const file = TEST_DB_PATH + suffix;
    if (existsSync(file)) rmSync(file);
  }
}

let prisma: PrismaClient;
let repo: PrismaTransactionAttemptRepository;

beforeAll(() => {
  cleanupDbFiles();
  execSync('npx prisma migrate deploy', { cwd: PROJECT_ROOT, env: { ...process.env, DATABASE_URL: TEST_DB_URL }, stdio: 'pipe' });
  prisma = new PrismaClient({ adapter: new PrismaBetterSqlite3({ url: TEST_DB_URL }) });
  repo = new PrismaTransactionAttemptRepository(prisma, EXEC_A);
}, 60_000);

afterAll(async () => {
  await prisma.$disconnect();
  cleanupDbFiles();
});

beforeEach(async () => {
  await prisma.transactionAttempt.deleteMany({});
});

/** Creates an attempt already at GAS_CHECKED -- the status the pipeline holds when it reserves. */
async function readyAttempt(key: string, r: PrismaTransactionAttemptRepository = repo) {
  const created = await r.create(key, 'test');
  return r.update(created.id, { status: 'GAS_CHECKED' }, created.version);
}

async function reserve(key: string, chainPendingNonce: number, r: PrismaTransactionAttemptRepository = repo) {
  const a = await readyAttempt(key, r);
  return r.reserveNonce({ attemptId: a.id, expectedVersion: a.version, chainPendingNonce });
}

/** Spawns the worker as a genuinely separate OS process; resolves its last JSON stdout line. */
function runWorker(args: {
  executor: string;
  key: string;
  chainPendingNonce: number;
  barrier?: number;
}): Promise<{ nonce?: number; adjustedBy?: string | null; skipped?: number; threw?: string; kind?: string }> {
  return new Promise((resolve, reject) => {
    const child = spawn(
      process.execPath,
      [
        TS_NODE_BIN,
        '--transpile-only',
        path.resolve(__dirname, 'nonceReservationWorker.ts'),
        TEST_DB_URL,
        args.executor,
        args.key,
        'test',
        String(args.chainPendingNonce),
        ...(args.barrier === undefined ? [] : [String(args.barrier)]),
      ],
      { cwd: PROJECT_ROOT, env: process.env },
    );
    let stdout = '';
    let stderr = '';
    child.stdout.on('data', (d) => { stdout += String(d); });
    child.stderr.on('data', (d) => { stderr += String(d); });
    child.on('error', reject);
    child.on('close', () => {
      const line = stdout.trim().split('\n').filter(Boolean).pop();
      if (!line) { reject(new Error(`worker produced no output. stderr: ${stderr}`)); return; }
      try { resolve(JSON.parse(line) as never); } catch { reject(new Error(`worker printed non-JSON: ${line}`)); }
    });
  });
}

describe('nonce reservation (real SQLite DB, real migration)', () => {
  it('records the executor on every attempt it creates', async () => {
    const a = await repo.create('scoped-1', 'test');
    expect(a.executorAddress).toBe(EXEC_A.toLowerCase());
  });

  it('allocates the chain nonce when nothing is spoken for', async () => {
    const r = await reserve('alloc-1', 5);
    expect(r.nonce).toBe(5);
    expect(r.adjustedBy).toBeNull();
    expect(r.attempt.status).toBe('NONCE_ASSIGNED');
  });

  it('(different idempotency keys) two sequential reservations never share a nonce', async () => {
    const first = await reserve('key-a', 5);
    const second = await reserve('key-b', 5); // same stale chain answer
    expect(first.nonce).toBe(5);
    expect(second.nonce).toBe(6);
    expect(second.adjustedBy).toBe('RESERVED_BY_ANOTHER_ATTEMPT');
  });

  it('(stale RPC pending nonce) an IN-FLIGHT signed nonce is skipped even when the provider reports it as free', async () => {
    const a = await readyAttempt('signed-5');
    const res = await repo.reserveNonce({ attemptId: a.id, expectedVersion: a.version, chainPendingNonce: 5 });
    // Mark it signed, then let a frozen provider answer 5 again.
    await repo.update(res.attempt.id, { status: 'SIGNED', rawTx: '0xaa', txHash: '0xbb' }, res.attempt.version);

    const next = await reserve('after-signed', 5);

    expect(next.nonce).toBe(6);
    // SIGNED is non-terminal, so it is BOTH reserved and signed. The allocator
    // reports the reservation, which names a specific live attempt and is the
    // more actionable of the two.
    expect(next.adjustedBy).toBe('RESERVED_BY_ANOTHER_ATTEMPT');
  });

  it('(stale RPC pending nonce) a MINED nonce is skipped too -- reported as ALREADY_SIGNED', async () => {
    // VERIFIED is terminal, so it is invisible to the reserved set; only the
    // signed set can protect this nonce, which is exactly why that set exists.
    const a = await reserve('verified-5', 5);
    await repo.update(
      a.attempt.id,
      { status: 'VERIFIED', rawTx: '0xaa', txHash: '0xbb', verifyData: { ok: true } },
      a.attempt.version,
    );

    const next = await reserve('after-verified', 5); // provider still stale at 5

    expect(next.nonce).toBe(6);
    expect(next.adjustedBy).toBe('ALREADY_SIGNED');
  });

  it('(restart/resume) a persisted nonce is reused -- reserveNonce is not called again', async () => {
    const first = await reserve('resume-1', 5);
    // A resumed pipeline reads the attempt and sees NONCE_ASSIGNED, so it never
    // re-reserves. Proven here by reading the row back after a fresh client.
    const reread = await repo.find('resume-1');
    expect(reread?.nonce).toBe(first.nonce);
    expect(reread?.status).toBe('NONCE_ASSIGNED');
  });

  it('(pre-sign FAILED) a nonce that never signed is reclaimable', async () => {
    const a = await reserve('presign-fail', 5);
    await repo.update(a.attempt.id, { status: 'FAILED', failureCode: 'SIGN_TRANSACTION_FAILED' }, a.attempt.version);

    // The chain still sits at 5 and nothing was broadcast there.
    const next = await reserve('reclaims-5', 5);

    expect(next.nonce).toBe(5);
  });

  it('(FAILED after signing) that nonce is NOT reclaimable -- the payload may be in flight', async () => {
    const a = await reserve('postsign-fail', 5);
    await repo.update(a.attempt.id, { status: 'SIGNED', rawTx: '0xaa', txHash: '0xbb' }, a.attempt.version);
    const signed = await repo.find('postsign-fail');
    await repo.update(signed!.id, { status: 'FAILED', failureCode: 'BROADCAST_REJECTED' }, signed!.version);

    const next = await reserve('after-postsign-fail', 5);

    expect(next.nonce).toBe(6);
  });

  it('(executor rotation) a new executor does NOT inherit the old wallet nonce history', async () => {
    // Old wallet reaches a high nonce and signs there.
    const oldRepo = new PrismaTransactionAttemptRepository(prisma, EXEC_B);
    const old = await reserve('old-wallet-tx', 1609, oldRepo);
    await oldRepo.update(old.attempt.id, { status: 'SIGNED', rawTx: '0xaa', txHash: '0xbb' }, old.attempt.version);
    expect(old.nonce).toBe(1609);

    // The new executor is a fresh account at nonce 0.
    const fresh = await reserve('new-wallet-tx', 0);

    expect(fresh.nonce).toBe(0);
    expect(fresh.adjustedBy).toBeNull();
    // And the two executors' views are genuinely separate.
    expect(await repo.findSignedNoncesAtOrAbove(0)).toEqual([]);
    expect(await oldRepo.findSignedNoncesAtOrAbove(0)).toEqual([1609]);
  });

  it('(DB-enforced) the unique index rejects a second row claiming the same (executor, nonce)', async () => {
    const a = await reserve('unique-1', 5);
    const b = await readyAttempt('unique-2');

    // Bypass the allocator and try to write the same nonce directly, which is
    // what a racing process would effectively be doing.
    await expect(
      prisma.transactionAttempt.update({ where: { id: b.id }, data: { nonce: a.nonce } }),
    ).rejects.toThrow(/UNIQUE constraint failed|Unique constraint/i);
  });

  it('(DB-enforced) a FAILED-after-signing row still blocks the nonce at the database level', async () => {
    // Defence in depth: the allocator already skips this nonce via the signed
    // set, but the index must independently refuse a second claim -- otherwise a
    // process bypassing the allocator could reuse a nonce whose payload may be
    // in flight. This pins the index PREDICATE: FAILED rows are excluded only
    // when they never signed.
    const a = await reserve('signed-then-failed', 5);
    await repo.update(a.attempt.id, { status: 'SIGNED', rawTx: '0xaa', txHash: '0xbb' }, a.attempt.version);
    const signed = await repo.find('signed-then-failed');
    await repo.update(signed!.id, { status: 'FAILED', failureCode: 'BROADCAST_REJECTED' }, signed!.version);

    const other = await readyAttempt('wants-the-dead-nonce');
    await expect(
      prisma.transactionAttempt.update({ where: { id: other.id }, data: { nonce: 5 } }),
    ).rejects.toThrow(/UNIQUE constraint failed|Unique constraint/i);
  });

  it('(DB-enforced) a FAILED-before-signing row does NOT block the nonce at the database level', async () => {
    // The other side of the same predicate: a nonce that never produced a
    // payload must remain claimable, or a pre-sign failure leaves a permanent
    // hole that blocks every later transaction.
    const a = await reserve('failed-unsigned', 5);
    await repo.update(a.attempt.id, { status: 'FAILED', failureCode: 'SIGN_TRANSACTION_FAILED' }, a.attempt.version);

    const other = await readyAttempt('claims-freed-nonce');
    await expect(prisma.transactionAttempt.update({ where: { id: other.id }, data: { nonce: 5 } })).resolves.toBeTruthy();
  });

  it('the reservation takes the cross-process NonceLock as its first write', async () => {
    // The lock is what turns a cross-process race into an orderly queue instead
    // of a collision the unique index has to reject. Without it, SQLite's
    // deferred transaction would let two processes read the same snapshot under
    // a shared lock before either escalates to a write. Asserted via its
    // observable side effect: the singleton row exists and is touched.
    await prisma.nonceLock.deleteMany({});
    expect(await prisma.nonceLock.findMany()).toHaveLength(0);

    await reserve('touches-the-lock', 5);

    const locks = await prisma.nonceLock.findMany();
    expect(locks).toHaveLength(1);
    expect(locks[0]?.id).toBe('singleton');
    const firstTouch = locks[0]?.touchedAt as Date;

    await new Promise((r) => setTimeout(r, 5));
    await reserve('touches-the-lock-again', 6);
    const after = await prisma.nonceLock.findFirst();
    expect((after?.touchedAt as Date).getTime()).toBeGreaterThanOrEqual(firstTouch.getTime());
  });

  it('(DB-enforced) the same nonce IS allowed for a DIFFERENT executor', async () => {
    await reserve('exec-a-5', 5);
    const otherRepo = new PrismaTransactionAttemptRepository(prisma, EXEC_B);

    const other = await reserve('exec-b-5', 5, otherRepo);

    expect(other.nonce).toBe(5); // same number, different account -- no clash
  });

  it('a stale expectedVersion is refused rather than clobbering a newer state', async () => {
    const a = await readyAttempt('stale-cas');
    await repo.update(a.id, { lastError: 'someone else wrote' }, a.version); // bumps version

    await expect(
      repo.reserveNonce({ attemptId: a.id, expectedVersion: a.version, chainPendingNonce: 5 }),
    ).rejects.toThrow(/was not at expected version/);
  });
});

describe('nonce reservation across REAL separate processes', () => {
  it('two processes racing on the same executor get DIFFERENT nonces', async () => {
    const [a, b] = await Promise.all([
      runWorker({ executor: EXEC_A, key: 'proc-a', chainPendingNonce: 5, barrier: 2 }),
      runWorker({ executor: EXEC_A, key: 'proc-b', chainPendingNonce: 5, barrier: 2 }),
    ]);

    for (const r of [a, b]) expect(r.threw, `worker threw: ${r.threw}`).toBeUndefined();
    expect([a.nonce, b.nonce].sort()).toEqual([5, 6]);
  }, 120_000);

  it('four processes racing produce four DISTINCT nonces and no duplicate (executor, nonce)', async () => {
    const keys = ['p0', 'p1', 'p2', 'p3'];
    const results = await Promise.all(
      keys.map((k) => runWorker({ executor: EXEC_A, key: k, chainPendingNonce: 10, barrier: 4 })),
    );

    const failures = results.filter((r) => r.threw !== undefined);
    // A loser may legitimately be told to retry (lock contention / NONCE_TAKEN);
    // what must never happen is two winners on one nonce.
    for (const f of failures) expect(f.kind, `unexpected throw: ${f.threw}`).toMatch(/LOCK_CONTENTION|NONCE_TAKEN/);

    const nonces = results.filter((r) => r.nonce !== undefined).map((r) => r.nonce as number);
    expect(new Set(nonces).size).toBe(nonces.length);
    expect(nonces.length).toBeGreaterThanOrEqual(1);

    // The database's own view: no duplicate (executor, nonce) among rows that hold one.
    const rows = await prisma.transactionAttempt.findMany({
      where: { executorAddress: EXEC_A.toLowerCase(), nonce: { not: null } },
      select: { nonce: true },
    });
    const persisted = rows.map((r) => r.nonce as number);
    expect(new Set(persisted).size).toBe(persisted.length);
  }, 180_000);

  it('a separate process cannot take a nonce this process already reserved', async () => {
    const mine = await reserve('parent-holds-7', 7);
    expect(mine.nonce).toBe(7);

    const other = await runWorker({ executor: EXEC_A, key: 'child-wants-7', chainPendingNonce: 7 });

    expect(other.threw).toBeUndefined();
    expect(other.nonce).toBe(8);
    expect(other.adjustedBy).toBe('RESERVED_BY_ANOTHER_ATTEMPT');
  }, 120_000);

  it('a separate process on a DIFFERENT executor is unaffected by this one', async () => {
    await reserve('a-holds-3', 3);

    const other = await runWorker({ executor: EXEC_B, key: 'b-wants-3', chainPendingNonce: 3 });

    expect(other.threw).toBeUndefined();
    expect(other.nonce).toBe(3);
  }, 120_000);
});

describe('NonceReservationUnavailableError is a retry signal, never a verdict', () => {
  it('carries a kind so contention is distinguishable from a stale-writer bug', () => {
    const e = new NonceReservationUnavailableError('busy', 'LOCK_CONTENTION');
    expect(e.name).toBe('NonceReservationUnavailableError');
    expect(e.kind).toBe('LOCK_CONTENTION');
    expect(new NonceReservationUnavailableError('taken', 'NONCE_TAKEN').kind).toBe('NONCE_TAKEN');
  });
});
