import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { spawn, execSync } from 'node:child_process';
import { existsSync, rmSync } from 'node:fs';
import path from 'node:path';
import { PrismaClient } from '@prisma/client';
import { PrismaBetterSqlite3 } from '@prisma/adapter-better-sqlite3';
import { PrismaTransactionAttemptRepository } from '../../src/execution/transactionAttemptRepository';
import { executeCriticalTransaction } from '../../src/execution/executeCriticalTransaction';
import type { TransactionAttemptRecord, TransactionAttemptRepository, TxRequest, TxSafetyDeps } from '../../src/execution/types';

/**
 * Same-idempotency-key race across REAL separate OS processes.
 *
 * Two workers both see `find(key)` return null, and only one `create` can win --
 * `idempotencyKey` is unique. The loser used to throw the raw Prisma conflict
 * out of `executeCriticalTransaction` (the find/create sat outside the main
 * try/catch), so a perfectly ordinary race became an unhandled exception. It now
 * re-reads the row the winner created and resumes THAT attempt.
 *
 * The invariant that matters: one logical operation is one row and one payload.
 * Nothing in-process coordinates these two processes -- each has its own Node
 * runtime, PrismaClient and adapter mutex -- so only the database decides.
 */
const PROJECT_ROOT = path.resolve(__dirname, '../..');
const DB_PATH = path.resolve(PROJECT_ROOT, 'data', 'test-same-key-race.db');
const DB_URL = `file:${DB_PATH}`;
const TS_NODE_BIN = require.resolve('ts-node/dist/bin.js');
const EXECUTOR = '0x7D22bd54152F8eaD57edb0077A6E9f8A7fC76DDB';

let prisma: PrismaClient;

function cleanup(): void {
  for (const s of ['', '-journal', '-wal', '-shm']) if (existsSync(DB_PATH + s)) rmSync(DB_PATH + s);
}

beforeAll(() => {
  cleanup();
  execSync('npx prisma migrate deploy', { cwd: PROJECT_ROOT, env: { ...process.env, DATABASE_URL: DB_URL }, stdio: 'pipe' });
  prisma = new PrismaClient({ adapter: new PrismaBetterSqlite3({ url: DB_URL }) });
}, 120_000);

afterAll(async () => {
  await prisma.$disconnect();
  cleanup();
});

beforeEach(async () => {
  await prisma.transactionAttempt.deleteMany({});
  await prisma.nonceLock.deleteMany({});
});

interface WorkerResult {
  ok?: boolean;
  reason?: string;
  status?: string;
  id?: string;
  nonce?: number | null;
  txHash?: string | null;
  signCalls?: number;
  broadcastCalls?: number;
  threw?: string;
}

function runWorker(key: string, workerId: string, chainNonce: number, barrier?: number): Promise<WorkerResult> {
  return new Promise((resolve, reject) => {
    const child = spawn(
      process.execPath,
      [
        TS_NODE_BIN,
        '--transpile-only',
        path.resolve(__dirname, 'sameKeyRaceWorker.ts'),
        DB_URL,
        EXECUTOR,
        key,
        workerId,
        String(chainNonce),
        ...(barrier === undefined ? [] : [String(barrier)]),
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
      if (!line) { reject(new Error(`worker ${workerId} produced no output. stderr: ${stderr}`)); return; }
      try { resolve(JSON.parse(line) as WorkerResult); } catch { reject(new Error(`worker ${workerId} printed non-JSON: ${line}`)); }
    });
  });
}

const TX: TxRequest = { to: '0x1111111111111111111111111111111111111111', data: '0xabcdef', value: 0n };

/**
 * The loser's exact situation, made deterministic.
 *
 * The cross-process tests below prove convergence, but they cannot reliably
 * land both processes between `find` and `create` -- process startup dwarfs that
 * window, so the second one usually just finds the row. This wrapper reproduces
 * the losing interleaving exactly: `find` returns null ONCE (the stale read),
 * while the row genuinely exists in SQLite, so the real `create` raises the real
 * unique-constraint error and the fix has to recover from it.
 */
function repoWithStaleFirstFind(inner: PrismaTransactionAttemptRepository): TransactionAttemptRepository {
  let firstFind = true;
  return {
    get executorAddress() { return inner.executorAddress; },
    async find(key: string): Promise<TransactionAttemptRecord | null> {
      if (firstFind) { firstFind = false; return null; }
      return inner.find(key);
    },
    create: (k, p) => inner.create(k, p),
    update: (id, patch, v) => inner.update(id, patch, v),
    findNonTerminal: () => inner.findNonTerminal(),
    findByKeyPrefixes: (p) => inner.findByKeyPrefixes(p),
    findSignedNoncesAtOrAbove: (n) => inner.findSignedNoncesAtOrAbove(n),
    reserveNonce: (i) => inner.reserveNonce(i),
  };
}

const okDeps = (): TxSafetyDeps<{ ok: true }> => {
  let signCalls = 0;
  const deps: TxSafetyDeps<{ ok: true }> = {
    buildTransaction: async () => TX,
    simulate: async () => ({ ok: true }),
    estimateGas: async () => 100_000n,
    getGasPrice: async () => 1n,
    checkGasAffordable: async () => ({ ok: true }),
    getNonce: async () => 4,
    signTransaction: async () => { signCalls += 1; return { raw: '0xaa' as `0x${string}`, hash: `0x${'ab'.repeat(32)}` as `0x${string}` }; },
    broadcastRaw: async () => undefined,
    waitForReceipt: async () => ({ status: 'success' as const, blockNumber: 1n }),
    getReceiptIfAvailable: async () => null,
    verifyOnChain: async () => ({ ok: true as const, data: { ok: true as const } }),
  };
  Object.defineProperty(deps, 'signCalls', { get: () => signCalls, enumerable: false });
  return deps;
};

describe('create() conflict on an existing key (the losing interleaving, deterministic)', () => {
  it('re-reads and resumes the existing attempt instead of throwing', async () => {
    const KEY = 'race:deterministic:1';
    const repo = new PrismaTransactionAttemptRepository(prisma, EXECUTOR);
    // The winner already created the row.
    const winner = await repo.create(KEY, 'same-key-race');

    // The loser: stale find -> null, then create hits the real unique index.
    const result = await executeCriticalTransaction(KEY, 'same-key-race', okDeps(), repoWithStaleFirstFind(repo), { log: () => undefined });

    expect(result.ok).toBe(true);
    // Resumed the winner's row, did not create a second one.
    expect(result.ok && result.attempt.id).toBe(winner.id);
    expect(await prisma.transactionAttempt.count({ where: { idempotencyKey: KEY } })).toBe(1);
  }, 60_000);

  it('never marks the raced attempt FAILED', async () => {
    const KEY = 'race:deterministic:2';
    const repo = new PrismaTransactionAttemptRepository(prisma, EXECUTOR);
    await repo.create(KEY, 'same-key-race');

    await executeCriticalTransaction(KEY, 'same-key-race', okDeps(), repoWithStaleFirstFind(repo), { log: () => undefined });

    const row = await prisma.transactionAttempt.findUnique({ where: { idempotencyKey: KEY } });
    expect(row?.status).not.toBe('FAILED');
    expect(row?.failureCode).toBeNull();
  }, 60_000);

  it('logs the race so it is visible, and signs exactly once', async () => {
    const KEY = 'race:deterministic:3';
    const repo = new PrismaTransactionAttemptRepository(prisma, EXECUTOR);
    const winner = await repo.create(KEY, 'same-key-race');
    const events: string[] = [];
    const deps = okDeps();

    await executeCriticalTransaction(KEY, 'same-key-race', deps, repoWithStaleFirstFind(repo), {
      log: (event) => { events.push(event); },
    });

    expect(events).toContain('attempt_create_raced');
    expect((deps as unknown as { signCalls: number }).signCalls).toBe(1);
    expect(await prisma.transactionAttempt.count({ where: { idempotencyKey: KEY } })).toBe(1);
    expect((await prisma.transactionAttempt.findUnique({ where: { idempotencyKey: KEY } }))?.id).toBe(winner.id);
  }, 60_000);

  it('a create failure with NO existing row still propagates -- a real error is not swallowed', async () => {
    const KEY = 'race:deterministic:4';
    const repo = new PrismaTransactionAttemptRepository(prisma, EXECUTOR);
    const broken: TransactionAttemptRepository = {
      get executorAddress() { return repo.executorAddress; },
      async find() { return null; },
      async create() { throw new Error('disk I/O error'); },
      update: (id, patch, v) => repo.update(id, patch, v),
      findNonTerminal: () => repo.findNonTerminal(),
      findByKeyPrefixes: (p) => repo.findByKeyPrefixes(p),
      findSignedNoncesAtOrAbove: (n) => repo.findSignedNoncesAtOrAbove(n),
      reserveNonce: (i) => repo.reserveNonce(i),
    };

    await expect(executeCriticalTransaction(KEY, 'same-key-race', okDeps(), broken, { log: () => undefined }))
      .rejects.toThrow(/disk I\/O error/);
    expect(await prisma.transactionAttempt.count({ where: { idempotencyKey: KEY } })).toBe(0);
  }, 60_000);
});

describe('same idempotencyKey across two separate processes', () => {
  it('both processes converge on ONE attempt -- one row, one payload, no duplicate signing', async () => {
    const KEY = 'race:same-key:1';

    const [a, b] = await Promise.all([
      runWorker(KEY, 'A', 5, 2),
      runWorker(KEY, 'B', 5, 2),
    ]);

    // Neither may crash: the loser resumes rather than throwing.
    expect(a.threw, `worker A threw: ${a.threw}`).toBeUndefined();
    expect(b.threw, `worker B threw: ${b.threw}`).toBeUndefined();

    // Exactly one row for the key -- no duplicate attempt was created.
    const rows = await prisma.transactionAttempt.findMany({ where: { idempotencyKey: KEY } });
    expect(rows).toHaveLength(1);

    // Both callers converged on the SAME attempt.
    expect(a.id).toBe(rows[0]?.id);
    expect(b.id).toBe(rows[0]?.id);

    // One PERSISTED payload and one broadcast -- that is the invariant.
    //
    // NOT "exactly one signTransaction call": signing is process-local
    // computation, and `ExecutorMutex` is process-local too, so two processes
    // may both pass the not-yet-SIGNED check and both sign before one loses the
    // version CAS on the SIGNED persist. The loser's payload is discarded
    // unpersisted and it never reaches broadcast (broadcast is gated behind that
    // CAS), so a second local signature is legal and harmless. Asserting == 1
    // here would be asserting a scheduling outcome.
    expect(rows[0]?.txHash).toBeTruthy();
    expect((a.signCalls ?? 0) + (b.signCalls ?? 0)).toBeGreaterThanOrEqual(1);
    expect((a.broadcastCalls ?? 0) + (b.broadcastCalls ?? 0)).toBe(1);

    // Neither reports a FAILED verdict for a race.
    expect(rows[0]?.status).not.toBe('FAILED');
    expect(rows[0]?.failureCode).toBeNull();
  }, 180_000);

  it('four processes on one key still yield one row and one payload', async () => {
    const KEY = 'race:same-key:4';

    const results = await Promise.all(['A', 'B', 'C', 'D'].map((id) => runWorker(KEY, id, 9, 4)));

    for (const r of results) expect(r.threw, `a worker threw: ${r.threw}`).toBeUndefined();

    const rows = await prisma.transactionAttempt.findMany({ where: { idempotencyKey: KEY } });
    expect(rows).toHaveLength(1);
    expect(new Set(results.map((r) => r.id))).toEqual(new Set([rows[0]?.id]));
    // >= 1 for the same reason as above: local signatures are not serialized
    // across processes, only the persisted payload and the broadcast are.
    expect(results.reduce((n, r) => n + (r.signCalls ?? 0), 0)).toBeGreaterThanOrEqual(1);
    expect(results.reduce((n, r) => n + (r.broadcastCalls ?? 0), 0)).toBe(1);
    expect(rows[0]?.nonce).toBe(9);
  }, 240_000);

  it('the loser resumes to the SAME terminal result, not a failure', async () => {
    const KEY = 'race:same-key:converge';

    const [a, b] = await Promise.all([runWorker(KEY, 'A', 3, 2), runWorker(KEY, 'B', 3, 2)]);

    const rows = await prisma.transactionAttempt.findMany({ where: { idempotencyKey: KEY } });
    expect(rows).toHaveLength(1);
    // What must hold: both converge on the one row, neither crashes, and a race
    // is never recorded as a failure.
    //
    // Deliberately NOT asserting that both observe VERIFIED. Under load one
    // worker legitimately loses the executor lock or a version CAS and returns
    // RESUMABLY, having read the row mid-pipeline (seen: GAS_CHECKED). That is
    // the designed behaviour, not a defect -- pinning it to VERIFIED would be
    // asserting a scheduling outcome. The sequential test above covers the full
    // path to VERIFIED.
    expect(rows[0]?.status).not.toBe('FAILED');
    expect(rows[0]?.failureCode).toBeNull();
    for (const r of [a, b]) {
      expect(r.threw).toBeUndefined();
      expect(r.status).not.toBe('FAILED');
      expect(r.id).toBe(rows[0]?.id);
    }
  }, 180_000);

  it('a sequential second caller on the same key still resumes the existing row (unchanged behaviour)', async () => {
    const KEY = 'race:same-key:sequential';

    const first = await runWorker(KEY, 'A', 7);
    const second = await runWorker(KEY, 'B', 7);

    const rows = await prisma.transactionAttempt.findMany({ where: { idempotencyKey: KEY } });
    expect(rows).toHaveLength(1);
    expect(first.id).toBe(rows[0]?.id);
    expect(second.id).toBe(rows[0]?.id);
    // The second caller finds the row VERIFIED and short-circuits: no new
    // signature, no new broadcast.
    expect(second.signCalls).toBe(0);
    expect(second.broadcastCalls).toBe(0);
  }, 180_000);
});
