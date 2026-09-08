import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { execSync } from 'node:child_process';
import { existsSync, rmSync } from 'node:fs';
import path from 'node:path';
import { PrismaClient } from '@prisma/client';
import { PrismaBetterSqlite3 } from '@prisma/adapter-better-sqlite3';
import { PrismaCooldownRepository } from '../../src/cooldown/cooldownRepository';

/**
 * Real integration test: runs the ACTUAL `prisma migrate deploy` against a
 * throwaway SQLite file (same migration files that ship in
 * prisma/migrations/), then exercises `PrismaCooldownRepository` against a
 * real Prisma Client + driver adapter -- not mocked. Storage is exactly
 * the kind of thing that's cheap enough to test for real (a local SQLite
 * file, no network) and important enough (crash-recoverable, never
 * in-memory-only critical state, per the project's storage principles)
 * that it's worth the extra setup cost over unit-testing the pure logic
 * alone.
 */
const PROJECT_ROOT = path.resolve(__dirname, '../..');
const TEST_DB_PATH = path.resolve(PROJECT_ROOT, 'data', 'test-cooldown-integration.db');
const TEST_DB_URL = `file:${TEST_DB_PATH}`;

function cleanupDbFiles(): void {
  for (const suffix of ['', '-journal', '-wal', '-shm']) {
    const file = TEST_DB_PATH + suffix;
    if (existsSync(file)) rmSync(file);
  }
}

let prisma: PrismaClient;
let repo: PrismaCooldownRepository;

beforeAll(() => {
  cleanupDbFiles();
  execSync('npx prisma migrate deploy', {
    cwd: PROJECT_ROOT,
    env: { ...process.env, DATABASE_URL: TEST_DB_URL },
    stdio: 'pipe',
  });
  const adapter = new PrismaBetterSqlite3({ url: TEST_DB_URL });
  prisma = new PrismaClient({ adapter });
  repo = new PrismaCooldownRepository(prisma);
}, 30_000);

afterAll(async () => {
  await prisma.$disconnect();
  cleanupDbFiles();
});

const TOKEN_A = '0x1111111111111111111111111111111111111111';
const TOKEN_B = '0x2222222222222222222222222222222222222222';

describe('PrismaCooldownRepository (real SQLite DB, real migration)', () => {
  it('reports no cooldown for a token that has never exited', async () => {
    const status = await repo.getCooldownStatus(TOKEN_A);
    expect(status).toEqual({ inCooldown: false, remainingMs: 0 });
  });

  it('reports an active cooldown immediately after recordExit', async () => {
    await repo.recordExit(TOKEN_A);
    const status = await repo.getCooldownStatus(TOKEN_A);
    expect(status.inCooldown).toBe(true);
    expect(status.remainingMs).toBeGreaterThan(0);
    expect(status.remainingMs).toBeLessThanOrEqual(2 * 60 * 60 * 1000);
  });

  it('normalizes address casing -- a differently-cased lookup finds the same row', async () => {
    const upperCase = TOKEN_A.toUpperCase().replace('0X', '0x');
    const status = await repo.getCooldownStatus(upperCase);
    expect(status.inCooldown).toBe(true);
  });

  it('does not affect an unrelated token (per-token, never global)', async () => {
    const status = await repo.getCooldownStatus(TOKEN_B);
    expect(status).toEqual({ inCooldown: false, remainingMs: 0 });
  });

  it('recordExit on an already-cooling-down token restarts the cooldown (upsert, not duplicate rows)', async () => {
    const before = await repo.getCooldownStatus(TOKEN_A);
    await repo.recordExit(TOKEN_A);
    const after = await repo.getCooldownStatus(TOKEN_A);
    expect(after.inCooldown).toBe(true);
    expect(after.cooldownEndsAt ?? 0).toBeGreaterThanOrEqual(before.cooldownEndsAt ?? 0);
  });

  it('an exit far enough in the past reports not-in-cooldown (already expired)', async () => {
    const longAgo = new Date(Date.now() - 3 * 60 * 60 * 1000); // 3h ago > 2h cooldown
    await repo.recordExit(TOKEN_B, longAgo);
    const status = await repo.getCooldownStatus(TOKEN_B);
    expect(status).toEqual({ inCooldown: false, remainingMs: 0 });
  });
});
