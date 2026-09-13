import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { execSync } from 'node:child_process';
import { existsSync, rmSync } from 'node:fs';
import path from 'node:path';
import { PrismaClient } from '@prisma/client';
import { PrismaBetterSqlite3 } from '@prisma/adapter-better-sqlite3';
import { PrismaCooldownRepository } from '../../src/cooldown/cooldownRepository';
import { PrismaPositionRepository } from '../../src/positions/positionRepository';
import { makeCreateInput } from '../positions/fixtures';

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

  describe('H17 regression: crash between Position.markClosed and cooldown.recordExit', () => {
    const TOKEN_C = '0x3333333333333333333333333333333333333333';

    it('markClosed succeeds, recordExit NEVER runs (simulated crash) -- cooldown is still reconstructed and reported active, entirely from Position.closedAt', async () => {
      const positions = new PrismaPositionRepository(prisma);
      const created = await positions.create(makeCreateInput({ tokenAddress: TOKEN_C, openIdempotencyKey: 'deploy:h17:1' }));
      await positions.markActive(created.id, '1', new Date());
      // markClosed succeeds (the real, durable write)...
      await positions.markClosed(created.id, new Date(), 'HARD_STOP_LOSS');
      // ...but recordExit is deliberately NEVER called -- simulates the
      // process dying between the two writes in composition/exitCycle.ts.

      const status = await repo.getCooldownStatus(TOKEN_C);

      expect(status.inCooldown).toBe(true);
      expect(status.remainingMs).toBeGreaterThan(0);
      expect(status.remainingMs).toBeLessThanOrEqual(2 * 60 * 60 * 1000);

      // Confirms the dedicated row genuinely never got written (proving
      // the reconstruction path, not the normal recordExit path, is what
      // produced the active-cooldown result above).
      const dedicatedRow = await prisma.tokenCooldown.findUnique({ where: { tokenAddress: TOKEN_C.toLowerCase() } });
      expect(dedicatedRow).toBeNull();
    });

    it('an OLD closed position (well past the cooldown window) with no recordExit ever having run correctly reports NOT in cooldown', async () => {
      const tokenD = '0x4444444444444444444444444444444444444444';
      const positions = new PrismaPositionRepository(prisma);
      const created = await positions.create(makeCreateInput({ tokenAddress: tokenD, openIdempotencyKey: 'deploy:h17:2' }));
      await positions.markActive(created.id, '1', new Date());
      const longAgo = new Date(Date.now() - 3 * 60 * 60 * 1000); // 3h ago > 2h cooldown
      await positions.markClosed(created.id, longAgo, 'HARD_STOP_LOSS');

      const status = await repo.getCooldownStatus(tokenD);
      expect(status).toEqual({ inCooldown: false, remainingMs: 0 });
    });

    it('reconstruction never WEAKENS an existing dedicated row -- the later of the two sources always wins', async () => {
      const tokenE = '0x5555555555555555555555555555555555555555';
      const positions = new PrismaPositionRepository(prisma);
      const created = await positions.create(makeCreateInput({ tokenAddress: tokenE, openIdempotencyKey: 'deploy:h17:3' }));
      await positions.markActive(created.id, '1', new Date());
      const earlierClose = new Date(Date.now() - 60 * 60 * 1000); // 1h ago
      await positions.markClosed(created.id, earlierClose, 'HARD_STOP_LOSS');
      // The dedicated row records a LATER exit (e.g. a subsequent
      // recordExit call for a different close of the same token) --
      // reconstruction from the OLDER position close must not shorten it.
      await repo.recordExit(tokenE, new Date()); // now, i.e. later than earlierClose

      const status = await repo.getCooldownStatus(tokenE);
      const expectedFromDedicatedRow = await prisma.tokenCooldown.findUnique({ where: { tokenAddress: tokenE.toLowerCase() } });
      expect(status.cooldownEndsAt).toBe(expectedFromDedicatedRow?.cooldownEndsAt.getTime());
    });
  });
});
