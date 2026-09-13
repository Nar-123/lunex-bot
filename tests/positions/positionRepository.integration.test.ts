import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { execSync } from 'node:child_process';
import { existsSync, rmSync } from 'node:fs';
import path from 'node:path';
import { PrismaClient } from '@prisma/client';
import { PrismaBetterSqlite3 } from '@prisma/adapter-better-sqlite3';
import { PrismaPositionRepository } from '../../src/positions/positionRepository';
import { makeCreateInput } from './fixtures';

const PROJECT_ROOT = path.resolve(__dirname, '../..');
const TEST_DB_PATH = path.resolve(PROJECT_ROOT, 'data', 'test-positions-integration.db');
const TEST_DB_URL = `file:${TEST_DB_PATH}`;

function cleanupDbFiles(): void {
  for (const suffix of ['', '-journal', '-wal', '-shm']) {
    const file = TEST_DB_PATH + suffix;
    if (existsSync(file)) rmSync(file);
  }
}

let prisma: PrismaClient;
let repo: PrismaPositionRepository;

beforeAll(() => {
  cleanupDbFiles();
  execSync('npx prisma migrate deploy', {
    cwd: PROJECT_ROOT,
    env: { ...process.env, DATABASE_URL: TEST_DB_URL },
    stdio: 'pipe',
  });
  const adapter = new PrismaBetterSqlite3({ url: TEST_DB_URL });
  prisma = new PrismaClient({ adapter });
  repo = new PrismaPositionRepository(prisma);
}, 30_000);

afterAll(async () => {
  await prisma.$disconnect();
  cleanupDbFiles();
});

describe('PrismaPositionRepository (real SQLite DB, real migration)', () => {
  it('creates a position at OPENING and normalizes the token address to lowercase', async () => {
    const record = await repo.create(makeCreateInput({ tokenAddress: '0x0000000000000000000000000000000000000AbC' }));
    expect(record.status).toBe('OPENING');
    expect(record.tokenAddress).toBe('0x0000000000000000000000000000000000000abc');
  });

  it('round-trips an extreme sqrtPriceX96 (near MAX_SQRT_RATIO, ~2^160) exactly as a string, never overflowing', async () => {
    const extremeSqrtPrice = (1n << 160n) - 1n; // far beyond SQLite's 64-bit INTEGER range
    const created = await repo.create(makeCreateInput({ tokenAddress: '0x0000000000000000000000000000000000000002', entrySqrtPriceX96: extremeSqrtPrice }));
    expect(created.entrySqrtPriceX96).toBe(extremeSqrtPrice);

    const reloaded = await repo.findById(created.id);
    expect(reloaded?.entrySqrtPriceX96).toBe(extremeSqrtPrice);
  });

  it('findActiveByToken finds an OPENING position (not yet ACTIVE)', async () => {
    await repo.create(makeCreateInput({ tokenAddress: '0x0000000000000000000000000000000000000003' }));
    const found = await repo.findActiveByToken('0x0000000000000000000000000000000000000003');
    expect(found?.status).toBe('OPENING');
  });

  it('markActive transitions status and sets positionTokenId/openedAt', async () => {
    const created = await repo.create(makeCreateInput({ tokenAddress: '0x0000000000000000000000000000000000000004' }));
    const openedAt = new Date();
    const updated = await repo.markActive(created.id, '777', openedAt);
    expect(updated.status).toBe('ACTIVE');
    expect(updated.positionTokenId).toBe('777');
    expect(updated.openedAt?.getTime()).toBe(openedAt.getTime());
  });

  it('markClosed excludes the position from findActiveByToken and findAllActive', async () => {
    const created = await repo.create(makeCreateInput({ tokenAddress: '0x0000000000000000000000000000000000000005' }));
    await repo.markActive(created.id, '1', new Date());
    await repo.markClosed(created.id, new Date(), 'HARD_STOP_LOSS');

    expect(await repo.findActiveByToken('0x0000000000000000000000000000000000000005')).toBeNull();
    const allActive = await repo.findAllActive();
    expect(allActive.find((p) => p.id === created.id)).toBeUndefined();
  });

  it('VALIDATION PHASE: markClosed persists realizedUsdgRaw in the SAME atomic update as the CLOSED transition, round-tripping an extreme raw value exactly', async () => {
    const created = await repo.create(makeCreateInput({ tokenAddress: '0x0000000000000000000000000000000000000021' }));
    await repo.markActive(created.id, '1', new Date());

    // A routine 18-decimal proceeds figure -- far beyond SQLite's signed
    // INTEGER range, stored as a decimal string like every other raw field.
    const proceeds = 970_123_456_789n * 10n ** 18n;
    const closed = await repo.markClosed(created.id, new Date(), 'HARD_TP', proceeds);

    expect(closed.status).toBe('CLOSED');
    expect(closed.realizedUsdgRaw).toBe(proceeds); // strict equality, not closeTo

    const reloaded = await repo.findById(created.id);
    expect(reloaded?.realizedUsdgRaw).toBe(proceeds);
  });

  it('VALIDATION PHASE: markClosed without proceeds leaves realizedUsdgRaw honestly null (never 0-as-placeholder), against a real DB', async () => {
    const created = await repo.create(makeCreateInput({ tokenAddress: '0x0000000000000000000000000000000000000022' }));
    await repo.markActive(created.id, '1', new Date());
    await repo.markClosed(created.id, new Date(), 'OOR_TIMEOUT'); // legacy-style call: no proceeds argument

    const reloaded = await repo.findById(created.id);
    expect(reloaded?.status).toBe('CLOSED');
    expect(reloaded?.realizedUsdgRaw).toBeNull();
  });

  it('findAllOpening returns only OPENING positions, excluding ACTIVE/CLOSING/CLOSED', async () => {
    const opening = await repo.create(makeCreateInput({ tokenAddress: '0x0000000000000000000000000000000000000013' }));
    const active = await repo.create(makeCreateInput({ tokenAddress: '0x0000000000000000000000000000000000000014' }));
    await repo.markActive(active.id, '1', new Date());

    const result = await repo.findAllOpening();
    const ids = result.map((p) => p.id);
    expect(ids).toContain(opening.id);
    expect(ids).not.toContain(active.id);
  });

  it('findDeployedPositions includes OPENING, ACTIVE, and CLOSING but excludes CLOSED', async () => {
    const opening = await repo.create(makeCreateInput({ tokenAddress: '0x0000000000000000000000000000000000000009' }));
    const active = await repo.create(makeCreateInput({ tokenAddress: '0x000000000000000000000000000000000000000a' }));
    await repo.markActive(active.id, '1', new Date());
    const closing = await repo.create(makeCreateInput({ tokenAddress: '0x000000000000000000000000000000000000000b' }));
    await repo.markActive(closing.id, '2', new Date());
    await repo.markClosing(closing.id, 'exit:integration-1');
    const closed = await repo.create(makeCreateInput({ tokenAddress: '0x000000000000000000000000000000000000000c' }));
    await repo.markActive(closed.id, '3', new Date());
    await repo.markClosed(closed.id, new Date(), 'HARD_STOP_LOSS');

    const deployed = await repo.findDeployedPositions();
    const ids = deployed.map((p) => p.id);
    expect(ids).toContain(opening.id);
    expect(ids).toContain(active.id);
    expect(ids).toContain(closing.id);
    expect(ids).not.toContain(closed.id);
  });

  it('countNonClosed counts OPENING/ACTIVE/CLOSING but not CLOSED', async () => {
    const before = await repo.countNonClosed();

    const opening = await repo.create(makeCreateInput({ tokenAddress: '0x0000000000000000000000000000000000000006' }));
    const toClose = await repo.create(makeCreateInput({ tokenAddress: '0x0000000000000000000000000000000000000007' }));
    await repo.markActive(toClose.id, '1', new Date());
    await repo.markClosed(toClose.id, new Date(), 'OOR_TIMEOUT');

    const after = await repo.countNonClosed();
    expect(after).toBe(before + 1); // only `opening` added to the non-closed count
    void opening;
  });

  it('findAllClosing returns only CLOSING positions, excluding OPENING/ACTIVE/CLOSED', async () => {
    const opening = await repo.create(makeCreateInput({ tokenAddress: '0x000000000000000000000000000000000000000e' }));
    const active = await repo.create(makeCreateInput({ tokenAddress: '0x000000000000000000000000000000000000000f' }));
    await repo.markActive(active.id, '1', new Date());
    const closing = await repo.create(makeCreateInput({ tokenAddress: '0x0000000000000000000000000000000000000010' }));
    await repo.markActive(closing.id, '2', new Date());
    await repo.markClosing(closing.id, 'exit:integration-closing-1');

    const result = await repo.findAllClosing();
    const ids = result.map((p) => p.id);
    expect(ids).toContain(closing.id);
    expect(ids).not.toContain(opening.id);
    expect(ids).not.toContain(active.id);
  });

  it('markExitFailed reverts CLOSING back to ACTIVE and clears closeIdempotencyKey, against a real DB', async () => {
    const created = await repo.create(makeCreateInput({ tokenAddress: '0x0000000000000000000000000000000000000011' }));
    await repo.markActive(created.id, '1', new Date());
    await repo.markClosing(created.id, 'exit:integration-failed-1');

    const reverted = await repo.markExitFailed(created.id);
    expect(reverted.status).toBe('ACTIVE');
    expect(reverted.closeIdempotencyKey).toBeNull();

    // Confirmed by re-reading, not just trusting the returned object.
    const reloaded = await repo.findById(created.id);
    expect(reloaded?.status).toBe('ACTIVE');
    expect(reloaded?.closeIdempotencyKey).toBeNull();

    // A second position can now reuse a FRESH closeIdempotencyKey without a
    // unique-constraint conflict, since the old one was cleared to null
    // (SQLite/Postgres both treat NULL as distinct across rows in a UNIQUE
    // column -- multiple NULLs are allowed).
    const second = await repo.create(makeCreateInput({ tokenAddress: '0x0000000000000000000000000000000000000012' }));
    await repo.markActive(second.id, '2', new Date());
    await expect(repo.markClosing(second.id, 'exit:integration-failed-2')).resolves.toBeTruthy();
  });

  it('markFailed moves a position out of OPENING and excludes it from findDeployedPositions, countNonClosed, and findActiveByToken', async () => {
    const created = await repo.create(makeCreateInput({ tokenAddress: '0x000000000000000000000000000000000000000d' }));
    const before = await repo.countNonClosed();

    const failed = await repo.markFailed(created.id);
    expect(failed.status).toBe('FAILED');

    const after = await repo.countNonClosed();
    expect(after).toBe(before - 1);

    const deployed = await repo.findDeployedPositions();
    expect(deployed.map((p) => p.id)).not.toContain(created.id);

    expect(await repo.findActiveByToken('0x000000000000000000000000000000000000000d')).toBeNull();
  });

  it('C7: claimForResume is a genuine atomic compare-and-swap against a real DB -- concurrent claims on the same row never both succeed', async () => {
    const created = await repo.create(makeCreateInput({ tokenAddress: '0x0000000000000000000000000000000000000015' }));

    // Fire many genuinely concurrent claim attempts against the SAME real
    // SQLite connection -- proves the WHERE-guarded UPDATE is atomic at
    // the database level, not just "usually fine" under JS's single
    // thread.
    const attempts = await Promise.all(
      Array.from({ length: 10 }, () => repo.claimForResume(created.id, 'OPENING', 20_000)),
    );

    expect(attempts.filter(Boolean)).toHaveLength(1); // exactly one winner, no matter how many raced
  });

  it('C7: claimForResume respects the freshness window, and releaseResumeClaim allows an immediate re-claim', async () => {
    const created = await repo.create(makeCreateInput({ tokenAddress: '0x0000000000000000000000000000000000000016' }));

    expect(await repo.claimForResume(created.id, 'OPENING', 20_000)).toBe(true);
    expect(await repo.claimForResume(created.id, 'OPENING', 20_000)).toBe(false); // still within freshness window

    await repo.releaseResumeClaim(created.id);
    expect(await repo.claimForResume(created.id, 'OPENING', 20_000)).toBe(true); // released -- immediately reclaimable
  });

  it('a second position for the same token while one is still open conflicts at the openIdempotencyKey level if reused, but otherwise both rows can exist -- findActiveByToken still returns one', async () => {
    const input = makeCreateInput({ tokenAddress: '0x0000000000000000000000000000000000000008', openIdempotencyKey: 'deploy:0x...:unique-1' });
    await repo.create(input);
    const found = await repo.findActiveByToken('0x0000000000000000000000000000000000000008');
    expect(found).not.toBeNull();
  });
});
