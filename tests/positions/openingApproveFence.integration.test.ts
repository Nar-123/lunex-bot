import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import type { Address } from 'viem';
import { execSync } from 'node:child_process';
import { existsSync, rmSync } from 'node:fs';
import path from 'node:path';
import { PrismaClient } from '@prisma/client';
import { PrismaBetterSqlite3 } from '@prisma/adapter-better-sqlite3';
import { PrismaPositionRepository } from '../../src/positions/positionRepository';
import { PrismaTransactionAttemptRepository } from '../../src/execution/transactionAttemptRepository';
import { executeCriticalTransaction } from '../../src/execution/executeCriticalTransaction';
import { withExecutorLock } from '../../src/execution/executorMutex';
import { openMintAttemptKey } from '../../src/positions/types';
import type { TxRequest, TxSafetyDeps } from '../../src/execution/types';
import { makeCreateInput } from './fixtures';

// Stuck-transaction audit, against the REAL migrated SQLite schema: H3
// expiry fences this lifecycle's not-yet-signed approve in the same
// transaction as the mint key and the position, blocks while an approve may
// have been broadcast, and a worker queued on the executor lock when the
// fence lands can never sign it.

const PROJECT_ROOT = path.resolve(__dirname, '../..');
const DB_PATH = path.resolve(PROJECT_ROOT, 'data', 'test-opening-approve-fence.db');
const DB_URL = `file:${DB_PATH}`;
const TX: TxRequest = { to: '0x1111111111111111111111111111111111111111', data: '0x095ea7b3', value: 0n };
const HASH = `0x${'ab'.repeat(32)}` as `0x${string}`;
const OLD = new Date('2026-09-18T00:00:00Z');
const LATER = new Date('2026-09-19T00:00:00Z');

function cleanup(): void {
  for (const suffix of ['', '-journal', '-wal', '-shm']) if (existsSync(DB_PATH + suffix)) rmSync(DB_PATH + suffix);
}

let prisma: PrismaClient;
let seq = 0x70;

beforeAll(() => {
  cleanup();
  execSync('npx prisma migrate deploy', { cwd: PROJECT_ROOT, env: { ...process.env, DATABASE_URL: DB_URL }, stdio: 'pipe' });
  prisma = new PrismaClient({ adapter: new PrismaBetterSqlite3({ url: DB_URL }) });
}, 30_000);

afterAll(async () => {
  await prisma.$disconnect();
  cleanup();
});

function deps(): TxSafetyDeps<{ ok: true }> {
  return {
    buildTransaction: vi.fn(async () => TX),
    simulate: vi.fn(async () => ({ ok: true }) as const),
    estimateGas: vi.fn(async () => 58_801n),
    getGasPrice: vi.fn(async () => 63_390_000n),
    checkGasAffordable: vi.fn(async () => ({ ok: true }) as const),
    getNonce: vi.fn(async () => 1600),
    signTransaction: vi.fn(async () => ({ raw: '0xdeadbeef' as `0x${string}`, hash: HASH })),
    broadcastRaw: vi.fn(async () => undefined),
    waitForReceipt: vi.fn(async () => ({ status: 'success' as const, blockNumber: 1n })),
    getReceiptIfAvailable: vi.fn(async () => null),
    verifyOnChain: vi.fn(async () => ({ ok: true as const, data: { ok: true as const } })),
  };
}

async function agedOpening(approveStatus: 'NONCE_ASSIGNED' | 'SIGNED' | null) {
  const positions = new PrismaPositionRepository(prisma);
  const txAttempts = new PrismaTransactionAttemptRepository(prisma);
  const token = `0x${(seq++).toString(16).padStart(40, '0')}` as Address;
  const p = await positions.create(makeCreateInput({ tokenAddress: token, openIdempotencyKey: `deploy:${token}:k` }));
  await prisma.position.update({ where: { id: p.id }, data: { createdAt: OLD } });
  const approveKey = `${p.openIdempotencyKey}:approve`;
  if (approveStatus) {
    const a = await txAttempts.create(approveKey, 'deploy:approve');
    await txAttempts.update(a.id, { status: approveStatus, nonce: 1600, ...(approveStatus === 'SIGNED' && { rawTx: '0xdeadbeef', txHash: HASH }) }, a.version);
  }
  return { positions, txAttempts, p, approveKey };
}

describe('H3 approve fence -- real SQLite', () => {
  it('approve at NONCE_ASSIGNED: fenced FAILED/OPENING_TIMEOUT in the SAME transaction as the mint key and the position; it can never be signed afterwards', async () => {
    const { positions, txAttempts, p, approveKey } = await agedOpening('NONCE_ASSIGNED');
    expect(await positions.expireStaleOpening(p.id, 1000, LATER)).toEqual({ outcome: 'EXPIRED', mintStatusBefore: null });
    expect((await prisma.position.findUniqueOrThrow({ where: { id: p.id } })).status).toBe('FAILED');
    expect(await prisma.transactionAttempt.findUniqueOrThrow({ where: { idempotencyKey: approveKey } })).toMatchObject({ status: 'FAILED', failureCode: 'OPENING_TIMEOUT', txHash: null });
    expect(await prisma.transactionAttempt.findUniqueOrThrow({ where: { idempotencyKey: openMintAttemptKey(p.openIdempotencyKey) } })).toMatchObject({ status: 'FAILED', failureCode: 'OPENING_TIMEOUT' });
    const d = deps();
    expect(await executeCriticalTransaction(approveKey, 'deploy:approve', d, txAttempts, { log: vi.fn() })).toMatchObject({ ok: false, resumable: false });
    expect(d.signTransaction).not.toHaveBeenCalled();
  });

  it('approve SIGNED (possibly broadcast): expiry BLOCKED -- nothing written, position keeps its reservation', async () => {
    const { positions, p, approveKey } = await agedOpening('SIGNED');
    expect(await positions.expireStaleOpening(p.id, 1000, LATER)).toEqual({ outcome: 'BLOCKED_UNRESOLVED_TX', mintStatus: 'NONE', approveStatus: 'SIGNED' });
    expect((await prisma.position.findUniqueOrThrow({ where: { id: p.id } })).status).toBe('OPENING');
    expect((await prisma.transactionAttempt.findUniqueOrThrow({ where: { idempotencyKey: approveKey } })).status).toBe('SIGNED');
    expect(await prisma.transactionAttempt.findUnique({ where: { idempotencyKey: openMintAttemptKey(p.openIdempotencyKey) } })).toBeNull();
  });

  it('race: an approve worker queued on the executor lock when the fence commits stops inside the lock -- no nonce, no signature', async () => {
    const { positions, txAttempts, p, approveKey } = await agedOpening(null);
    let release!: () => void;
    const hold = new Promise<void>((r) => { release = r; });
    const holder = withExecutorLock(async () => { await hold; });
    const d = deps();
    const worker = executeCriticalTransaction(approveKey, 'deploy:approve', d, txAttempts, { log: vi.fn() });
    await vi.waitFor(async () => expect((await txAttempts.find(approveKey))?.status).toBe('GAS_CHECKED'));
    expect((await positions.expireStaleOpening(p.id, 1000, LATER)).outcome).toBe('EXPIRED');
    release();
    await holder;
    expect(await worker).toMatchObject({ ok: false, resumable: false });
    expect(d.getNonce).not.toHaveBeenCalled();
    expect(d.signTransaction).not.toHaveBeenCalled();
    expect((await prisma.transactionAttempt.findUniqueOrThrow({ where: { idempotencyKey: approveKey } })).status).toBe('FAILED');
  });
});
