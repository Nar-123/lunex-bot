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
import { PositionCapitalSnapshotProvider } from '../../src/positions/capitalSnapshotProvider';
import { settleResidualTokenViaReceipt } from '../../src/exits/manualTokenSettlement';
import type { ManualSettlementChainReader } from '../../src/exits/manualTokenSettlement';
import { ManualSettlementTxAlreadyUsedError } from '../../src/positions/types';
import { config } from '../../src/config';
import { makeCreateInput } from '../positions/fixtures';
import { REMOVE_HASH, SETTLE_HASH, chainWithSettlement, swapLogs } from './settlementFixtures';

// Manual TOKEN settlement via receipt against the REAL migrated SQLite
// schema: the settlement row, CLOSED, the proceeds and the cooldown commit
// together or not at all; the txHash primary key is enforced by the
// database; and two separate OS processes submitting the same transaction
// produce exactly one finalization.

const PROJECT_ROOT = path.resolve(__dirname, '../..');
const DB_PATH = path.resolve(PROJECT_ROOT, 'data', 'test-manual-token-settlement.db');
const DB_URL = `file:${DB_PATH}`;
const U = 10n ** 18n;
const WALLET = '0x9999999999999999999999999999999999999999' as Address;
const USDG = config.quoteAsset.ADDRESS as Address;
const CHAIN = config.chain.chainId;
const RESIDUAL = 3n * U;
const TS_NODE_BIN = require.resolve('ts-node/dist/bin.js');

function cleanup(): void {
  for (const suffix of ['', '-journal', '-wal', '-shm']) {
    if (existsSync(DB_PATH + suffix)) rmSync(DB_PATH + suffix);
  }
}

let prisma: PrismaClient;
let tokenSeq = 0x60;

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

/** A CLOSING position whose remove-liquidity is VERIFIED with a receipt-proven TOKEN residual (what executeExit persists). */
async function stuckPosition() {
  const positions = new PrismaPositionRepository(prisma);
  const txAttempts = new PrismaTransactionAttemptRepository(prisma);
  const token = `0x${(tokenSeq++).toString(16).padStart(40, '0')}` as Address;
  const created = await positions.create(makeCreateInput({ tokenAddress: token, entryUsdgRaw: 500n * U, openIdempotencyKey: `deploy:${token}` }));
  await positions.markActive(created.id, '1', new Date());
  const closing = (await positions.markClosing(created.id, `exit:${created.id}:1`))!;
  const exitStates = new PrismaExitStateRepository(prisma);
  await exitStates.updateDecisionState(created.id, (await exitStates.getOrCreate(created.id)).version, { pendingCloseReason: 'HARD_STOP_LOSS' });
  const remove = await txAttempts.create(`${closing.closeIdempotencyKey}:removeLiquidity`, 'exit:removeLiquidity');
  await txAttempts.update(remove.id, { status: 'VERIFIED', txHash: REMOVE_HASH, verifyData: { liquidityZero: true, usdgProceedsRaw: 200n * U, tokenProceedsRaw: RESIDUAL } });
  const s = { wallet: WALLET, token, usdg: USDG, chainId: CHAIN };
  const settle = (client: PrismaClient, chain: ManualSettlementChainReader) =>
    settleResidualTokenViaReceipt(
      { positions: new PrismaPositionRepository(client), txAttempts: new PrismaTransactionAttemptRepository(client), exitStates: new PrismaExitStateRepository(client), chain, walletAddress: WALLET },
      { positionId: created.id, txHash: SETTLE_HASH, closeIdempotencyKey: closing.closeIdempotencyKey! },
    );
  return { token, id: created.id, closeKey: closing.closeIdempotencyKey!, s, settle };
}

const cooldownRows = (token: string) => prisma.tokenCooldown.count({ where: { tokenAddress: token.toLowerCase() } });
const settlementRows = () => prisma.manualTokenSettlement.count({ where: { txHash: SETTLE_HASH } });
async function resetSettlements() {
  await prisma.manualTokenSettlement.deleteMany({});
}

describe('Manual TOKEN settlement via receipt -- real SQLite', () => {
  it('success: CLOSED + realized (remove + receipt USDG) + cooldown at closedAt + settlement row, all in one commit; H2 excludes it afterwards', async () => {
    await resetSettlements();
    const ctx = await stuckPosition();
    expect(await ctx.settle(prisma, chainWithSettlement(ctx.s, swapLogs(ctx.s, RESIDUAL, 290n * U)))).toMatchObject({ outcome: 'SETTLED' });
    const row = await prisma.position.findUniqueOrThrow({ where: { id: ctx.id } });
    expect(row).toMatchObject({ status: 'CLOSED', closeReason: 'HARD_STOP_LOSS', realizedUsdgRaw: (490n * U).toString() });
    const cd = await prisma.tokenCooldown.findUniqueOrThrow({ where: { tokenAddress: ctx.token.toLowerCase() } });
    expect(cd.exitedAt.getTime()).toBe(row.closedAt!.getTime());
    expect(await prisma.manualTokenSettlement.findUniqueOrThrow({ where: { txHash: SETTLE_HASH } })).toMatchObject({ positionId: ctx.id, closeIdempotencyKey: ctx.closeKey, tokenDisposedRaw: RESIDUAL.toString(), usdgProceedsRaw: (290n * U).toString(), blockNumber: '120' });
    const positions = new PrismaPositionRepository(prisma);
    expect((await positions.findDeployedPositions()).map((p) => p.id)).not.toContain(ctx.id);
    const snapshot = await new PositionCapitalSnapshotProvider(positions, WALLET, async () => 1000n * U, new PrismaTransactionAttemptRepository(prisma)).getSnapshot();
    expect(snapshot.accountingUnresolvedReason).toBeUndefined();
  });

  it.each([
    ['the cooldown write', 'TokenCooldown', /tx\.tokenCooldown\.create\(\)/],
    ['the settlement-row write (after CLOSED + cooldown were written)', 'ManualTokenSettlement', /tx\.manualTokenSettlement\.create\(\)/],
  ])('crash during %s rolls EVERYTHING back (CLOSING, no proceeds, no cooldown, no row); a restarted process resubmits the same txHash -> exactly one finalization, chain only read', async (_n, table, err) => {
    await resetSettlements();
    const ctx = await stuckPosition();
    const chain = chainWithSettlement(ctx.s, swapLogs(ctx.s, RESIDUAL, 290n * U));
    const heal = injectFailure(`crash_${table}`, `BEFORE INSERT ON "${table}" BEGIN SELECT RAISE(ABORT, 'killed'); END;`);
    try {
      await expect(ctx.settle(prisma, chain)).rejects.toThrow(err);
    } finally {
      heal();
    }
    expect(await prisma.position.findUniqueOrThrow({ where: { id: ctx.id } })).toMatchObject({ status: 'CLOSING', realizedUsdgRaw: null, closedAt: null });
    expect(await cooldownRows(ctx.token)).toBe(0);
    expect(await settlementRows()).toBe(0);

    const restarted = new PrismaClient({ adapter: new PrismaBetterSqlite3({ url: DB_URL }) });
    try {
      expect(await ctx.settle(restarted, chain)).toMatchObject({ outcome: 'SETTLED' });
      expect(await ctx.settle(restarted, chain)).toMatchObject({ outcome: 'ALREADY_SETTLED' });
    } finally {
      await restarted.$disconnect();
    }
    expect(await cooldownRows(ctx.token)).toBe(1);
    expect(await settlementRows()).toBe(1);
    expect((await prisma.position.findUniqueOrThrow({ where: { id: ctx.id } })).realizedUsdgRaw).toBe((490n * U).toString());
    expect(chain.reads.every((r) => r.startsWith('tx:') || r.startsWith('receipt:'))).toBe(true); // the service can only read -- nothing is ever broadcast
  });

  it('the database enforces one settlement per transaction: recording an already-used txHash for another position aborts that close entirely', async () => {
    await resetSettlements();
    const a = await stuckPosition();
    expect((await a.settle(prisma, chainWithSettlement(a.s, swapLogs(a.s, RESIDUAL, 290n * U)))).outcome).toBe('SETTLED');
    const b = await stuckPosition();
    const positions = new PrismaPositionRepository(prisma);
    await expect(positions.markClosed(b.id, new Date(), 'HARD_STOP_LOSS', 1n, b.closeKey, { txHash: SETTLE_HASH, tokenDisposedRaw: 1n, usdgProceedsRaw: 1n, blockNumber: 1n })).rejects.toBeInstanceOf(ManualSettlementTxAlreadyUsedError);
    expect(await prisma.position.findUniqueOrThrow({ where: { id: b.id } })).toMatchObject({ status: 'CLOSING', realizedUsdgRaw: null });
    expect(await cooldownRows(b.token)).toBe(0);
    // ...and through the service: rejected before anything is read on-chain.
    expect(await b.settle(prisma, chainWithSettlement(b.s, swapLogs(b.s, RESIDUAL, 290n * U)))).toMatchObject({ outcome: 'REJECTED', reason: 'TX_ALREADY_USED' });
  });

  it.each(['claim', 'noclaim'] as const)('two separate OS processes submit the same txHash simultaneously (%s): exactly one SETTLED, one cooldown, one settlement row, proceeds once', async (claimMode) => {
    await resetSettlements();
    const ctx = await stuckPosition();
    const run = () =>
      new Promise<{ outcome?: string; reason?: string; threw?: string }>((resolve, reject) => {
        const child = spawn(
          process.execPath,
          [TS_NODE_BIN, '--transpile-only', path.resolve(__dirname, 'settlementWorker.ts'), DB_URL, ctx.id, ctx.closeKey, WALLET, ctx.token, USDG, String(CHAIN), RESIDUAL.toString(), (290n * U).toString(), claimMode],
          { cwd: PROJECT_ROOT, env: process.env },
        );
        let out = '';
        child.stdout.on('data', (d) => (out += d.toString()));
        child.on('close', () => {
          const line = out.trim().split(String.fromCharCode(10)).filter(Boolean).pop();
          if (!line) reject(new Error('worker produced no output'));
          else resolve(JSON.parse(line));
        });
      });
    const results = await Promise.all([run(), run()]);
    expect(results.filter((r) => r.threw)).toEqual([]);
    expect(results.filter((r) => r.outcome === 'SETTLED')).toHaveLength(1);
    const loser = results.find((r) => r.outcome !== 'SETTLED')!;
    expect(loser.outcome === 'ALREADY_SETTLED' || loser.reason === 'POSITION_BUSY').toBe(true);
    expect(await cooldownRows(ctx.token)).toBe(1);
    expect(await settlementRows()).toBe(1);
    expect(await prisma.position.findUniqueOrThrow({ where: { id: ctx.id } })).toMatchObject({ status: 'CLOSED', realizedUsdgRaw: (490n * U).toString() });
  }, 90_000);

  it('rejection on the real schema writes nothing (insufficient disposal)', async () => {
    await resetSettlements();
    const ctx = await stuckPosition();
    expect(await ctx.settle(prisma, chainWithSettlement(ctx.s, swapLogs(ctx.s, RESIDUAL - 1n, 290n * U)))).toMatchObject({ outcome: 'REJECTED', reason: 'INSUFFICIENT_TOKEN_DISPOSED' });
    expect(await prisma.position.findUniqueOrThrow({ where: { id: ctx.id } })).toMatchObject({ status: 'CLOSING', realizedUsdgRaw: null });
    expect(await cooldownRows(ctx.token)).toBe(0);
    expect(await settlementRows()).toBe(0);
    vi.restoreAllMocks();
  });
});
