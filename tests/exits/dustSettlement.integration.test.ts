import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import type { Address } from 'viem';
import { execSync } from 'node:child_process';
import { existsSync, rmSync } from 'node:fs';
import path from 'node:path';
import { PrismaClient } from '@prisma/client';
import { PrismaBetterSqlite3 } from '@prisma/adapter-better-sqlite3';
import { PrismaPositionRepository } from '../../src/positions/positionRepository';
import { PrismaTransactionAttemptRepository } from '../../src/execution/transactionAttemptRepository';
import { PositionCapitalSnapshotProvider } from '../../src/positions/capitalSnapshotProvider';
import { DUST_CONFIRMATION, settleResidualDust } from '../../src/exits/dustSettlement';
import { config } from '../../src/config';
import { makeCreateInput } from '../positions/fixtures';

/**
 * Dust settlement against the REAL migrated SQLite schema: the close, the
 * abandonment record and the cooldown commit together; the `positionId`
 * primary key makes a repeat impossible at the database level; and the
 * capital snapshot really stops counting the position as deployed.
 */
const PROJECT_ROOT = path.resolve(__dirname, '../..');
const DB_PATH = path.resolve(PROJECT_ROOT, 'data', 'test-dust-settlement.db');
const DB_URL = `file:${DB_PATH}`;
const WALLET = '0x9999999999999999999999999999999999999999' as Address;
const RESIDUAL = 14_467_194_911_816_926n;
const REMOVE_USDG = 20_915_201n;
const DUST_VALUE = 8_712n;

function cleanup(): void {
  for (const suffix of ['', '-journal', '-wal', '-shm']) if (existsSync(DB_PATH + suffix)) rmSync(DB_PATH + suffix);
}

let prisma: PrismaClient;
let positions: PrismaPositionRepository;
let txAttempts: PrismaTransactionAttemptRepository;
let tokenSeq = 0xa0;

beforeAll(() => {
  cleanup();
  execSync('npx prisma migrate deploy', { cwd: PROJECT_ROOT, env: { ...process.env, DATABASE_URL: DB_URL }, stdio: 'pipe' });
  prisma = new PrismaClient({ adapter: new PrismaBetterSqlite3({ url: DB_URL }) });
  positions = new PrismaPositionRepository(prisma);
  txAttempts = new PrismaTransactionAttemptRepository(prisma);
}, 60_000);

afterAll(async () => {
  await prisma.$disconnect();
  cleanup();
});

async function closingPositionWithResidual(residual = RESIDUAL) {
  const token = `0x${(tokenSeq++).toString(16).padStart(40, '0')}` as Address;
  const created = await positions.create(makeCreateInput({ entryUsdgRaw: 20_906_915n, tokenAddress: token }));
  await positions.markActive(created.id, String(tokenSeq), new Date());
  await positions.markClosing(created.id, `exit:${created.id}:lifecycle-1`);
  const position = (await positions.findById(created.id))!;
  const attempt = await txAttempts.create(`${position.closeIdempotencyKey}:removeLiquidity`, 'exit:removeLiquidity');
  await txAttempts.update(attempt.id, {
    status: 'VERIFIED',
    verifyData: { liquidityZero: true, usdgProceedsRaw: REMOVE_USDG.toString(), tokenProceedsRaw: residual.toString() },
  }, attempt.version);
  return position;
}

function deps(quotedUsdgRaw: bigint) {
  return {
    positions,
    txAttempts,
    swapExecutor: {
      getQuote: vi.fn(async (_t: Address, amountInRaw: bigint) => ({ amountInRaw, expectedAmountOutRaw: quotedUsdgRaw, minOutputAmountRaw: 0n, priceImpactPct: 0.001, slippageBps: 100, providerQuote: {} })),
      checkApproval: vi.fn(async () => ({ needsApproval: false, spender: null })),
      buildSwapTx: vi.fn(async () => { throw new Error('must never build a swap'); }),
    } as never,
    readTokenBalance: vi.fn(async () => 10n ** 30n),
    walletAddress: WALLET,
  };
}

describe('dust settlement (real SQLite, real migration)', () => {
  it('closes the position and records the abandonment in ONE commit, with honest proceeds', async () => {
    const position = await closingPositionWithResidual();

    const result = await settleResidualDust(deps(DUST_VALUE), {
      positionId: position.id, closeIdempotencyKey: position.closeIdempotencyKey!, confirm: DUST_CONFIRMATION, actor: 'admin', requestId: 'req-int-1',
    });

    expect(result.outcome).toBe('SETTLED');
    const row = await prisma.position.findUniqueOrThrow({ where: { id: position.id } });
    expect(row.status).toBe('CLOSED');
    expect(row.closeReason).toBe('DUST_SETTLEMENT');
    expect(row.realizedUsdgRaw).toBe(REMOVE_USDG.toString()); // NOT inflated by the abandoned dust
    const dust = await prisma.dustSettlement.findUniqueOrThrow({ where: { positionId: position.id } });
    expect(dust).toMatchObject({
      residualTokenRaw: RESIDUAL.toString(),
      quotedUsdgRaw: DUST_VALUE.toString(),
      thresholdUsdgRaw: config.rules.exits.DUST_SETTLEMENT.MAX_USDG_VALUE_RAW.toString(),
      actor: 'admin',
      requestId: 'req-int-1',
      closeIdempotencyKey: position.closeIdempotencyKey,
    });
    // the exit cooldown committed with the close, exactly like a normal exit
    expect(await prisma.tokenCooldown.findUnique({ where: { tokenAddress: row.tokenAddress } })).not.toBeNull();
  }, 30_000);

  it('releases the accounting capital: the position stops counting as deployed', async () => {
    const position = await closingPositionWithResidual();
    const snapshot = new PositionCapitalSnapshotProvider(positions, WALLET, async () => 100n * 10n ** 6n, txAttempts);

    const before = await snapshot.getSnapshot();
    await settleResidualDust(deps(DUST_VALUE), { positionId: position.id, closeIdempotencyKey: position.closeIdempotencyKey!, confirm: DUST_CONFIRMATION, actor: 'admin', requestId: null });
    const after = await snapshot.getSnapshot();

    expect(before.totalDeployedUsdg - after.totalDeployedUsdg).toBe(20_906_915n);
  }, 30_000);

  it('is idempotent at the database level: a repeat returns ALREADY_SETTLED and writes nothing', async () => {
    const position = await closingPositionWithResidual();
    const d = deps(DUST_VALUE);
    const req = { positionId: position.id, closeIdempotencyKey: position.closeIdempotencyKey!, confirm: DUST_CONFIRMATION, actor: 'admin', requestId: null };

    expect((await settleResidualDust(d, req)).outcome).toBe('SETTLED');
    const afterFirst = await prisma.position.findUniqueOrThrow({ where: { id: position.id } });
    expect((await settleResidualDust(d, req)).outcome).toBe('ALREADY_SETTLED');

    expect(await prisma.dustSettlement.count({ where: { positionId: position.id } })).toBe(1);
    const afterSecond = await prisma.position.findUniqueOrThrow({ where: { id: position.id } });
    expect(afterSecond.closedAt).toEqual(afterFirst.closedAt); // the close was never redone
  }, 30_000);

  it('a NOT_DUST residual writes nothing at all', async () => {
    const position = await closingPositionWithResidual();
    const result = await settleResidualDust(deps(config.rules.exits.DUST_SETTLEMENT.MAX_USDG_VALUE_RAW), {
      positionId: position.id, closeIdempotencyKey: position.closeIdempotencyKey!, confirm: DUST_CONFIRMATION, actor: 'admin', requestId: null,
    });
    expect(result).toMatchObject({ outcome: 'REJECTED', reason: 'NOT_DUST' });
    expect((await prisma.position.findUniqueOrThrow({ where: { id: position.id } })).status).toBe('CLOSING');
    expect(await prisma.dustSettlement.count({ where: { positionId: position.id } })).toBe(0);
  }, 30_000);
});
