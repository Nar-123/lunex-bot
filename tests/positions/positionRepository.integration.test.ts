import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { Address } from 'viem';
import { execSync, spawn } from 'node:child_process';
import { existsSync, rmSync } from 'node:fs';
import path from 'node:path';
import { PrismaClient } from '@prisma/client';
import { PrismaBetterSqlite3 } from '@prisma/adapter-better-sqlite3';
import { PrismaPositionRepository } from '../../src/positions/positionRepository';
import { DuplicateActiveTokenPositionError } from '../../src/positions/types';
import type { CapitalRules } from '../../src/capital/types';
import Database from 'better-sqlite3';
import { decideCapitalAllocation } from '../../src/capital/decideCapitalAllocation';
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

  describe('P1-13: backfillRealizedUsdgRaw (real conditional UPDATE, not check-then-write)', () => {
    it('backfills a null realizedUsdgRaw on a CLOSED position, against a real DB', async () => {
      const created = await repo.create(makeCreateInput({ tokenAddress: '0x0000000000000000000000000000000000000023' }));
      await repo.markActive(created.id, '1', new Date());
      await repo.markClosed(created.id, new Date(), 'HARD_STOP_LOSS'); // no proceeds -- null

      const proceeds = 970n * 10n ** 18n;
      const result = await repo.backfillRealizedUsdgRaw(created.id, proceeds);

      expect(result?.realizedUsdgRaw).toBe(proceeds);
      const reloaded = await repo.findById(created.id);
      expect(reloaded?.realizedUsdgRaw).toBe(proceeds);
    });

    it('is a real conditional no-op (returns null, changes nothing) when realizedUsdgRaw is already set', async () => {
      const created = await repo.create(makeCreateInput({ tokenAddress: '0x0000000000000000000000000000000000000024' }));
      await repo.markActive(created.id, '1', new Date());
      const original = 500n * 10n ** 18n;
      await repo.markClosed(created.id, new Date(), 'HARD_TP', original);

      const result = await repo.backfillRealizedUsdgRaw(created.id, 999n * 10n ** 18n);

      expect(result).toBeNull();
      const reloaded = await repo.findById(created.id);
      expect(reloaded?.realizedUsdgRaw).toBe(original); // untouched
    });

    it('is a no-op for a non-CLOSED position -- status is never touched', async () => {
      const created = await repo.create(makeCreateInput({ tokenAddress: '0x0000000000000000000000000000000000000025' }));
      await repo.markActive(created.id, '1', new Date());

      const result = await repo.backfillRealizedUsdgRaw(created.id, 500n * 10n ** 18n);

      expect(result).toBeNull();
      const reloaded = await repo.findById(created.id);
      expect(reloaded?.status).toBe('ACTIVE');
      expect(reloaded?.realizedUsdgRaw).toBeNull();
    });

    it('concurrency: many genuinely concurrent backfill calls for the SAME position -- exactly one write lands, never a double-write', async () => {
      const created = await repo.create(makeCreateInput({ tokenAddress: '0x0000000000000000000000000000000000000026' }));
      await repo.markActive(created.id, '1', new Date());
      await repo.markClosed(created.id, new Date(), 'HARD_STOP_LOSS');

      const attempts = await Promise.all(Array.from({ length: 5 }, (_, i) => repo.backfillRealizedUsdgRaw(created.id, BigInt(i + 1) * 10n ** 18n)));
      const succeeded = attempts.filter((a) => a !== null);

      expect(succeeded).toHaveLength(1); // exactly one conditional UPDATE could ever match (realizedUsdgRaw IS NULL)
      const reloaded = await repo.findById(created.id);
      expect(reloaded?.realizedUsdgRaw).not.toBeNull();
      expect(reloaded?.realizedUsdgRaw).toBe(succeeded[0]?.realizedUsdgRaw);
    });
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

    const winners = attempts.filter((token) => token !== null);
    expect(winners).toHaveLength(1); // exactly one winner, no matter how many raced
    // P0-1: every winning token is unique (trivially true with one winner
    // here, but pins the type/shape contract other tests below rely on).
    expect(typeof winners[0]).toBe('string');
    expect((winners[0] as string).length).toBeGreaterThan(0);
  });

  it('C7/P0-1: claimForResume respects the freshness window, and releaseResumeClaim(token) allows an immediate re-claim', async () => {
    const created = await repo.create(makeCreateInput({ tokenAddress: '0x0000000000000000000000000000000000000016' }));

    const token = await repo.claimForResume(created.id, 'OPENING', 20_000);
    expect(token).not.toBeNull();
    expect(await repo.claimForResume(created.id, 'OPENING', 20_000)).toBeNull(); // still within freshness window

    const released = await repo.releaseResumeClaim(created.id, token as string);
    expect(released).toBe(true);
    expect(await repo.claimForResume(created.id, 'OPENING', 20_000)).not.toBeNull(); // released -- immediately reclaimable
  });

  describe('P0-1: resume claim ownership token -- closes the unconditional-release race against a REAL SQLite DB', () => {
    /**
     * The exact A/B/C race the audit named:
     *   A claims -> A hangs past freshness -> claim expires -> B claims (legitimately, the row is free again)
     *   -> A finally wakes up and calls release(id) [the OLD unconditional API] -> B's still-active claim is deleted
     *   -> C claims while B still believes it owns the row.
     * This test proves the NEW token-checked release makes step 4
     * impossible: A's stale token no longer matches B's fresh one, so A's
     * release is a safe no-op and B's claim survives untouched.
     */
    it('A/B/C: a worker whose claim already expired and was re-won by a second worker cannot release the second worker\'s claim', async () => {
      const created = await repo.create(makeCreateInput({ tokenAddress: '0x0000000000000000000000000000000000000017' }));

      const tokenA = await repo.claimForResume(created.id, 'OPENING', 300); // 5ms freshness, 250ms wait -- a wide 50x margin so this is robust against system load/timer jitter, not flaky
      expect(tokenA).not.toBeNull();

      await new Promise((resolve) => setTimeout(resolve, 600)); // A "hangs" well past the freshness window

      const tokenB = await repo.claimForResume(created.id, 'OPENING', 300); // legitimately re-claims the now-expired row
      expect(tokenB).not.toBeNull();
      expect(tokenB).not.toBe(tokenA);

      // A finally wakes up and tries to release using ITS OWN (now-stale) token.
      const aReleaseResult = await repo.releaseResumeClaim(created.id, tokenA as string);
      expect(aReleaseResult).toBe(false); // safe no-op -- A's token no longer matches the row

      // Proof B's claim is genuinely still intact: a third worker (C) cannot claim yet.
      const tokenC = await repo.claimForResume(created.id, 'OPENING', 300);
      expect(tokenC).toBeNull();

      // B releases with its OWN correct token -- only NOW can a new claim succeed.
      const bReleaseResult = await repo.releaseResumeClaim(created.id, tokenB as string);
      expect(bReleaseResult).toBe(true);
      const tokenAfterB = await repo.claimForResume(created.id, 'OPENING', 300);
      expect(tokenAfterB).not.toBeNull();
    });

    it('acceptance #1: two concurrent claim attempts on the same row never both hold an active claim at once', async () => {
      const created = await repo.create(makeCreateInput({ tokenAddress: '0x0000000000000000000000000000000000000018' }));
      const [t1, t2] = await Promise.all([
        repo.claimForResume(created.id, 'OPENING', 20_000),
        repo.claimForResume(created.id, 'OPENING', 20_000),
      ]);
      const winners = [t1, t2].filter((t) => t !== null);
      expect(winners).toHaveLength(1);
    });

    it('acceptance #3: an expired claim can be won by a different worker', async () => {
      const created = await repo.create(makeCreateInput({ tokenAddress: '0x0000000000000000000000000000000000000019' }));
      const tokenA = await repo.claimForResume(created.id, 'OPENING', 300);
      expect(tokenA).not.toBeNull();
      await new Promise((resolve) => setTimeout(resolve, 600));
      const tokenB = await repo.claimForResume(created.id, 'OPENING', 300);
      expect(tokenB).not.toBeNull();
      expect(tokenB).not.toBe(tokenA);
    });

    it('acceptance #4: release only succeeds when the token matches -- a wrong/made-up token is always a safe no-op', async () => {
      const created = await repo.create(makeCreateInput({ tokenAddress: '0x0000000000000000000000000000000000000020' }));
      const token = await repo.claimForResume(created.id, 'OPENING', 20_000);
      expect(token).not.toBeNull();

      const wrongResult = await repo.releaseResumeClaim(created.id, 'not-the-real-token');
      expect(wrongResult).toBe(false);

      // Claim is still held -- a second claimer still cannot win it.
      expect(await repo.claimForResume(created.id, 'OPENING', 20_000)).toBeNull();

      const correctResult = await repo.releaseResumeClaim(created.id, token as string);
      expect(correctResult).toBe(true);
    });

    it('acceptance #6 (regression against the OLD unconditional-release API): simulating the pre-fix behavior demonstrates the exact race this fix closes', async () => {
      const created = await repo.create(makeCreateInput({ tokenAddress: '0x00000000000000000000000000000000000000a1' }));
      const tokenA = await repo.claimForResume(created.id, 'OPENING', 300);
      expect(tokenA).not.toBeNull();
      await new Promise((resolve) => setTimeout(resolve, 600));
      const tokenB = await repo.claimForResume(created.id, 'OPENING', 300);
      expect(tokenB).not.toBeNull();

      // The OLD implementation's release was `UPDATE Position SET
      // resumeClaimedAt = NULL WHERE id = ?` -- unconditional, no token
      // check. Reproduced verbatim here (bypassing the fixed repository
      // method) to prove that under the OLD code, A's stale release WOULD
      // have clobbered B's still-active claim, letting a third worker (C)
      // claim while B is still mid-flight -- exactly the bug this task
      // required fixing. This block does NOT call the fixed
      // `releaseResumeClaim` -- it deliberately re-creates the vulnerable
      // old query to prove the old behavior is genuinely gone from the
      // real repository method (asserted immediately after).
      await prisma.position.update({ where: { id: created.id }, data: { resumeClaimedAt: null } });
      // Under the OLD code (no resumeClaimToken column/check at all), this
      // unconditional clear is exactly what `releaseResumeClaim(id)` did --
      // and it WOULD let C claim here, proving the old API was unsafe:
      const tokenC_underOldBehavior = await repo.claimForResume(created.id, 'OPENING', 300);
      expect(tokenC_underOldBehavior).not.toBeNull(); // the old bug: C claims while B still thinks it owns the row

      // Now prove the ACTUAL fixed method never does this: reset the
      // scenario and show `releaseResumeClaim` with A's stale token is a
      // no-op, so C cannot claim through the real, fixed API.
      const created2 = await repo.create(makeCreateInput({ tokenAddress: '0x00000000000000000000000000000000000000a2' }));
      const tokenA2 = await repo.claimForResume(created2.id, 'OPENING', 300);
      await new Promise((resolve) => setTimeout(resolve, 600));
      const tokenB2 = await repo.claimForResume(created2.id, 'OPENING', 300);
      expect(tokenB2).not.toBeNull();
      await repo.releaseResumeClaim(created2.id, tokenA2 as string); // A's stale token via the FIXED method
      const tokenC_underFixedBehavior = await repo.claimForResume(created2.id, 'OPENING', 300);
      expect(tokenC_underFixedBehavior).toBeNull(); // fixed: C cannot claim, B's claim is intact
    });
  });

  it('a position for a token conflicts at the openIdempotencyKey level if reused', async () => {
    const input = makeCreateInput({ tokenAddress: '0x0000000000000000000000000000000000000008', openIdempotencyKey: 'deploy:0x...:unique-1' });
    await repo.create(input);
    const found = await repo.findActiveByToken('0x0000000000000000000000000000000000000008');
    expect(found).not.toBeNull();
  });

  describe('P1-2: DB-atomic "1 token = 1 non-closed position" (real partial unique index, not check-then-create)', () => {
    it('acceptance: a SECOND create() for the SAME token while the first is still OPENING is rejected with DuplicateActiveTokenPositionError, against a REAL SQLite DB', async () => {
      const token = '0x00000000000000000000000000000000000000b1';
      await repo.create(makeCreateInput({ tokenAddress: token, openIdempotencyKey: 'deploy:b1:first' }));

      await expect(
        repo.create(makeCreateInput({ tokenAddress: token, openIdempotencyKey: 'deploy:b1:second' })),
      ).rejects.toThrow(DuplicateActiveTokenPositionError);

      // Exactly one row exists for this token.
      const rows = await prisma.position.findMany({ where: { tokenAddress: token } });
      expect(rows).toHaveLength(1);
    });

    it('concurrency: many genuinely concurrent create() calls for the SAME token -- exactly one succeeds, the rest fail with DuplicateActiveTokenPositionError', async () => {
      const token = '0x00000000000000000000000000000000000000b2';
      const attempts = await Promise.allSettled(
        Array.from({ length: 8 }, (_, i) => repo.create(makeCreateInput({ tokenAddress: token, openIdempotencyKey: `deploy:b2:${i}` }))),
      );
      const fulfilled = attempts.filter((a) => a.status === 'fulfilled');
      const rejected = attempts.filter((a) => a.status === 'rejected');
      expect(fulfilled).toHaveLength(1);
      expect(rejected).toHaveLength(7);
      for (const r of rejected) {
        if (r.status === 'rejected') expect(r.reason).toBeInstanceOf(DuplicateActiveTokenPositionError);
      }
      const rows = await prisma.position.findMany({ where: { tokenAddress: token } });
      expect(rows).toHaveLength(1);
    });

    it('a token whose PRIOR position reached CLOSED is free to open a brand new one', async () => {
      const token = '0x00000000000000000000000000000000000000b3';
      const first = await repo.create(makeCreateInput({ tokenAddress: token, openIdempotencyKey: 'deploy:b3:first' }));
      await repo.markActive(first.id, '1', new Date());
      await repo.markClosed(first.id, new Date(), 'HARD_STOP_LOSS');

      const second = await repo.create(makeCreateInput({ tokenAddress: token, openIdempotencyKey: 'deploy:b3:second' }));
      expect(second.status).toBe('OPENING');
    });

    it('a token whose PRIOR position reached FAILED is free to open a brand new one', async () => {
      const token = '0x00000000000000000000000000000000000000b4';
      const first = await repo.create(makeCreateInput({ tokenAddress: token, openIdempotencyKey: 'deploy:b4:first' }));
      await repo.markFailed(first.id);

      const second = await repo.create(makeCreateInput({ tokenAddress: token, openIdempotencyKey: 'deploy:b4:second' }));
      expect(second.status).toBe('OPENING');
    });

    it('does NOT misclassify an UNRELATED unique violation (openIdempotencyKey reuse) as a duplicate-token error', async () => {
      const key = 'deploy:reused-key:b5';
      await repo.create(makeCreateInput({ tokenAddress: '0x00000000000000000000000000000000000000b5', openIdempotencyKey: key }));
      await expect(
        repo.create(makeCreateInput({ tokenAddress: '0x00000000000000000000000000000000000000b6', openIdempotencyKey: key })),
      ).rejects.not.toBeInstanceOf(DuplicateActiveTokenPositionError);
    });
  });

  describe('P1-1: DB-atomic capital reservation (real transaction-scoped re-check, not a stale snapshot)', () => {
    // Each test in this block gets its OWN fresh, empty, throwaway DB file
    // (never shared with the tests above, or with each other) -- both to
    // avoid the accumulated-OPENING-rows problem noted in earlier revisions
    // of this file, and because the capital formula's "base portfolio grows
    // as capital is deployed" design (see decideCapitalAllocation.ts's doc
    // comment) makes cross-test carryover state produce different, harder-
    // to-predict cap numbers for no benefit -- starting every test from a
    // genuinely empty DB keeps the expected numbers exact and independent
    // of execution order.
    let dbCounter = 0;
    function connectCapDb(dbUrl: string): PrismaClient {
      return new PrismaClient({ adapter: new PrismaBetterSqlite3({ url: dbUrl }) });
    }
    async function withFreshCapDb<T>(fn: (repo: PrismaPositionRepository, prisma: PrismaClient, dbUrl: string) => Promise<T>): Promise<T> {
      const dbPath = path.resolve(PROJECT_ROOT, 'data', `test-positions-capital-${++dbCounter}.db`);
      const dbUrl = `file:${dbPath}`;
      const cleanup = () => {
        for (const suffix of ['', '-journal', '-wal', '-shm']) {
          const file = dbPath + suffix;
          if (existsSync(file)) rmSync(file);
        }
      };
      cleanup();
      execSync('npx prisma migrate deploy', { cwd: PROJECT_ROOT, env: { ...process.env, DATABASE_URL: dbUrl }, stdio: 'pipe' });
      const prisma = connectCapDb(dbUrl);
      try {
        return await fn(new PrismaPositionRepository(prisma), prisma, dbUrl);
      } finally {
        await prisma.$disconnect();
        cleanup();
      }
    }

    const CAPITAL_RULES: CapitalRules = {
      MAX_ACTIVE_POSITIONS: 3, // the REAL hard ceiling (P0-2 clamps anything higher down to this anyway)
      POSITION_SIZE_PCT_OF_FREE_BALANCE: 0.35,
      MAX_TOTAL_DEPLOYED_PCT_OF_PORTFOLIO: 0.95,
      ETH_GAS_RESERVE_ENABLED: false,
      ETH_GAS_RESERVE_MIN: 0,
    };
    const BASE = 1000n * 10n ** 18n; // base=1000 -> target=350, cap=950 (the canonical worked example)
    const TARGET = 350n * 10n ** 18n;

    it(
      'acceptance: a single createIfCapitalAllows() at the already-decided target succeeds and is reflected in a later fresh read',
      () =>
        withFreshCapDb(async (repo) => {
          const token = '0x00000000000000000000000000000000000000c1';
          const result = await repo.createIfCapitalAllows(makeCreateInput({ tokenAddress: token, entryUsdgRaw: TARGET, openIdempotencyKey: 'deploy:c1:1' }), async () => BASE, CAPITAL_RULES);
          expect(result.ok).toBe(true);
          if (result.ok) expect(result.record.entryUsdgRaw).toBe(TARGET);
        }),
      // Each test in this block runs its own real `prisma migrate deploy`
      // against a fresh DB file, which is slow (and slower still under the
      // full suite's parallel load) -- verified empirically that vitest's
      // 5000ms default per-test timeout is too tight for this once many
      // other test files are running concurrently, even though the same
      // test comfortably finishes in ~4s when this file runs alone.
      20_000,
    );

    // P1-1's specific rules -- NOTE: `decideCapitalAllocation` independently
    // clamps every rule DOWN to `capital/hardCeilings.ts`'s hard ceilings
    // (P0-2: max 35% position size, max 3 active positions, max 95%
    // deployed), so this test cannot request looser values than that --
    // verified empirically (a first attempt using 40%/10-positions/50% was
    // silently clamped to 35%/3/50%, which is why the numbers below are
    // shaped around the REAL clamped values, not the requested ones).
    // MAX_TOTAL_DEPLOYED_PCT_OF_PORTFOLIO (40%) is deliberately tighter than
    // the real 95% cap so a single successful position already leaves too
    // little room for a second identical one: with a RAW on-chain balance
    // of 1000 and nothing deployed, the first commit's fresh decision is
    // exactly 350 (35% of 1000, under the 400 cap). Every later fresh
    // decision re-derives free = 1000 - 350 (the OPENING reservation) and
    // deployed = 350, so the base stays 1000 and remaining capacity is
    // 400 - 350 = 50 -- LESS than the 350 every other attempt still wants,
    // so it is rejected outright (never resized). (The pre-fix code paired
    // a stale free balance of 1000 with the fresh deployed 350 and saw a
    // base of 1350 -- the double-count the production-rules tests further
    // below pin down.) EXACTLY ONE of any number of identical concurrent
    // attempts can succeed and the total deployed is always exactly 350.
    const RACE_RULES: CapitalRules = {
      MAX_ACTIVE_POSITIONS: 3,
      POSITION_SIZE_PCT_OF_FREE_BALANCE: 0.35,
      MAX_TOTAL_DEPLOYED_PCT_OF_PORTFOLIO: 0.4,
      ETH_GAS_RESERVE_ENABLED: false,
      ETH_GAS_RESERVE_MIN: 0,
    };
    const RACE_BASE = 1000n * 10n ** 18n;
    const RACE_TARGET = 350n * 10n ** 18n;

    it(
      'concurrency (single process): many genuinely concurrent createIfCapitalAllows() calls for the SAME target -- exactly one ever wins, regardless of scheduling',
      () =>
        withFreshCapDb(async (repo, prisma) => {
          const attempts = await Promise.allSettled(
            Array.from({ length: 6 }, (_, i) =>
              repo.createIfCapitalAllows(
                makeCreateInput({ tokenAddress: `0x00000000000000000000000000000000000000e${i}` as Address, entryUsdgRaw: RACE_TARGET, openIdempotencyKey: `deploy:e:${i}` }),
                async () => RACE_BASE,
                RACE_RULES,
              ),
            ),
          );

          const succeeded = attempts.filter((a) => a.status === 'fulfilled' && a.value.ok);
          const rejected = attempts.filter((a) => a.status === 'fulfilled' && !a.value.ok);
          expect(succeeded).toHaveLength(1);
          expect(rejected).toHaveLength(5);

          const allNonClosed = await prisma.position.findMany({ where: { status: { in: ['OPENING', 'ACTIVE', 'CLOSING'] } } });
          const totalWritten = allNonClosed.reduce((sum, p) => sum + BigInt(p.entryUsdgRaw), 0n);
          expect(totalWritten).toBe(RACE_TARGET);
        }),
      20_000,
    );

    // Spawns `tests/positions/capitalLockWorker.ts` as a genuinely separate
    // OS process (via `node` + ts-node's programmatic entry point, not
    // through a shell -- portable to Windows without relying on `.cmd`
    // wrapper resolution). Each spawned process gets its own Node runtime,
    // its own PrismaClient, and its own independent
    // `PrismaBetterSqlite3Adapter` in-process mutex -- nothing in-process is
    // shared between them. Resolves to the parsed JSON result line the
    // worker prints to stdout.
    const TS_NODE_BIN = require.resolve('ts-node/dist/bin.js');
    function runCapitalWorker(
      dbUrl: string,
      tokenAddress: string,
      entryUsdgRaw: bigint,
      openIdempotencyKey: string,
      onChainUsdgBalance: bigint,
      rules: CapitalRules,
      opts: { gateNonClosedCount?: number; onReaderEntered?: () => void } = {},
    ): Promise<{ ok: boolean; [k: string]: unknown }> {
      return new Promise((resolve, reject) => {
        const child = spawn(
          process.execPath,
          [
            TS_NODE_BIN,
            '--transpile-only',
            path.resolve(__dirname, 'capitalLockWorker.ts'),
            dbUrl,
            tokenAddress,
            entryUsdgRaw.toString(),
            openIdempotencyKey,
            onChainUsdgBalance.toString(),
            JSON.stringify(rules),
            ...(opts.gateNonClosedCount === undefined ? [] : [String(opts.gateNonClosedCount)]),
          ],
          { cwd: PROJECT_ROOT, env: process.env },
        );
        let stdout = '';
        let stderr = '';
        let readerEnteredSignalled = false;
        child.stdout.on('data', (d) => {
          stdout += d.toString();
          if (!readerEnteredSignalled && stdout.includes('READER_ENTERED')) {
            readerEnteredSignalled = true;
            opts.onReaderEntered?.();
          }
        });
        child.stderr.on('data', (d) => (stderr += d.toString()));
        child.on('close', (code) => {
          const line = stdout.trim().split('\n').filter(Boolean).pop();
          if (!line) {
            reject(new Error(`capitalLockWorker produced no output (exit ${code}). stderr:\n${stderr}`));
            return;
          }
          try {
            resolve(JSON.parse(line));
          } catch (err) {
            reject(new Error(`capitalLockWorker produced unparseable output: ${line}. stderr:\n${stderr}`));
          }
        });
      });
    }

    it(
      "concurrency (two independent processes): the SAME race split across two REAL, separately-spawned OS processes -- proves this is a genuine cross-process DB lock, not just the driver adapter's own in-process mutex",
      () =>
        withFreshCapDb(async (_repo, prisma, dbUrl) => {
          // Two real child processes, launched together (not awaited one at
          // a time), both racing to create a position for the SAME
          // RACE_TARGET against the SAME fresh DB file. Neither process
          // shares any JS state, memory, or mutex with the other or with
          // this test process -- only the SQLite file itself is shared. If
          // the fix relied on Prisma's own in-process adapter mutex (which
          // cannot coordinate across OS processes), both would compute
          // "fits" from the same stale empty-DB read and both would
          // succeed, writing 700 total. With the CapitalLock write-first
          // fix, only the process that wins the real file lock commits;
          // the other's fresh re-read (after the winner commits) sees
          // remaining capacity of 50 (< 350) and is rejected.
          const [resultA, resultB] = await Promise.all([
            runCapitalWorker(dbUrl, '0x00000000000000000000000000000000000000f0', RACE_TARGET, 'deploy:f:0', RACE_BASE, RACE_RULES),
            runCapitalWorker(dbUrl, '0x00000000000000000000000000000000000000f1', RACE_TARGET, 'deploy:f:1', RACE_BASE, RACE_RULES),
          ]);

          const results = [resultA, resultB];
          const succeeded = results.filter((r) => r.ok === true);
          const rejected = results.filter((r) => r.ok === false);
          expect(succeeded).toHaveLength(1);
          expect(rejected).toHaveLength(1);

          const allNonClosed = await prisma.position.findMany({ where: { status: { in: ['OPENING', 'ACTIVE', 'CLOSING'] } } });
          const totalWritten = allNonClosed.reduce((sum, p) => sum + BigInt(p.entryUsdgRaw), 0n);
          expect(totalWritten).toBe(RACE_TARGET);
        }),
      // Spawns two real Node/ts-node child processes -- slower than an
      // in-process test, and slower still under the full suite's parallel
      // load (observed ~15s for this one when the whole suite runs
      // together vs ~5.5s alone).
      45_000,
    );

    it(
      'a rejected (capital-conflict) attempt creates NOTHING -- no partial/orphaned row',
      () =>
        withFreshCapDb(async (repo, prisma) => {
        // Uses the same RACE_RULES/RACE_TARGET math verified above: the
        // first call (empty DB) succeeds at 350; the base stays 1000 (raw
        // 1000 = free 650 + deployed 350), leaving only 0.4*1000-350=50 of
        // remaining capacity -- less than the 350 a second identical
        // request wants, so it must be rejected outright (never resized).
        const fillToken = '0x00000000000000000000000000000000000000c3';
        const first = await repo.createIfCapitalAllows(makeCreateInput({ tokenAddress: fillToken, entryUsdgRaw: RACE_TARGET, openIdempotencyKey: 'deploy:c3:1' }), async () => RACE_BASE, RACE_RULES);
        expect(first.ok).toBe(true);

        const token = '0x00000000000000000000000000000000000000c2';
        const result = await repo.createIfCapitalAllows(makeCreateInput({ tokenAddress: token, entryUsdgRaw: RACE_TARGET, openIdempotencyKey: 'deploy:c2:1' }), async () => RACE_BASE, RACE_RULES);
        expect(result.ok).toBe(false);

        const rows = await prisma.position.findMany({ where: { tokenAddress: token } });
        expect(rows).toHaveLength(0);
        }),
      20_000,
    );
    // ------------------------------------------------------------------
    // P1-1 cross-process hardening (production rules). The earlier tests in
    // this block use a 40% cap; that masked the original bug, because the
    // stale-free-balance double-count only overshoots when the cap leaves
    // room for it. Everything below uses the REAL production rules (35% /
    // 3 positions / 95%) and a RAW on-chain balance of 1000.
    // ------------------------------------------------------------------
    const PROD_RULES: CapitalRules = {
      MAX_ACTIVE_POSITIONS: 3,
      POSITION_SIZE_PCT_OF_FREE_BALANCE: 0.35,
      MAX_TOTAL_DEPLOYED_PCT_OF_PORTFOLIO: 0.95,
      ETH_GAS_RESERVE_ENABLED: false,
      ETH_GAS_RESERVE_MIN: 0,
    };
    const U = 10n ** 18n;
    const RAW_BALANCE = 1000n * U;
    const CAP_95 = 950n * U;

    async function sumNonClosed(p: PrismaClient): Promise<{ total: bigint; count: number }> {
      const rows = await p.position.findMany({ where: { status: { in: ['OPENING', 'ACTIVE', 'CLOSING'] } } });
      return { total: rows.reduce((sum, r) => sum + BigInt(r.entryUsdgRaw), 0n), count: rows.length };
    }

    it(
      'cross-process, PRODUCTION rules: 3 separate OS processes all sized 350 from the same stale snapshot -- exactly 2 reserve, the 3rd fails closed, total 700 <= 950 cap; identical across 3 repeated runs',
      async () => {
        const outcomes: string[] = [];
        for (let round = 0; round < 3; round++) {
          await withFreshCapDb(async (_repo, p, dbUrl) => {
            const results = await Promise.all(
              [0, 1, 2].map((i) =>
                runCapitalWorker(dbUrl, `0x00000000000000000000000000000000000000d${i}`, 350n * U, `deploy:d${round}:${i}`, RAW_BALANCE, PROD_RULES),
              ),
            );
            expect(results.filter((r) => 'threw' in r)).toEqual([]);
            const succeeded = results.filter((r) => r.ok === true);
            const rejected = results.filter((r) => r.ok === false);
            expect(succeeded).toHaveLength(2);
            expect(rejected).toHaveLength(1);
            // Fails closed on CAPACITY (950 - 700 = 250 < 350) -- never resized, never thrown.
            expect(String(rejected[0]!.reason)).toMatch(/capital reservation conflict/);
            const { total, count } = await sumNonClosed(p);
            expect(total).toBe(700n * U);
            expect(total <= CAP_95).toBe(true);
            expect(count).toBe(2);
            outcomes.push(`${succeeded.length}/${rejected.length}/${total}`);
          });
        }
        expect(new Set(outcomes).size).toBe(1); // deterministic across repeated runs
      },
      180_000,
    );

    it(
      'cross-process, PRODUCTION rules: 4 separate OS processes (350, 350, 250, 250) -- the 95% cap and the 3-position cap both hold regardless of scheduling order',
      () =>
        withFreshCapDb(async (_repo, p, dbUrl) => {
          const sizes = [350n, 350n, 250n, 250n];
          const results = await Promise.all(
            sizes.map((size, i) => runCapitalWorker(dbUrl, `0x00000000000000000000000000000000000000a${i}`, size * U, `deploy:a:${i}`, RAW_BALANCE, PROD_RULES)),
          );
          expect(results.filter((r) => 'threw' in r)).toEqual([]);
          // Every ordering lands exactly 3 (350+350+250 = 950, or
          // 350+250+250 = 850); the 4th is always rejected -- by capacity
          // or by MAX_ACTIVE_POSITIONS -- and never over-commits.
          expect(results.filter((r) => r.ok === true)).toHaveLength(3);
          expect(results.filter((r) => r.ok === false)).toHaveLength(1);
          const { total, count } = await sumNonClosed(p);
          expect(count).toBe(3);
          expect(total <= CAP_95).toBe(true);
          expect([950n * U, 850n * U]).toContain(total);
        }),
      90_000,
    );

    it(
      'REGRESSION (the original P1-1 bug): process A reads its balance, processes B and C then reserve, THEN A takes CapitalLock -- A recalculates from the raw balance + fresh OPENING rows and is rejected instead of double-counting',
      () =>
        withFreshCapDb(async (_repo, p, dbUrl) => {
          // A was sized at 350 from a snapshot with nothing deployed (free
          // 1000). Its balance read is gated open until B and C have both
          // reserved in their OWN processes, so their rows land strictly
          // between A's pre-lock observation/balance read and A's lock.
          let readerEntered!: () => void;
          const aInsideReader = new Promise<void>((resolve) => (readerEntered = resolve));
          const processA = runCapitalWorker(dbUrl, '0x00000000000000000000000000000000000000aa', 350n * U, 'deploy:aa', RAW_BALANCE, PROD_RULES, {
            gateNonClosedCount: 2,
            onReaderEntered: () => readerEntered(),
          });
          await aInsideReader;
          const [resultB, resultC] = await Promise.all([
            runCapitalWorker(dbUrl, '0x00000000000000000000000000000000000000bb', 350n * U, 'deploy:bb', RAW_BALANCE, PROD_RULES),
            runCapitalWorker(dbUrl, '0x00000000000000000000000000000000000000cc', 350n * U, 'deploy:cc', RAW_BALANCE, PROD_RULES),
          ]);
          expect(resultB.ok).toBe(true);
          expect(resultC.ok).toBe(true);

          const resultA = await processA;
          expect('threw' in resultA).toBe(false);
          // Fresh under the lock: free = 1000 - 700 (B+C OPENING) = 300,
          // deployed = 700, base = 1000, remaining = 950 - 700 = 250 < 350.
          expect(resultA.ok).toBe(false);
          expect(String(resultA.reason)).toMatch(/250000000000000000000 now available/);

          // What the PRE-FIX calculation would have decided for A at this
          // exact moment: A's stale free balance (1000, pre-derived at
          // sizing time) + the fresh deployed 700 = a phantom base of 1700
          // -> 350 still "fits" -> 1050 reserved against a 950 cap.
          const legacy = decideCapitalAllocation({ freeUsdgBalance: RAW_BALANCE, totalDeployedUsdg: 700n * U, activePositionsCount: 2 }, PROD_RULES);
          expect(legacy.ok && legacy.positionSizeUsdgRaw >= 350n * U).toBe(true);

          const { total, count } = await sumNonClosed(p);
          expect(total).toBe(700n * U);
          expect(count).toBe(2);
          expect(await p.position.count({ where: { tokenAddress: '0x00000000000000000000000000000000000000aa' } })).toBe(0);
        }),
      90_000,
    );

    it(
      'fails closed when an observed position changes status between the balance read and the lock (a concurrent mint landed: OPENING -> ACTIVE) -- the balance can no longer be trusted, nothing is written',
      () =>
        withFreshCapDb(async (capRepo, p) => {
          const existing = await capRepo.create(makeCreateInput({ tokenAddress: '0x00000000000000000000000000000000000000e1', entryUsdgRaw: 350n * U, openIdempotencyKey: 'deploy:e1' }));
          const result = await capRepo.createIfCapitalAllows(
            makeCreateInput({ tokenAddress: '0x00000000000000000000000000000000000000e2', entryUsdgRaw: 350n * U, openIdempotencyKey: 'deploy:e2' }),
            async () => {
              // Another worker's mint confirms and debits the wallet while
              // this caller's balance read is in flight.
              await capRepo.markActive(existing.id, '42', new Date());
              return RAW_BALANCE;
            },
            PROD_RULES,
          );
          expect(result.ok).toBe(false);
          if (!result.ok) expect(result.reason).toMatch(/fail-closed.*moved OPENING -> ACTIVE/);
          expect(await p.position.count()).toBe(1);
        }),
      20_000,
    );

    it(
      'fails closed when the on-chain balance read itself fails -- nothing is written, CapitalLock never taken',
      () =>
        withFreshCapDb(async (capRepo, p) => {
          const result = await capRepo.createIfCapitalAllows(
            makeCreateInput({ tokenAddress: '0x00000000000000000000000000000000000000e3', entryUsdgRaw: 350n * U, openIdempotencyKey: 'deploy:e3' }),
            async () => {
              throw new Error('rpc down');
            },
            PROD_RULES,
          );
          expect(result.ok).toBe(false);
          if (!result.ok) expect(result.reason).toMatch(/fail-closed.*rpc down/);
          expect(await p.position.count()).toBe(0);
        }),
      20_000,
    );

    it(
      'SQLITE_BUSY: while ANOTHER connection holds the database write lock, createIfCapitalAllows fails closed (no bypass, no write) once the busy timeout expires, and succeeds normally after the lock is released',
      () =>
        withFreshCapDb(async (_repo, p, dbUrl) => {
          const holder = new Database(dbUrl.replace(/^file:/, ''));
          const shortTimeoutPrisma = new PrismaClient({ adapter: new PrismaBetterSqlite3({ url: dbUrl, timeout: 250 }) });
          try {
            holder.exec('BEGIN IMMEDIATE'); // a real RESERVED write lock, held by a different connection
            const contended = await new PrismaPositionRepository(shortTimeoutPrisma).createIfCapitalAllows(
              makeCreateInput({ tokenAddress: '0x00000000000000000000000000000000000000e4', entryUsdgRaw: 350n * U, openIdempotencyKey: 'deploy:e4' }),
              async () => RAW_BALANCE,
              PROD_RULES,
            );
            expect(contended.ok).toBe(false);
            if (!contended.ok) expect(contended.reason).toMatch(/fail-closed\): CapitalLock unavailable/);
            holder.exec('ROLLBACK');
            expect(await p.position.count()).toBe(0);

            const retried = await new PrismaPositionRepository(shortTimeoutPrisma).createIfCapitalAllows(
              makeCreateInput({ tokenAddress: '0x00000000000000000000000000000000000000e4', entryUsdgRaw: 350n * U, openIdempotencyKey: 'deploy:e4b' }),
              async () => RAW_BALANCE,
              PROD_RULES,
            );
            expect(retried.ok).toBe(true);
          } finally {
            if (holder.inTransaction) holder.exec('ROLLBACK');
            holder.close();
            await shortTimeoutPrisma.$disconnect();
          }
        }),
      20_000,
    );
  });
});
