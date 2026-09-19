import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { execSync, spawn } from 'node:child_process';
import { existsSync, rmSync } from 'node:fs';
import path from 'node:path';
import { PrismaClient } from '@prisma/client';
import { PrismaBetterSqlite3 } from '@prisma/adapter-better-sqlite3';
import { PrismaExitStateRepository } from '../../src/exits/exitStateRepository';
import { PrismaPositionRepository } from '../../src/positions/positionRepository';
import { ExitStateMonotonicityError } from '../../src/exits/types';
import { makeCreateInput } from '../positions/fixtures';

const PROJECT_ROOT = path.resolve(__dirname, '../..');
const TEST_DB_PATH = path.resolve(PROJECT_ROOT, 'data', 'test-exitstate-integration.db');
const TEST_DB_URL = `file:${TEST_DB_PATH}`;

function cleanupDbFiles(): void {
  for (const suffix of ['', '-journal', '-wal', '-shm']) {
    const file = TEST_DB_PATH + suffix;
    if (existsSync(file)) rmSync(file);
  }
}

let prisma: PrismaClient;
let repo: PrismaExitStateRepository;

beforeAll(() => {
  cleanupDbFiles();
  execSync('npx prisma migrate deploy', {
    cwd: PROJECT_ROOT,
    env: { ...process.env, DATABASE_URL: TEST_DB_URL },
    stdio: 'pipe',
  });
  const adapter = new PrismaBetterSqlite3({ url: TEST_DB_URL });
  prisma = new PrismaClient({ adapter });
  repo = new PrismaExitStateRepository(prisma);
}, 30_000);

afterAll(async () => {
  await prisma.$disconnect();
  cleanupDbFiles();
});

describe('PrismaExitStateRepository (real SQLite DB, real migration)', () => {
  it('getOrCreate creates an all-null/zero row on first use', async () => {
    const record = await repo.getOrCreate('pos-a');
    expect(record.trailingPeakPnlPct).toBeNull();
    expect(record.swapAttemptCount).toBe(0);
    expect(record.swapUsdgBalanceBeforeRaw).toBeNull();
  });

  it('round-trips an extreme USDG raw bigint (18-decimal amount) through swapUsdgBalanceBeforeRaw exactly as a string, never overflowing', async () => {
    const bigAmount = 1_000_000n * 10n ** 18n; // far beyond SQLite's 64-bit signed INTEGER range
    await repo.getOrCreate('pos-b');
    expect(await repo.updateSwapLegFields('pos-b', 0, { swapUsdgBalanceBeforeRaw: bigAmount, swapMinOutputAmountRaw: bigAmount / 2n })).toBe(true);
    const record = await repo.getOrCreate('pos-b');
    expect(record.swapUsdgBalanceBeforeRaw).toBe(bigAmount);
    expect(record.swapMinOutputAmountRaw).toBe(bigAmount / 2n);
  });

  it('P1: swapVerifiedUsdgIncreaseRaw defaults to null, round-trips an extreme bigint exactly, and can be reset to null', async () => {
    expect((await repo.getOrCreate('pos-h')).swapVerifiedUsdgIncreaseRaw).toBeNull();
    const big = 123_456_789n * 10n ** 18n + 1n;
    await repo.updateSwapLegFields('pos-h', 0, { swapVerifiedUsdgIncreaseRaw: big });
    expect((await repo.getOrCreate('pos-h')).swapVerifiedUsdgIncreaseRaw).toBe(big);
    await repo.updateSwapLegFields('pos-h', 0, { swapVerifiedUsdgIncreaseRaw: null });
    expect((await repo.getOrCreate('pos-h')).swapVerifiedUsdgIncreaseRaw).toBeNull();
  });

  it('updateDecisionState merges a patch without clobbering previously-set fields, bumping version once per write', async () => {
    const v1 = (await repo.getOrCreate('pos-c')).version;
    const after1 = await repo.updateDecisionState('pos-c', v1, { trailingPeakPnlPct: 0.07 });
    const after2 = await repo.updateDecisionState('pos-c', after1!.version, { oorStartedAt: new Date('2026-01-01T00:00:00.000Z') });
    expect(after2!.version).toBe(v1 + 2);
    const record = await repo.getOrCreate('pos-c');
    expect(record.trailingPeakPnlPct).toBe(0.07);
    expect(record.oorStartedAt).toEqual(new Date('2026-01-01T00:00:00.000Z'));
  });

  it('incrementSwapAttemptFrom is a real atomic conditional DB increment, not read-then-write in JS', async () => {
    await repo.getOrCreate('pos-d');
    expect(await repo.incrementSwapAttemptFrom('pos-d', 0)).toBe(true);
    expect(await repo.incrementSwapAttemptFrom('pos-d', 1)).toBe(true);
    expect(await repo.incrementSwapAttemptFrom('pos-d', 1)).toBe(false); // that failure was already recorded
    expect((await repo.getOrCreate('pos-d')).swapAttemptCount).toBe(2);
  });

  it('findStuckSwapRetries queries against the real DB, not an in-memory cache', async () => {
    await repo.getOrCreate('pos-e');
    for (let n = 0; n < 5; n++) await repo.incrementSwapAttemptFrom('pos-e', n);
    await repo.getOrCreate('pos-f');
    await repo.incrementSwapAttemptFrom('pos-f', 0);
    const stuck = await repo.findStuckSwapRetries(5);
    expect(stuck).toContain('pos-e');
    expect(stuck).not.toContain('pos-f');
  });

  it('a Date field genuinely survives a round-trip through real SQLite (not just JS-object identity)', async () => {
    const timestamp = new Date('2026-03-15T12:34:56.789Z');
    const { version } = await repo.getOrCreate('pos-g');
    await repo.updateDecisionState('pos-g', version, { safetyExitArmedAt: timestamp });
    const record = await repo.getOrCreate('pos-g');
    expect(record.safetyExitArmedAt?.toISOString()).toBe(timestamp.toISOString());
  });
});

describe('ExitState stale-writer fix (real SQLite DB, real migration)', () => {
  const T = new Date('2026-09-18T02:00:00.000Z');

  it("a stale version is rejected by the real conditional UPDATE: A reads, B writes, then A's stale write matches zero rows and changes nothing", async () => {
    const a = await repo.getOrCreate('pos-cas');
    const b = await repo.updateDecisionState('pos-cas', a.version, { oorStartedAt: T });
    expect(b?.version).toBe(a.version + 1);
    expect(await repo.updateDecisionState('pos-cas', a.version, { oorStartedAt: null })).toBeNull();
    expect((await repo.getOrCreate('pos-cas')).oorStartedAt?.toISOString()).toBe(T.toISOString());
  });

  it('two independent connections racing the same version: exactly one decision write wins', async () => {
    const other = new PrismaClient({ adapter: new PrismaBetterSqlite3({ url: TEST_DB_URL }) });
    try {
      const { version } = await repo.getOrCreate('pos-race');
      const results = await Promise.all([
        repo.updateDecisionState('pos-race', version, { oorStartedAt: T }),
        new PrismaExitStateRepository(other).updateDecisionState('pos-race', version, { oorStartedAt: new Date(T.getTime() + 1) }),
      ]);
      expect(results.filter((r) => r !== null)).toHaveLength(1);
      expect((await repo.getOrCreate('pos-race')).version).toBe(version + 1);
    } finally {
      await other.$disconnect();
    }
  });

  it('the monotonic guard holds against the real DB: an armed safety exit cannot be cleared even at the current version', async () => {
    const { version } = await repo.getOrCreate('pos-mono');
    const armed = await repo.updateDecisionState('pos-mono', version, { safetyExitArmedAt: T });
    await expect(repo.updateDecisionState('pos-mono', armed!.version, { safetyExitArmedAt: null })).rejects.toBeInstanceOf(ExitStateMonotonicityError);
    expect((await repo.getOrCreate('pos-mono')).safetyExitArmedAt?.toISOString()).toBe(T.toISOString());
  });

  it('restart: a new PrismaClient reads back the same version, counter and sticky arming; a pre-restart snapshot stays rejected', async () => {
    const before = await repo.getOrCreate('pos-restart');
    await repo.incrementSwapAttemptFrom('pos-restart', 0);
    const armed = await repo.updateDecisionState('pos-restart', before.version + 1, { safetyExitArmedAt: T });
    const restartedClient = new PrismaClient({ adapter: new PrismaBetterSqlite3({ url: TEST_DB_URL }) });
    try {
      const restarted = new PrismaExitStateRepository(restartedClient);
      const reread = await restarted.getOrCreate('pos-restart');
      expect(reread).toMatchObject({ version: armed!.version, swapAttemptCount: 1 });
      expect(reread.safetyExitArmedAt?.toISOString()).toBe(T.toISOString());
      expect(await restarted.updateDecisionState('pos-restart', before.version, { oorStartedAt: T })).toBeNull();
    } finally {
      await restartedClient.$disconnect();
    }
  });

  const TS_NODE_BIN = require.resolve('ts-node/dist/bin.js');
  function runWorker(...args: string[]): Promise<Record<string, unknown>> {
    return new Promise((resolve, reject) => {
      const child = spawn(process.execPath, [TS_NODE_BIN, '--transpile-only', path.resolve(__dirname, 'exitStateWorker.ts'), TEST_DB_URL, ...args], { cwd: PROJECT_ROOT, env: process.env });
      let out = '';
      child.stdout.on('data', (d) => (out += d.toString()));
      child.on('close', () => {
        const line = out.trim().split(String.fromCharCode(10)).filter(Boolean).pop();
        if (!line) reject(new Error('exitStateWorker produced no output'));
        else resolve(JSON.parse(line));
      });
    });
  }

  it(
    'two separate OS processes: (a) both record the SAME swap failure -> the counter advances exactly once; (b) both write the same decision version -> exactly one wins; (c) both try to start the same exit -> exactly one markClosing wins',
    async () => {
      await repo.getOrCreate('pos-proc');
      const inc = await Promise.all([runWorker('increment', 'pos-proc', '0'), runWorker('increment', 'pos-proc', '0')]);
      expect(inc.filter((r) => 'threw' in r)).toEqual([]);
      expect(inc.filter((r) => r.applied === true)).toHaveLength(1);
      const afterInc = await repo.getOrCreate('pos-proc');
      expect(afterInc.swapAttemptCount).toBe(1);

      const dec = await Promise.all([
        runWorker('decide', 'pos-proc', String(afterInc.version), T.toISOString()),
        runWorker('decide', 'pos-proc', String(afterInc.version), 'null'),
      ]);
      expect(dec.filter((r) => 'threw' in r)).toEqual([]);
      expect(dec.filter((r) => r.written === true)).toHaveLength(1);
      expect((await repo.getOrCreate('pos-proc')).version).toBe(afterInc.version + 1);

      const positions = new PrismaPositionRepository(prisma);
      const p = await positions.create(makeCreateInput({ tokenAddress: '0x00000000000000000000000000000000000000c9', openIdempotencyKey: 'deploy:proc-closing' }));
      await positions.markActive(p.id, '9', new Date());
      const closing = await Promise.all([runWorker('markClosing', p.id, 'exit:proc:A'), runWorker('markClosing', p.id, 'exit:proc:B')]);
      expect(closing.filter((r) => 'threw' in r)).toEqual([]);
      expect(closing.filter((r) => r.won === true)).toHaveLength(1);
      const row = await positions.findById(p.id);
      expect(row?.status).toBe('CLOSING');
      expect(['exit:proc:A', 'exit:proc:B']).toContain(row?.closeIdempotencyKey);
    },
    90_000,
  );
});
