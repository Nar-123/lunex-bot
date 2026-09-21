import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import type { Address } from 'viem';
import { execSync, spawn } from 'node:child_process';
import { existsSync, rmSync } from 'node:fs';
import path from 'node:path';
import Database from 'better-sqlite3';
import { PrismaClient } from '@prisma/client';
import { PrismaBetterSqlite3 } from '@prisma/adapter-better-sqlite3';
import { PrismaPositionRepository } from '../../src/positions/positionRepository';
import { PrismaTransactionAttemptRepository } from '../../src/execution/transactionAttemptRepository';
import { PrismaExitStateRepository } from '../../src/exits/exitStateRepository';
import { executeExit } from '../../src/exits/executeExit';
import { assessClosingRecovery } from '../../src/exits/closingRecovery';
import { exitLegKeyPrefix } from '../../src/capital/freshCapitalSnapshot';
import { config } from '../../src/config';
import type { TxRequest, TxSafetyDeps } from '../../src/execution/types';
import type { SwapExecutor, SwapQuote } from '../../src/swap/types';
import { DuplicateActiveTokenPositionError } from '../../src/positions/types';
import { makeCreateInput } from '../positions/fixtures';
import { grantAlreadyValid } from './tokenGrantTestStub';

// Unroutable TOKEN leg against the REAL migrated SQLite schema: the block is
// durable across a restart, the operator classification is rebuilt from
// durable state alone, a later recovery closes without repeating any leg,
// a crash inside the recovering finalization rolls back cleanly, and two
// separate OS processes recording the block cannot corrupt it.

const PROJECT_ROOT = path.resolve(__dirname, '../..');
const DB_PATH = path.resolve(PROJECT_ROOT, 'data', 'test-unroutable-token-leg.db');
const DB_URL = `file:${DB_PATH}`;
const U = 10n ** 18n;
const WALLET = '0x9999999999999999999999999999999999999999' as Address;
const TS_NODE_BIN = require.resolve('ts-node/dist/bin.js');
const TX: TxRequest = { to: '0x1111111111111111111111111111111111111111', data: '0xabcdef', value: 0n };
const RESIDUAL = 3n * U;

function cleanup(): void {
  for (const suffix of ['', '-journal', '-wal', '-shm']) {
    if (existsSync(DB_PATH + suffix)) rmSync(DB_PATH + suffix);
  }
}

let prisma: PrismaClient;
let tokenSeq = 0x40;

beforeAll(() => {
  cleanup();
  execSync('npx prisma migrate deploy', { cwd: PROJECT_ROOT, env: { ...process.env, DATABASE_URL: DB_URL }, stdio: 'pipe' });
  prisma = new PrismaClient({ adapter: new PrismaBetterSqlite3({ url: DB_URL }) });
}, 30_000);

afterAll(async () => {
  await prisma.$disconnect();
  cleanup();
});

function injectFailure(name: string, sql: string): () => void {
  const db = new Database(DB_PATH);
  db.exec(`CREATE TRIGGER "${name}" ${sql}`);
  db.close();
  return () => {
    const d = new Database(DB_PATH);
    d.exec(`DROP TRIGGER IF EXISTS "${name}"`);
    d.close();
  };
}

function fakeTxDeps<T>(data: T): TxSafetyDeps<T> {
  return {
    buildTransaction: vi.fn(async () => TX),
    simulate: vi.fn(async () => ({ ok: true }) as const),
    estimateGas: vi.fn(async () => 100_000n),
    getGasPrice: vi.fn(async () => 1n),
    checkGasAffordable: vi.fn(async () => ({ ok: true }) as const),
    getNonce: vi.fn(async () => 7),
    signTransaction: vi.fn(async () => ({ raw: '0xdeadbeef' as `0x${string}`, hash: `0x${'ab'.repeat(32)}` as `0x${string}` })),
    broadcastRaw: vi.fn(async () => undefined),
    waitForReceipt: vi.fn(async () => ({ status: 'success' as const, blockNumber: 1n })),
    getReceiptIfAvailable: vi.fn(async () => null),
    verifyOnChain: vi.fn(async () => ({ ok: true as const, data })),
  };
}

const QUOTE: SwapQuote = { amountInRaw: RESIDUAL, expectedAmountOutRaw: 290n * U, minOutputAmountRaw: 0n, priceImpactPct: 0.001, slippageBps: 100, providerQuote: {} };
const noQuote = (): SwapExecutor => ({ getQuote: vi.fn(async () => { throw new Error('HTTP 404 No quotes available'); }), checkApproval: vi.fn(), buildSwapTx: vi.fn() });
const routable = (): SwapExecutor => ({ getQuote: vi.fn(async () => QUOTE), checkApproval: vi.fn(async () => ({ needsApproval: false, spender: null })), buildSwapTx: vi.fn(async () => TX) });

async function blockedClosingPosition() {
  const positions = new PrismaPositionRepository(prisma);
  const token = `0x${(tokenSeq++).toString(16).padStart(40, '0')}` as Address;
  const created = await positions.create(makeCreateInput({ tokenAddress: token, entryUsdgRaw: 500n * U, openIdempotencyKey: `deploy:${token}` }));
  await positions.markActive(created.id, '1', new Date());
  const closing = (await positions.markClosing(created.id, `exit:${created.id}:1`))!;
  const exitStates = new PrismaExitStateRepository(prisma);
  await exitStates.updateDecisionState(created.id, (await exitStates.getOrCreate(created.id)).version, { pendingCloseReason: 'HARD_STOP_LOSS' });
  const removeDeps = fakeTxDeps({ liquidityZero: true as const, usdgProceedsRaw: 200n * U, tokenProceedsRaw: RESIDUAL });
  const swapDeps = fakeTxDeps({ usdgIncreaseRaw: 290n * U, usdgProceedsRaw: 290n * U });
  const deps = (client: PrismaClient, swapExecutor: SwapExecutor) => ({
    positions: new PrismaPositionRepository(client),
    exitStates: new PrismaExitStateRepository(client),
    txAttempts: new PrismaTransactionAttemptRepository(client),
    livePositionState: { getLiveState: vi.fn() },
    poolPrice: { getPriceState: vi.fn() },
    swapExecutor,
    tokenGrantPreflight: grantAlreadyValid,
    buildRemoveLiquidityDeps: vi.fn(() => removeDeps),
    buildSwapDeps: vi.fn(() => swapDeps),
    readTokenBalance: vi.fn(async () => RESIDUAL),
    readAllowance: vi.fn(async () => 0n),
    walletAddress: WALLET,
    warnLog: vi.fn(),
  });
  const assess = async (client: PrismaClient, now = new Date()) => {
    const p = (await new PrismaPositionRepository(client).findById(created.id))!;
    const legs = await new PrismaTransactionAttemptRepository(client).findByKeyPrefixes([exitLegKeyPrefix(closing.closeIdempotencyKey!)]);
    return assessClosingRecovery(p, legs, await new PrismaExitStateRepository(client).getOrCreate(created.id), now);
  };
  return { token, id: created.id, closing, removeDeps, swapDeps, deps, assess };
}

const countCooldownRows = (token: string) => prisma.tokenCooldown.count({ where: { tokenAddress: token.toLowerCase() } });

describe('Unroutable TOKEN leg -- real SQLite', () => {
  it('(E, D, K) restart: the block persists, the classification is rebuilt from durable state only, and a later recovery closes with ONE remove, ONE swap, ONE cooldown and exactly remove+swap USDG', async () => {
    const ctx = await blockedClosingPosition();
    expect((await executeExit(ctx.closing, ctx.deps(prisma, noQuote()))).outcome).toBe('PENDING');
    const firstSince = (await prisma.exitState.findUniqueOrThrow({ where: { positionId: ctx.id } })).swapLegBlockedSince;
    await new Promise((r) => setTimeout(r, 5));
    expect((await executeExit(ctx.closing, ctx.deps(prisma, noQuote()))).outcome).toBe('PENDING');
    expect((await prisma.exitState.findUniqueOrThrow({ where: { positionId: ctx.id } })).swapLegBlockedSince).toEqual(firstSince); // one continuous block

    const restarted = new PrismaClient({ adapter: new PrismaBetterSqlite3({ url: DB_URL }) });
    try {
      const row = await restarted.exitState.findUniqueOrThrow({ where: { positionId: ctx.id } });
      expect(row).toMatchObject({ swapLegBlockedReason: 'QUOTE_UNAVAILABLE', swapAttemptCount: 0 });
      expect(row.swapLegBlockedSince).toBeInstanceOf(Date);
      const later = new Date(row.swapLegBlockedSince!.getTime() + config.rules.execution.STUCK_ATTEMPT_MAX_AGE_MS);
      expect(await ctx.assess(restarted, later)).toMatchObject({ phase: 'QUOTE_UNAVAILABLE', operatorActionRequired: true, tokenResidualRaw: RESIDUAL, usdgRecoveredRaw: 200n * U });
      expect(await restarted.position.findUniqueOrThrow({ where: { id: ctx.id } })).toMatchObject({ status: 'CLOSING', realizedUsdgRaw: null });
      expect(await countCooldownRows(ctx.token)).toBe(0);

      // The route comes back: the restarted process finishes the exit.
      expect(await executeExit(ctx.closing, ctx.deps(restarted, routable()))).toEqual({ outcome: 'CLOSED' });
    } finally {
      await restarted.$disconnect();
    }
    expect(ctx.removeDeps.broadcastRaw).toHaveBeenCalledTimes(1);
    expect(ctx.swapDeps.broadcastRaw).toHaveBeenCalledTimes(1);
    expect(await prisma.position.findUniqueOrThrow({ where: { id: ctx.id } })).toMatchObject({ status: 'CLOSED', realizedUsdgRaw: (490n * U).toString() });
    expect(await countCooldownRows(ctx.token)).toBe(1);
    expect((await prisma.exitState.findUniqueOrThrow({ where: { positionId: ctx.id } })).swapLegBlockedReason).toBeNull();
  });

  it('(E) crash inside the recovering finalization: rolled back (CLOSING, no proceeds, no cooldown); the retry finalizes from the verified swap without re-swapping', async () => {
    const ctx = await blockedClosingPosition();
    await executeExit(ctx.closing, ctx.deps(prisma, noQuote()));
    const heal = injectFailure('crash_unroutable_finalize', `BEFORE INSERT ON "TokenCooldown" BEGIN SELECT RAISE(ABORT, 'killed'); END;`);
    try {
      await expect(executeExit(ctx.closing, ctx.deps(prisma, routable()))).rejects.toThrow(/tx\.tokenCooldown\.create\(\)/);
    } finally {
      heal();
    }
    expect(await prisma.position.findUniqueOrThrow({ where: { id: ctx.id } })).toMatchObject({ status: 'CLOSING', realizedUsdgRaw: null });
    expect(await countCooldownRows(ctx.token)).toBe(0);
    expect((await ctx.assess(prisma)).phase).toBe('READY_TO_FINALIZE');

    expect(await executeExit(ctx.closing, ctx.deps(prisma, routable()))).toEqual({ outcome: 'CLOSED' });
    expect(ctx.swapDeps.broadcastRaw).toHaveBeenCalledTimes(1);
    expect(await countCooldownRows(ctx.token)).toBe(1);
  });

  it('(J, I) while stuck on the real schema: the partial unique index still blocks re-entry of the token, the CLOSING position still takes a slot and stays in deployed capital', async () => {
    const ctx = await blockedClosingPosition();
    await executeExit(ctx.closing, ctx.deps(prisma, noQuote()));
    const positions = new PrismaPositionRepository(prisma);
    await expect(positions.create(makeCreateInput({ tokenAddress: ctx.token, openIdempotencyKey: `deploy:reentry:${ctx.token}` }))).rejects.toBeInstanceOf(DuplicateActiveTokenPositionError);
    const nonClosed = await prisma.position.findMany({ where: { status: { in: ['OPENING', 'ACTIVE', 'CLOSING'] } }, select: { id: true } });
    expect(await positions.countNonClosed()).toBe(nonClosed.length);
    expect(nonClosed.map((p) => p.id)).toContain(ctx.id);
    expect((await positions.findDeployedPositions()).map((p) => p.id)).toContain(ctx.id);
    expect((await prisma.position.findUniqueOrThrow({ where: { id: ctx.id } })).status).toBe('CLOSING');
  });

  it('(H) two separate OS processes record the block concurrently: no error, one continuous block, reason set; a worker on a stale swap attempt gets STALE', async () => {
    const ctx = await blockedClosingPosition();
    await new PrismaExitStateRepository(prisma).getOrCreate(ctx.id);
    const run = (count: number, reason: string) =>
      new Promise<{ result?: string; threw?: string }>((resolve, reject) => {
        const child = spawn(process.execPath, [TS_NODE_BIN, '--transpile-only', path.resolve(__dirname, 'exitStateWorker.ts'), DB_URL, 'block', ctx.id, String(count), reason], { cwd: PROJECT_ROOT, env: process.env });
        let out = '';
        child.stdout.on('data', (d) => (out += d.toString()));
        child.on('close', () => {
          const line = out.trim().split(String.fromCharCode(10)).filter(Boolean).pop();
          if (!line) reject(new Error('worker produced no output'));
          else resolve(JSON.parse(line));
        });
      });
    const results = await Promise.all([run(0, 'QUOTE_UNAVAILABLE'), run(0, 'QUOTE_UNAVAILABLE')]);
    expect(results.filter((r) => r.threw)).toEqual([]);
    expect(results.map((r) => r.result).sort()).toEqual(['NEW', 'UNCHANGED']);
    const row = await prisma.exitState.findUniqueOrThrow({ where: { positionId: ctx.id } });
    expect(row).toMatchObject({ swapLegBlockedReason: 'QUOTE_UNAVAILABLE', swapAttemptCount: 0 });

    expect(await new PrismaExitStateRepository(prisma).incrementSwapAttemptFrom(ctx.id, 0)).toBe(true);
    expect((await run(0, 'PRICE_IMPACT_BLOCKED')).result).toBe('STALE');
    expect((await prisma.exitState.findUniqueOrThrow({ where: { positionId: ctx.id } })).swapLegBlockedReason).toBe('QUOTE_UNAVAILABLE');
  }, 60_000);
});
