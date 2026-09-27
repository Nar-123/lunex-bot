import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { execSync } from 'node:child_process';
import { existsSync, rmSync } from 'node:fs';
import path from 'node:path';
import { PrismaClient } from '@prisma/client';
import { PrismaBetterSqlite3 } from '@prisma/adapter-better-sqlite3';
import { PrismaTransactionAttemptRepository } from '../../src/execution/transactionAttemptRepository';
import type { TxRequest } from '../../src/execution/types';
import { StaleTransactionAttemptWriteError } from '../../src/execution/types';

/** Real integration test, same pattern as cooldown's -- runs the actual migrations against a throwaway SQLite file. */
const PROJECT_ROOT = path.resolve(__dirname, '../..');
const TEST_DB_PATH = path.resolve(PROJECT_ROOT, 'data', 'test-execution-integration.db');
const TEST_DB_URL = `file:${TEST_DB_PATH}`;

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
  execSync('npx prisma migrate deploy', {
    cwd: PROJECT_ROOT,
    env: { ...process.env, DATABASE_URL: TEST_DB_URL },
    stdio: 'pipe',
  });
  const adapter = new PrismaBetterSqlite3({ url: TEST_DB_URL });
  prisma = new PrismaClient({ adapter });
  repo = new PrismaTransactionAttemptRepository(prisma);
}, 30_000);

afterAll(async () => {
  await prisma.$disconnect();
  cleanupDbFiles();
});

const TX: TxRequest = { to: '0x1111111111111111111111111111111111111111', data: '0xabcdef', value: 123n };

describe('PrismaTransactionAttemptRepository (real SQLite DB, real migration)', () => {
  it('creates a new attempt at PENDING', async () => {
    const record = await repo.create('key-1', 'OPEN_POSITION token=0xabc');
    expect(record.status).toBe('PENDING');
    expect(record.idempotencyKey).toBe('key-1');
  });

  /**
   * `findSignedNoncesAtOrAbove` is the "already spent" set the nonce allocator
   * skips (see `nonceAllocation.ts`). Its safety rests on four properties of
   * THIS query, none of which the in-memory fake can prove: the predicate is
   * "a signed payload exists" (`rawTx` set), terminal rows count, the
   * `minNonce` bound is inclusive, and the result is ascending.
   */
  describe('findSignedNoncesAtOrAbove -- the nonce allocator spent set', () => {
    it('returns an empty list when nothing has ever been signed', async () => {
      const created = await repo.create('spent-none', 'p');
      await repo.update(created.id, { status: 'NONCE_ASSIGNED', nonce: 4 });

      // A reserved-but-unsigned nonce is NOT spent: nothing was broadcast under
      // it, so it must stay reclaimable.
      expect(await repo.findSignedNoncesAtOrAbove(0)).toEqual([]);
    });

    it('excludes an attempt that reserved a nonce but never signed', async () => {
      const signed = await repo.create('spent-signed', 'p');
      await repo.update(signed.id, { status: 'SIGNED', nonce: 7, rawTx: '0xaa', txHash: '0xbb' });
      const reservedOnly = await repo.create('spent-reserved', 'p');
      await repo.update(reservedOnly.id, { status: 'NONCE_ASSIGNED', nonce: 99 });

      // 99 is reserved, not signed. The allocator skips it via the reserved set
      // (from findNonTerminal), never via this query.
      expect(await repo.findSignedNoncesAtOrAbove(0)).toEqual([7]);
    });

    it('INCLUDES terminal rows -- a VERIFIED nonce is the most certainly-spent of all', async () => {
      const verified = await repo.create('spent-verified', 'p');
      await repo.update(verified.id, {
        status: 'VERIFIED',
        nonce: 120,
        rawTx: '0x11',
        txHash: '0x22',
        verifyData: { ok: true },
      });

      // VERIFIED is invisible to findNonTerminal(), which is exactly why the
      // allocator cannot derive its spent set from that query alone.
      expect((await repo.findNonTerminal()).map((a) => a.nonce)).not.toContain(120);
      expect(await repo.findSignedNoncesAtOrAbove(120)).toContain(120);
    });

    it('includes a FAILED row that had already signed (its nonce is dead, never free)', async () => {
      const failed = await repo.create('spent-failed-signed', 'p');
      await repo.update(failed.id, {
        status: 'FAILED',
        failureCode: 'BROADCAST_REJECTED',
        nonce: 200,
        rawTx: '0x33',
        txHash: '0x44',
      });

      expect(await repo.findSignedNoncesAtOrAbove(200)).toEqual([200]);
    });

    it('does NOT include a FAILED row that never signed -- that nonce stays reclaimable', async () => {
      const fenced = await repo.create('spent-failed-unsigned', 'p');
      await repo.update(fenced.id, { status: 'FAILED', failureCode: 'OPENING_TIMEOUT', nonce: 205 });

      expect(await repo.findSignedNoncesAtOrAbove(205)).toEqual([]);
    });

    it('applies minNonce inclusively and returns ascending order', async () => {
      // 7, 120 and 200 were signed by the cases above.
      expect(await repo.findSignedNoncesAtOrAbove(0)).toEqual([7, 120, 200]);
      expect(await repo.findSignedNoncesAtOrAbove(7)).toEqual([7, 120, 200]);
      expect(await repo.findSignedNoncesAtOrAbove(8)).toEqual([120, 200]);
      expect(await repo.findSignedNoncesAtOrAbove(201)).toEqual([]);
    });

    it('a rotated executor at nonce 0 sees the old history but none of its own pointer', async () => {
      // The rotation case: the old wallet's nonces are all >= 0 and so are
      // returned, but the allocator skips only those exact values -- a fresh
      // account still starts at its own pointer.
      const spent = await repo.findSignedNoncesAtOrAbove(0);

      expect(spent).not.toContain(0);
      expect(spent.every((n) => n > 0)).toBe(true);
    });
  });

  it('find returns null for a key that was never created', async () => {
    const record = await repo.find('does-not-exist');
    expect(record).toBeNull();
  });

  it('round-trips a TxRequest (including a bigint value field) through JSON storage exactly', async () => {
    const created = await repo.create('key-2', 'p');
    const updated = await repo.update(created.id, { status: 'BUILT', txRequest: TX });
    expect(updated.txRequest).toEqual(TX);
    expect(typeof updated.txRequest?.value).toBe('bigint');

    const reloaded = await repo.find('key-2');
    expect(reloaded?.txRequest).toEqual(TX);
  });

  it('round-trips gasLimit/gasPrice as real bigints, not strings', async () => {
    const created = await repo.create('key-3', 'p');
    const updated = await repo.update(created.id, {
      status: 'GAS_CHECKED',
      gasLimit: 100_000n,
      gasPrice: 1_000_000_000n,
    });
    expect(updated.gasLimit).toBe(100_000n);
    expect(updated.gasPrice).toBe(1_000_000_000n);
  });

  it('persists rawTx/txHash independently of broadcast success (the crash-safety property)', async () => {
    const created = await repo.create('key-4', 'p');
    const updated = await repo.update(created.id, {
      status: 'SIGNED',
      rawTx: '0xf86c0102',
      txHash: '0xdead',
      nonce: 5,
    });
    expect(updated.rawTx).toBe('0xf86c0102');
    expect(updated.txHash).toBe('0xdead');
    expect(updated.nonce).toBe(5);
  });

  it('a second create() with the same idempotencyKey conflicts rather than silently duplicating', async () => {
    await repo.create('key-5', 'p');
    await expect(repo.create('key-5', 'p again')).rejects.toThrow();
  });

  it('round-trips failureCode, attemptCount, and firstAttemptedAt', async () => {
    const created = await repo.create('key-6', 'p');
    expect(created.failureCode).toBeNull();
    expect(created.attemptCount).toBe(0);
    expect(created.firstAttemptedAt).toBeNull();

    const firstAttemptedAt = new Date();
    const updated = await repo.update(created.id, {
      attemptCount: 1,
      firstAttemptedAt,
      status: 'FAILED',
      failureCode: 'BROADCAST_REJECTED',
      lastError: 'insufficient funds',
    });
    expect(updated.attemptCount).toBe(1);
    expect(updated.firstAttemptedAt?.getTime()).toBe(firstAttemptedAt.getTime());
    expect(updated.failureCode).toBe('BROADCAST_REJECTED');

    const reloaded = await repo.find('key-6');
    expect(reloaded?.failureCode).toBe('BROADCAST_REJECTED');
    expect(reloaded?.attemptCount).toBe(1);
  });

  it('findNonTerminal returns only non-VERIFIED/FAILED attempts', async () => {
    await repo.create('nonterm-1', 'p'); // stays PENDING
    const toFail = await repo.create('nonterm-2', 'p');
    await repo.update(toFail.id, { status: 'FAILED', failureCode: 'REVERTED' });
    const toVerify = await repo.create('nonterm-3', 'p');
    await repo.update(toVerify.id, { status: 'VERIFIED' });
    const stillSent = await repo.create('nonterm-4', 'p');
    await repo.update(stillSent.id, { status: 'SENT' });

    const nonTerminal = await repo.findNonTerminal();
    const keys = nonTerminal.map((r) => r.idempotencyKey);
    expect(keys).toContain('nonterm-1');
    expect(keys).toContain('nonterm-4');
    expect(keys).not.toContain('nonterm-2');
    expect(keys).not.toContain('nonterm-3');
  });

  describe('P1-5: optimistic-concurrency version (real SQLite compare-and-swap)', () => {
    it('create() starts every attempt at version 1', async () => {
      const created = await repo.create('cas-1', 'p');
      expect(created.version).toBe(1);
    });

    it('a successful update() (unconditional, no expectedVersion) still increments version', async () => {
      const created = await repo.create('cas-2', 'p');
      const updated = await repo.update(created.id, { status: 'BUILT' });
      expect(updated.version).toBe(2);
    });

    it('acceptance: a CURRENT writer (expectedVersion matches) succeeds and bumps the version', async () => {
      const created = await repo.create('cas-3', 'p');
      const updated = await repo.update(created.id, { status: 'BUILT' }, created.version);
      expect(updated.status).toBe('BUILT');
      expect(updated.version).toBe(created.version + 1);
    });

    it('acceptance: a STALE writer (expectedVersion no longer matches) fails -- throws StaleTransactionAttemptWriteError, writes nothing', async () => {
      const created = await repo.create('cas-4', 'p');
      // A "newer" writer advances the row first.
      const afterFirstWrite = await repo.update(created.id, { status: 'BUILT' }, created.version);
      expect(afterFirstWrite.version).toBe(created.version + 1);

      // The STALE writer still holds the OLD version it originally read.
      await expect(
        repo.update(created.id, { status: 'SIMULATED' }, created.version),
      ).rejects.toThrow(StaleTransactionAttemptWriteError);

      // Nothing from the stale writer's patch was applied.
      const reloaded = await repo.find('cas-4');
      expect(reloaded?.status).toBe('BUILT'); // NOT 'SIMULATED'
      expect(reloaded?.version).toBe(created.version + 1); // unchanged by the failed write
    });

    it('acceptance: state cannot regress -- a stale writer holding an OLDER snapshot (e.g. BUILT) cannot overwrite a NEWER state (e.g. VERIFIED) even with a plausible-looking patch', async () => {
      const created = await repo.create('cas-5', 'p');
      const built = await repo.update(created.id, { status: 'BUILT' }, created.version); // version 2
      // Meanwhile, a DIFFERENT (newer) writer races ahead all the way to VERIFIED.
      const simulated = await repo.update(built.id, { status: 'SIMULATED' }, built.version); // version 3
      const verified = await repo.update(simulated.id, { status: 'VERIFIED' }, simulated.version); // version 4

      // The FIRST writer, still holding its stale `built` snapshot (version 2), tries to advance from what IT thinks is the current state.
      await expect(
        repo.update(created.id, { status: 'SIMULATED' }, built.version),
      ).rejects.toThrow(StaleTransactionAttemptWriteError);

      const reloaded = await repo.find('cas-5');
      expect(reloaded?.status).toBe('VERIFIED'); // untouched -- never regressed from VERIFIED back to SIMULATED
      expect(reloaded?.version).toBe(verified.version);
    });

    it('concurrency: many genuinely concurrent conditional updates against the SAME version -- exactly one wins, the rest fail with StaleTransactionAttemptWriteError', async () => {
      const created = await repo.create('cas-6', 'p');
      const attempts = await Promise.allSettled(
        Array.from({ length: 10 }, (_, i) => repo.update(created.id, { attemptCount: i + 1 }, created.version)),
      );
      const fulfilled = attempts.filter((a) => a.status === 'fulfilled');
      const rejected = attempts.filter((a) => a.status === 'rejected');
      expect(fulfilled).toHaveLength(1); // exactly one winner, no matter how many raced
      expect(rejected).toHaveLength(9);
      for (const r of rejected) {
        if (r.status === 'rejected') expect(r.reason).toBeInstanceOf(StaleTransactionAttemptWriteError);
      }
    });
  });
});
