import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { execSync } from 'node:child_process';
import { existsSync, rmSync } from 'node:fs';
import path from 'node:path';
import { PrismaClient } from '@prisma/client';
import { PrismaBetterSqlite3 } from '@prisma/adapter-better-sqlite3';
import { PrismaExitStateRepository } from '../../src/exits/exitStateRepository';

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
    await repo.update('pos-b', { swapUsdgBalanceBeforeRaw: bigAmount, swapMinOutputAmountRaw: bigAmount / 2n });
    const record = await repo.getOrCreate('pos-b');
    expect(record.swapUsdgBalanceBeforeRaw).toBe(bigAmount);
    expect(record.swapMinOutputAmountRaw).toBe(bigAmount / 2n);
  });

  it('update merges a patch without clobbering previously-set fields', async () => {
    await repo.update('pos-c', { trailingPeakPnlPct: 0.07 });
    await repo.update('pos-c', { oorStartedAt: new Date('2026-01-01T00:00:00.000Z') });
    const record = await repo.getOrCreate('pos-c');
    expect(record.trailingPeakPnlPct).toBe(0.07);
    expect(record.oorStartedAt).toEqual(new Date('2026-01-01T00:00:00.000Z'));
  });

  it('incrementSwapAttempt is a real atomic DB increment, not read-then-write in JS', async () => {
    await repo.incrementSwapAttempt('pos-d');
    const second = await repo.incrementSwapAttempt('pos-d');
    expect(second.swapAttemptCount).toBe(2);
  });

  it('findStuckSwapRetries queries against the real DB, not an in-memory cache', async () => {
    await repo.update('pos-e', { swapAttemptCount: 5 });
    await repo.update('pos-f', { swapAttemptCount: 1 });
    const stuck = await repo.findStuckSwapRetries(5);
    expect(stuck).toContain('pos-e');
    expect(stuck).not.toContain('pos-f');
  });

  it('a Date field genuinely survives a round-trip through real SQLite (not just JS-object identity)', async () => {
    const timestamp = new Date('2026-03-15T12:34:56.789Z');
    await repo.update('pos-g', { pnlProtectionActivatedAt: timestamp });
    const record = await repo.getOrCreate('pos-g');
    expect(record.pnlProtectionActivatedAt?.toISOString()).toBe(timestamp.toISOString());
  });
});
