import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import type { Address } from 'viem';
import { execSync, spawn } from 'node:child_process';
import { existsSync, rmSync } from 'node:fs';
import path from 'node:path';
import { PrismaClient } from '@prisma/client';
import { PrismaBetterSqlite3 } from '@prisma/adapter-better-sqlite3';
import { executeCriticalTransaction } from '../../src/execution/executeCriticalTransaction';
import { PrismaTransactionAttemptRepository } from '../../src/execution/transactionAttemptRepository';
import { PrismaExitStateRepository } from '../../src/exits/exitStateRepository';
import { buildSwapDeps, readExitSwapBuildContext } from '../../src/exits/swapTx';
import type { SwapQuote } from '../../src/swap/types';

// Same-attempt swap race against the REAL SQLite schema and REAL Prisma
// repositories: two independent connections in one process, and two
// genuinely separate OS processes (tests/exits/swapAttemptWorker.ts).

const PROJECT_ROOT = path.resolve(__dirname, '../..');
const DB_PATH = path.resolve(PROJECT_ROOT, 'data', 'test-swap-attempt-race.db');
const DB_URL = `file:${DB_PATH}`;
const U = 10n ** 18n;
const TS_NODE_BIN = require.resolve('ts-node/dist/bin.js');

function cleanup(): void {
  for (const suffix of ['', '-journal', '-wal', '-shm']) {
    if (existsSync(DB_PATH + suffix)) rmSync(DB_PATH + suffix);
  }
}

let prismaA: PrismaClient;
let prismaB: PrismaClient;

beforeAll(() => {
  cleanup();
  execSync('npx prisma migrate deploy', { cwd: PROJECT_ROOT, env: { ...process.env, DATABASE_URL: DB_URL }, stdio: 'pipe' });
  prismaA = new PrismaClient({ adapter: new PrismaBetterSqlite3({ url: DB_URL }) });
  prismaB = new PrismaClient({ adapter: new PrismaBetterSqlite3({ url: DB_URL }) });
}, 30_000);

afterAll(async () => {
  await prismaA.$disconnect();
  await prismaB.$disconnect();
  cleanup();
});

const QUOTE_A: SwapQuote = { amountInRaw: 10n * U, expectedAmountOutRaw: 950n * U, minOutputAmountRaw: 900n * U, priceImpactPct: 0.004, slippageBps: 100, providerQuote: {} };
const QUOTE_B: SwapQuote = { amountInRaw: 10n * U, expectedAmountOutRaw: 840n * U, minOutputAmountRaw: 800n * U, priceImpactPct: 0.002, slippageBps: 100, providerQuote: {} };

function latch(): { wait: Promise<void>; release: () => void } {
  let release!: () => void;
  const wait = new Promise<void>((resolve) => (release = resolve));
  return { wait, release };
}

function connectionWorker(prisma: PrismaClient, quote: SwapQuote, park?: { entered: () => void; gate: Promise<void> }) {
  const calls = { buildSwapTx: 0, sign: 0, broadcast: 0 };
  const exitStates = new PrismaExitStateRepository(prisma);
  const real = buildSwapDeps(
    'pos-conn',
    '0x0000000000000000000000000000000000000002' as Address,
    quote,
    {
      getQuote: vi.fn(),
      checkApproval: vi.fn(),
      buildSwapTx: vi.fn(async () => {
        calls.buildSwapTx++;
        if (park) {
          park.entered();
          await park.gate;
        }
        return { to: '0x1111111111111111111111111111111111111111' as Address, data: `0x${quote.minOutputAmountRaw.toString(16)}` as `0x${string}`, value: 0n };
      }),
    },
    exitStates,
    { swapAttemptCount: 0, readBalance: vi.fn(async () => 1000n * U), readUsdgTransfersTo: vi.fn(async () => 850n * U), walletAddress: '0x9999999999999999999999999999999999999999' as Address },
  );
  return {
    calls,
    exitStates,
    repo: new PrismaTransactionAttemptRepository(prisma),
    deps: {
      ...real,
      simulate: vi.fn(async () => ({ ok: true }) as const),
      estimateGas: vi.fn(async () => 100_000n),
      getGasPrice: vi.fn(async () => 1n),
      checkGasAffordable: vi.fn(async () => ({ ok: true }) as const),
      getNonce: vi.fn(async () => 7),
      signTransaction: vi.fn(async () => {
        calls.sign++;
        return { raw: '0xdeadbeef' as `0x${string}`, hash: `0x${'ab'.repeat(32)}` as `0x${string}` };
      }),
      broadcastRaw: vi.fn(async () => {
        calls.broadcast++;
      }),
      waitForReceipt: vi.fn(async () => ({ status: 'success' as const, blockNumber: 1n })),
      getReceiptIfAvailable: vi.fn(async () => null),
    },
  };
}

function runProcess(key: string, tag: 'A' | 'B', pauseAt: 'none' | 'build' | 'sign', receiptPays: bigint, onPaused?: () => void): Promise<Record<string, unknown>> {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [TS_NODE_BIN, '--transpile-only', path.resolve(__dirname, 'swapAttemptWorker.ts'), DB_URL, key, tag, pauseAt, receiptPays.toString()], { cwd: PROJECT_ROOT, env: process.env });
    let out = '';
    let signalled = false;
    child.stdout.on('data', (d) => {
      out += d.toString();
      if (!signalled && out.includes('PAUSED')) {
        signalled = true;
        onPaused?.();
      }
    });
    child.on('close', () => {
      const line = out.trim().split(String.fromCharCode(10)).filter(Boolean).pop();
      if (!line) reject(new Error('swapAttemptWorker produced no output'));
      else resolve(JSON.parse(line));
    });
  });
}

describe('Same-attempt swap race (real SQLite DB, real Prisma repositories)', () => {
  it('(31) two independent connections: A (connection 1) holds quote A before BUILT; B (connection 2) takes the attempt and completes; A is rejected before building on it -- no simulate/sign/broadcast; the row holds ONLY B\'s calldata + snapshot, and it survives a restart', async () => {
    const key = 'exit:pos-conn:c:swap:0';
    const entered = latch();
    const gate = latch();
    const A = connectionWorker(prismaA, QUOTE_A, { entered: entered.release, gate: gate.wait });
    const B = connectionWorker(prismaB, QUOTE_B);

    const runA = executeCriticalTransaction(key, 'exit:swap', A.deps, A.repo);
    await entered.wait;
    const resultB = await executeCriticalTransaction(key, 'exit:swap', B.deps, B.repo);
    expect(resultB.ok).toBe(true);
    gate.release();
    const resultA = await runA;

    expect(resultA.ok).toBe(false);
    if (!resultA.ok) expect(resultA.resumable).toBe(true);
    expect(A.calls).toEqual({ buildSwapTx: 1, sign: 0, broadcast: 0 });

    // Restart: a brand-new client reads the persisted row.
    const restarted = new PrismaClient({ adapter: new PrismaBetterSqlite3({ url: DB_URL }) });
    try {
      const row = await new PrismaTransactionAttemptRepository(restarted).find(key);
      expect(row?.status).toBe('VERIFIED');
      const ctx = readExitSwapBuildContext(row?.txRequest?.buildContext);
      expect(ctx).toMatchObject({ minOutputAmountRaw: QUOTE_B.minOutputAmountRaw, expectedAmountOutRaw: QUOTE_B.expectedAmountOutRaw, priceImpactPct: QUOTE_B.priceImpactPct });
      expect(BigInt(row!.txRequest!.data)).toBe(QUOTE_B.minOutputAmountRaw); // calldata B <-> minimum B
      const shared = await new PrismaExitStateRepository(restarted).getOrCreate('pos-conn');
      expect(shared.swapMinOutputAmountRaw).toBeNull();
    } finally {
      await restarted.$disconnect();
    }
  });

  it(
    '(32a) two separate OS processes, A paused after obtaining quote A (before BUILT): B completes in its own process; A resumes and is rejected -- it never simulates, signs or broadcasts; only B\'s calldata + snapshot are stored',
    async () => {
      const key = 'exit:pos-proc:a:swap:0';
      let resolvePaused!: () => void;
      const paused = new Promise<void>((r) => (resolvePaused = r));
      const procA = runProcess(key, 'A', 'build', 850n * U, () => resolvePaused());
      await paused;
      const resultB = await runProcess(key, 'B', 'none', 850n * U);
      const resultA = await procA;

      expect(resultB).toMatchObject({ ok: true });
      expect(resultA).toMatchObject({ ok: false, resumable: true, calls: { buildSwapTx: 1, sign: 0, broadcast: 0 } });
      const row = await new PrismaTransactionAttemptRepository(prismaA).find(key);
      expect(readExitSwapBuildContext(row?.txRequest?.buildContext)?.minOutputAmountRaw).toBe(QUOTE_B.minOutputAmountRaw);
      expect(BigInt(row!.txRequest!.data)).toBe(QUOTE_B.minOutputAmountRaw);
    },
    90_000,
  );

  it(
    '(32b) two separate OS processes, A owns the attempt and is paused INSIDE signing (its own process lock, invisible to B): B resumes A\'s persisted calldata and completes; A\'s SIGNED checkpoint is rejected -- A never broadcasts',
    async () => {
      const key = 'exit:pos-proc:b:swap:0';
      let resolvePaused!: () => void;
      const paused = new Promise<void>((r) => (resolvePaused = r));
      const procA = runProcess(key, 'A', 'sign', 950n * U, () => resolvePaused());
      await paused; // A persisted BUILT (calldata A + snapshot A) and NONCE_ASSIGNED
      const resultB = await runProcess(key, 'B', 'none', 950n * U);
      const resultA = await procA;

      expect(resultB).toMatchObject({ ok: true, calls: { buildSwapTx: 0, broadcast: 1 } }); // B never rebuilt: it resumed A's exact calldata
      expect(resultA).toMatchObject({ ok: false, resumable: true, calls: { sign: 1, broadcast: 0 } });
      const row = await new PrismaTransactionAttemptRepository(prismaA).find(key);
      expect(row?.status).toBe('VERIFIED');
      expect(readExitSwapBuildContext(row?.txRequest?.buildContext)?.minOutputAmountRaw).toBe(QUOTE_A.minOutputAmountRaw);
      expect(BigInt(row!.txRequest!.data)).toBe(QUOTE_A.minOutputAmountRaw); // calldata A <-> minimum A, never B's
    },
    90_000,
  );
});
