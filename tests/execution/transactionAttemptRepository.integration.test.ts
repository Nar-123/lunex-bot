import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { execSync } from 'node:child_process';
import { existsSync, rmSync } from 'node:fs';
import path from 'node:path';
import { PrismaClient } from '@prisma/client';
import { PrismaBetterSqlite3 } from '@prisma/adapter-better-sqlite3';
import { PrismaTransactionAttemptRepository } from '../../src/execution/transactionAttemptRepository';
import type { TxRequest } from '../../src/execution/types';

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
});
