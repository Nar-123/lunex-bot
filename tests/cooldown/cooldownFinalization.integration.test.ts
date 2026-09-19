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
import { PrismaCooldownRepository } from '../../src/cooldown/cooldownRepository';
import { PositionCapitalSnapshotProvider } from '../../src/positions/capitalSnapshotProvider';
import { executeExit } from '../../src/exits/executeExit';
import { config } from '../../src/config';
import type { TxSafetyDeps } from '../../src/execution/types';
import type { SwapExecutor } from '../../src/swap/types';
import { makeCreateInput } from '../positions/fixtures';

// Cooldown crash-gap fix, against the REAL migrated SQLite schema. A
// successful close and its exit cooldown are committed by ONE transaction
// inside PositionRepository.markClosed. Crashes are injected
// DETERMINISTICALLY with SQLite triggers that abort a specific write
// mid-transaction -- the database's own rollback is what is under test.

const PROJECT_ROOT = path.resolve(__dirname, '../..');
const DB_PATH = path.resolve(PROJECT_ROOT, 'data', 'test-cooldown-finalization.db');
const DB_URL = `file:${DB_PATH}`;
const U = 10n ** 18n;
const WALLET = '0x9999999999999999999999999999999999999999' as Address;
const COOLDOWN_MS = config.rules.cooldown.DURATION_MS;
const TS_NODE_BIN = require.resolve('ts-node/dist/bin.js');

function cleanup(): void {
  for (const suffix of ['', '-journal', '-wal', '-shm']) {
    if (existsSync(DB_PATH + suffix)) rmSync(DB_PATH + suffix);
  }
}

let prisma: PrismaClient;
let positions: PrismaPositionRepository;
let cooldowns: PrismaCooldownRepository;
let tokenSeq = 0x10;

beforeAll(() => {
  cleanup();
  execSync('npx prisma migrate deploy', { cwd: PROJECT_ROOT, env: { ...process.env, DATABASE_URL: DB_URL }, stdio: 'pipe' });
  prisma = new PrismaClient({ adapter: new PrismaBetterSqlite3({ url: DB_URL }) });
  positions = new PrismaPositionRepository(prisma);
  cooldowns = new PrismaCooldownRepository(prisma);
}, 30_000);

afterAll(async () => {
  await prisma.$disconnect();
  cleanup();
});

/** Deterministic crash injection: a trigger that aborts the named write, then removal. (Prisma surfaces SQLite's trigger abort as a generic constraint error naming the failed call, e.g. `tx.tokenCooldown.create()` -- that is what the tests match.) */
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

async function closingPosition(entry = 500n * U) {
  const token = `0x${(tokenSeq++).toString(16).padStart(40, '0')}` as Address;
  const created = await positions.create(makeCreateInput({ tokenAddress: token, entryUsdgRaw: entry, openIdempotencyKey: `deploy:${token}` }));
  await positions.markActive(created.id, '1', new Date());
  const closeKey = `exit:${created.id}:1`;
  const closing = (await positions.markClosing(created.id, closeKey))!;
  return { token, id: created.id, closeKey, closing };
}

const cooldownRow = (token: string) => prisma.tokenCooldown.findUnique({ where: { tokenAddress: token.toLowerCase() } });
const countCooldownRows = (token: string) => prisma.tokenCooldown.count({ where: { tokenAddress: token.toLowerCase() } });

describe('Cooldown crash-gap fix (real SQLite): a successful close and its cooldown are atomic', () => {
  it('(8, 17) a successful markClosed commits CLOSED + realized proceeds + the cooldown together; the cooldown starts at closedAt and lasts exactly the configured duration', async () => {
    const { token, id, closeKey } = await closingPosition();
    const closedAt = new Date(Date.now() - 1000);
    await positions.markClosed(id, closedAt, 'HARD_STOP_LOSS', 480n * U, closeKey);

    const row = await prisma.position.findUniqueOrThrow({ where: { id } });
    expect(row.status).toBe('CLOSED');
    expect(row.realizedUsdgRaw).toBe((480n * U).toString());
    const cooldown = await cooldownRow(token);
    expect(cooldown?.exitedAt.getTime()).toBe(closedAt.getTime());
    expect(cooldown!.cooldownEndsAt.getTime() - closedAt.getTime()).toBe(COOLDOWN_MS);
    expect(COOLDOWN_MS).toBe(2 * 60 * 60 * 1000); // existing configured value, unchanged
  });

  it('(10, 11, 12) CRASH DURING THE COOLDOWN WRITE: the whole finalization rolls back -- still CLOSING, no proceeds, no closedAt, no cooldown (never CLOSED-without-cooldown); the retry commits all of it exactly once', async () => {
    const { token, id, closeKey } = await closingPosition();
    const heal = injectFailure('crash_cooldown_insert', `BEFORE INSERT ON "TokenCooldown" BEGIN SELECT RAISE(ABORT, 'injected crash during cooldown write'); END;`);
    try {
      await expect(positions.markClosed(id, new Date(), 'HARD_STOP_LOSS', 480n * U, closeKey)).rejects.toThrow(/tx\.tokenCooldown\.create\(\)/); // the injected write, inside the finalization transaction
    } finally {
      heal();
    }
    const afterCrash = await prisma.position.findUniqueOrThrow({ where: { id } });
    expect(afterCrash).toMatchObject({ status: 'CLOSING', realizedUsdgRaw: null, closedAt: null, closeReason: null });
    expect(await countCooldownRows(token)).toBe(0);

    // Restart: a brand-new client/repository retries the finalization.
    const restarted = new PrismaClient({ adapter: new PrismaBetterSqlite3({ url: DB_URL }) });
    try {
      const retryAt = new Date();
      expect(await new PrismaPositionRepository(restarted).markClosed(id, retryAt, 'HARD_STOP_LOSS', 480n * U, closeKey)).not.toBeNull();
      const row = await restarted.position.findUniqueOrThrow({ where: { id } });
      expect(row).toMatchObject({ status: 'CLOSED', realizedUsdgRaw: (480n * U).toString() });
      expect(await countCooldownRows(token)).toBe(1);
      expect((await cooldownRow(token))?.exitedAt.getTime()).toBe(retryAt.getTime()); // = the COMMITTED close, not a crash-time guess
    } finally {
      await restarted.$disconnect();
    }
  });

  it('(11) crash during a cooldown UPDATE (token already has an older cooldown row): rolls back identically, the old row untouched', async () => {
    const { token, id, closeKey } = await closingPosition();
    const old = new Date(Date.now() - 10 * COOLDOWN_MS);
    await prisma.tokenCooldown.create({ data: { tokenAddress: token.toLowerCase(), exitedAt: old, cooldownEndsAt: new Date(old.getTime() + COOLDOWN_MS) } });
    const heal = injectFailure('crash_cooldown_update', `BEFORE UPDATE ON "TokenCooldown" BEGIN SELECT RAISE(ABORT, 'injected crash during cooldown update'); END;`);
    try {
      await expect(positions.markClosed(id, new Date(), 'OOR_TIMEOUT', 500n * U, closeKey)).rejects.toThrow(/tx\.tokenCooldown\.update\(\)/);
    } finally {
      heal();
    }
    expect((await prisma.position.findUniqueOrThrow({ where: { id } })).status).toBe('CLOSING');
    expect((await cooldownRow(token))?.exitedAt.getTime()).toBe(old.getTime());
    await positions.markClosed(id, new Date(), 'OOR_TIMEOUT', 500n * U, closeKey);
    expect((await cooldownRow(token))!.exitedAt.getTime()).toBeGreaterThan(old.getTime());
  });

  it('(4) crash in the CLOSED transition itself: no cooldown is written (it is only ever written after the transition wins, in the same transaction)', async () => {
    const { token, id, closeKey } = await closingPosition();
    const heal = injectFailure('crash_position_close', `BEFORE UPDATE OF "status" ON "Position" WHEN NEW."status" = 'CLOSED' BEGIN SELECT RAISE(ABORT, 'injected crash in close'); END;`);
    try {
      await expect(positions.markClosed(id, new Date(), 'HARD_STOP_LOSS', 1n, closeKey)).rejects.toThrow(/tx\.position\.updateMany\(\)/);
    } finally {
      heal();
    }
    expect((await prisma.position.findUniqueOrThrow({ where: { id } })).status).toBe('CLOSING');
    expect(await countCooldownRows(token)).toBe(0);
  });

  it('(13, 15, 16) retries / stale finalizations are no-ops: exactly one cooldown row, timestamp and proceeds never moved', async () => {
    const { token, id, closeKey } = await closingPosition();
    const closedAt = new Date(Date.now() - 5000);
    await positions.markClosed(id, closedAt, 'HARD_TP', 700n * U, closeKey);
    for (let i = 0; i < 3; i++) {
      expect(await positions.markClosed(id, new Date(), 'OOR_TIMEOUT', 1n, closeKey)).toBeNull();
    }
    expect(await countCooldownRows(token)).toBe(1);
    expect((await cooldownRow(token))?.exitedAt.getTime()).toBe(closedAt.getTime());
    expect(await prisma.position.findUniqueOrThrow({ where: { id } })).toMatchObject({ closeReason: 'HARD_TP', realizedUsdgRaw: (700n * U).toString() });
    expect((await prisma.position.findUniqueOrThrow({ where: { id } })).closedAt?.getTime()).toBe(closedAt.getTime());
  });

  it('(29) two independent connections racing the SAME finalization: exactly one wins; one cooldown, stamped with the winner\'s closedAt', async () => {
    const { token, id, closeKey } = await closingPosition();
    const other = new PrismaClient({ adapter: new PrismaBetterSqlite3({ url: DB_URL, timeout: 250 }) }); // short busy timeout: a blocked loser fails closed quickly
    try {
      const tA = new Date(Date.now() - 2000);
      const tB = new Date(Date.now() - 1000);
      // Both connections share ONE Node event loop, and better-sqlite3's
      // busy-wait is synchronous: the losing connection may block the loop
      // until its busy timeout and then fail. That is a FAIL-CLOSED outcome
      // (its transaction rolls back, nothing written, the next exit tick
      // retries) -- so the loser is either `null` (lost the conditional
      // update) or rejected; never a second finalization. (The OS-process
      // test below shows a clean single-winner race under true concurrency.)
      const settled = await Promise.allSettled([
        positions.markClosed(id, tA, 'HARD_STOP_LOSS', 480n * U, closeKey),
        new PrismaPositionRepository(other).markClosed(id, tB, 'HARD_STOP_LOSS', 480n * U, closeKey),
      ]);
      const winners = settled.flatMap((r) => (r.status === 'fulfilled' && r.value !== null ? [r.value] : []));
      expect(winners).toHaveLength(1);
      expect(await countCooldownRows(token)).toBe(1);
      expect((await cooldownRow(token))?.exitedAt.getTime()).toBe(winners[0]!.closedAt!.getTime());
    } finally {
      await other.$disconnect();
    }
  }, 30_000);

  it(
    '(30) two separate OS processes racing the SAME finalization: exactly one wins; one cooldown row, stamped with the winner\'s closedAt',
    async () => {
      const { token, id, closeKey } = await closingPosition();
      const run = (closedAtIso: string) =>
        new Promise<Record<string, unknown>>((resolve, reject) => {
          const child = spawn(process.execPath, [TS_NODE_BIN, '--transpile-only', path.resolve(__dirname, '../exits/exitStateWorker.ts'), DB_URL, 'markClosed', id, closeKey, closedAtIso], { cwd: PROJECT_ROOT, env: process.env });
          let out = '';
          child.stdout.on('data', (d) => (out += d.toString()));
          child.on('close', () => {
            const line = out.trim().split(String.fromCharCode(10)).filter(Boolean).pop();
            if (!line) reject(new Error('worker produced no output'));
            else resolve(JSON.parse(line));
          });
        });
      const tA = new Date(Date.now() - 3000).toISOString();
      const tB = new Date(Date.now() - 2000).toISOString();
      const results = await Promise.all([run(tA), run(tB)]);
      expect(results.filter((r) => 'threw' in r)).toEqual([]);
      expect(results.filter((r) => r.won === true)).toHaveLength(1);
      expect(await countCooldownRows(token)).toBe(1);
      const row = await prisma.position.findUniqueOrThrow({ where: { id } });
      expect((await cooldownRow(token))?.exitedAt.getTime()).toBe(row.closedAt!.getTime());
    },
    90_000,
  );

  it('(3, 21) no cooldown for a failed exit (reverted to ACTIVE) or a failed/expired OPENING', async () => {
    const reverted = await closingPosition();
    await positions.markExitFailed(reverted.id, reverted.closeKey);
    expect(await countCooldownRows(reverted.token)).toBe(0);

    const token = `0x${(tokenSeq++).toString(16).padStart(40, '0')}` as Address;
    const opening = await positions.create(makeCreateInput({ tokenAddress: token, openIdempotencyKey: `deploy:${token}` }));
    await positions.markFailed(opening.id);
    expect(await countCooldownRows(token)).toBe(0);
  });

  it('(18, 19, 20) the same token is blocked until the cooldown expires and eligible after it; a different token is unaffected (existing screening checker)', async () => {
    const blocked = await closingPosition();
    await positions.markClosed(blocked.id, new Date(Date.now() - (COOLDOWN_MS - 60_000)), 'HARD_STOP_LOSS', 1n, blocked.closeKey);
    expect((await cooldowns.getCooldownStatus(blocked.token)).inCooldown).toBe(true);

    const expired = await closingPosition();
    await positions.markClosed(expired.id, new Date(Date.now() - (COOLDOWN_MS + 1000)), 'HARD_STOP_LOSS', 1n, expired.closeKey);
    expect((await cooldowns.getCooldownStatus(expired.token)).inCooldown).toBe(false);

    const untouched = `0x${(tokenSeq++).toString(16).padStart(40, '0')}`;
    expect((await cooldowns.getCooldownStatus(untouched)).inCooldown).toBe(false);
  });

  it('(1, 9, 23, 24) USDG-only close via the REAL executeExit: the process dies inside finalization (DB rollback), a restarted process resumes from the verified receipt -> CLOSED + cooldown exactly once, proceeds once, and the position leaves deployed capital', async () => {
    const { token, id, closing } = await closingPosition(500n * U);
    await new PrismaExitStateRepository(prisma).updateDecisionState(id, (await new PrismaExitStateRepository(prisma).getOrCreate(id)).version, { pendingCloseReason: 'OOR_TIMEOUT' });
    const removeDeps: TxSafetyDeps<{ liquidityZero: true; usdgProceedsRaw: bigint; tokenProceedsRaw: bigint }> = {
      buildTransaction: vi.fn(async () => ({ to: '0x1111111111111111111111111111111111111111' as Address, data: '0xabcdef' as `0x${string}`, value: 0n })),
      simulate: vi.fn(async () => ({ ok: true }) as const),
      estimateGas: vi.fn(async () => 100_000n),
      getGasPrice: vi.fn(async () => 1n),
      checkGasAffordable: vi.fn(async () => ({ ok: true }) as const),
      getNonce: vi.fn(async () => 7),
      signTransaction: vi.fn(async () => ({ raw: '0xdeadbeef' as `0x${string}`, hash: `0x${'ab'.repeat(32)}` as `0x${string}` })),
      broadcastRaw: vi.fn(async () => undefined),
      waitForReceipt: vi.fn(async () => ({ status: 'success' as const, blockNumber: 1n })),
      getReceiptIfAvailable: vi.fn(async () => null),
      verifyOnChain: vi.fn(async () => ({ ok: true as const, data: { liquidityZero: true as const, usdgProceedsRaw: 500n * U, tokenProceedsRaw: 0n } })),
    };
    const exitDeps = (client: PrismaClient) => ({
      positions: new PrismaPositionRepository(client),
      exitStates: new PrismaExitStateRepository(client),
      txAttempts: new PrismaTransactionAttemptRepository(client),
      livePositionState: { getLiveState: vi.fn() },
      poolPrice: { getPriceState: vi.fn() },
      swapExecutor: { getQuote: vi.fn(), checkApproval: vi.fn(), buildSwapTx: vi.fn() } as unknown as SwapExecutor,
      buildRemoveLiquidityDeps: vi.fn(() => removeDeps),
      readTokenBalance: vi.fn(async () => 0n),
      walletAddress: WALLET,
    });

    // Process 1: the burn is VERIFIED on-chain, then the process dies INSIDE the finalization transaction.
    const heal = injectFailure('crash_finalize', `BEFORE INSERT ON "TokenCooldown" BEGIN SELECT RAISE(ABORT, 'process killed during finalization'); END;`);
    try {
      await expect(executeExit(closing, exitDeps(prisma))).rejects.toThrow(/tx\.tokenCooldown\.create\(\)/);
    } finally {
      heal();
    }
    expect((await prisma.position.findUniqueOrThrow({ where: { id } })).status).toBe('CLOSING');
    expect(await countCooldownRows(token)).toBe(0);
    expect((await prisma.transactionAttempt.findUniqueOrThrow({ where: { idempotencyKey: `${closing.closeIdempotencyKey}:removeLiquidity` } })).status).toBe('VERIFIED');

    // Process 2 (restart): resumes from the persisted VERIFIED burn -- no rebroadcast.
    const restarted = new PrismaClient({ adapter: new PrismaBetterSqlite3({ url: DB_URL }) });
    try {
      const broadcastsBefore = (removeDeps.broadcastRaw as ReturnType<typeof vi.fn>).mock.calls.length;
      expect(await executeExit(closing, exitDeps(restarted))).toEqual({ outcome: 'CLOSED' });
      expect((removeDeps.broadcastRaw as ReturnType<typeof vi.fn>).mock.calls.length).toBe(broadcastsBefore);
      // ...and a third call is a no-op.
      expect((await executeExit(closing, exitDeps(restarted))).outcome).toBe('PENDING');
    } finally {
      await restarted.$disconnect();
    }
    const row = await prisma.position.findUniqueOrThrow({ where: { id } });
    expect(row).toMatchObject({ status: 'CLOSED', closeReason: 'OOR_TIMEOUT', realizedUsdgRaw: (500n * U).toString() });
    expect(await countCooldownRows(token)).toBe(1);
    expect((await cooldownRow(token))?.exitedAt.getTime()).toBe(row.closedAt!.getTime());

    // H2 unchanged: the CLOSED position no longer contributes to deployed capital or the slot count.
    expect((await positions.findDeployedPositions()).map((p) => p.id)).not.toContain(id);
    const snapshot = await new PositionCapitalSnapshotProvider(positions, WALLET, async () => 1000n * U, new PrismaTransactionAttemptRepository(prisma)).getSnapshot();
    expect(snapshot.accountingUnresolvedReason).toBeUndefined();
  });
});
