import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import type { Address } from 'viem';
import { execSync } from 'node:child_process';
import { existsSync, rmSync } from 'node:fs';
import path from 'node:path';
import { PrismaClient } from '@prisma/client';
import { PrismaBetterSqlite3 } from '@prisma/adapter-better-sqlite3';
import { PrismaPositionRepository } from '../../src/positions/positionRepository';
import { PrismaTransactionAttemptRepository } from '../../src/execution/transactionAttemptRepository';
import { PrismaExitStateRepository } from '../../src/exits/exitStateRepository';
import { PositionCapitalSnapshotProvider } from '../../src/positions/capitalSnapshotProvider';
import { executeExit } from '../../src/exits/executeExit';
import type { TxSafetyDeps } from '../../src/execution/types';
import type { RemoveLiquidityVerifyData } from '../../src/exits/removeLiquidityTx';
import type { SwapExecutor } from '../../src/swap/types';
import { makeCreateInput } from '../positions/fixtures';

// H1 end-to-end against a REAL migrated SQLite DB and the REAL repositories:
// proves the new `tokenProceedsRaw: 0n` survives the TransactionAttempt
// verifyData JSON round-trip (bigint tagging), that a crash between the
// VERIFIED removal and markClosed resumes to exactly one CLOSED row, that
// the position leaves deployed capital, and that the REAL partial unique
// index then allows re-entry for the same token.

const PROJECT_ROOT = path.resolve(__dirname, '../..');
const DB_PATH = path.resolve(PROJECT_ROOT, 'data', 'test-usdg-only-close.db');
const DB_URL = `file:${DB_PATH}`;
const WALLET = '0x9999999999999999999999999999999999999999' as Address;
const TOKEN = '0x00000000000000000000000000000000000000f7' as Address;
const U = 10n ** 18n;

function cleanup(): void {
  for (const suffix of ['', '-journal', '-wal', '-shm']) {
    if (existsSync(DB_PATH + suffix)) rmSync(DB_PATH + suffix);
  }
}

let prisma: PrismaClient;

beforeAll(() => {
  cleanup();
  execSync('npx prisma migrate deploy', { cwd: PROJECT_ROOT, env: { ...process.env, DATABASE_URL: DB_URL }, stdio: 'pipe' });
  prisma = new PrismaClient({ adapter: new PrismaBetterSqlite3({ url: DB_URL }) });
}, 30_000);

afterAll(async () => {
  await prisma.$disconnect();
  cleanup();
});

function usdgOnlyRemoveDeps(usdg: bigint): TxSafetyDeps<RemoveLiquidityVerifyData> {
  return {
    buildTransaction: vi.fn(async () => ({ to: '0x1111111111111111111111111111111111111111' as Address, data: '0xabcdef' as `0x${string}`, value: 0n })),
    simulate: vi.fn(async () => ({ ok: true }) as const),
    estimateGas: vi.fn(async () => 100_000n),
    getGasPrice: vi.fn(async () => 1_000_000_000n),
    checkGasAffordable: vi.fn(async () => ({ ok: true }) as const),
    getNonce: vi.fn(async () => 7),
    signTransaction: vi.fn(async () => ({ raw: '0xdeadbeef' as `0x${string}`, hash: `0x${'ab'.repeat(32)}` as `0x${string}` })),
    broadcastRaw: vi.fn(async () => undefined),
    waitForReceipt: vi.fn(async () => ({ status: 'success' as const, blockNumber: 1n })),
    getReceiptIfAvailable: vi.fn(async () => null),
    verifyOnChain: vi.fn(async () => ({ ok: true as const, data: { liquidityZero: true as const, usdgProceedsRaw: usdg, tokenProceedsRaw: 0n } })),
  };
}

const neverSwap = {
  getQuote: vi.fn(async () => { throw new Error('must never quote a USDG-only close'); }),
  checkApproval: vi.fn(async () => { throw new Error('must never approve a USDG-only close'); }),
  buildSwapTx: vi.fn(),
} as unknown as SwapExecutor;

describe('H1 (real SQLite DB): USDG-only close -- crash-resume, capital release, token re-entry', () => {
  it(
    'VERIFIED USDG-only removal -> crash in markClosed -> resume closes exactly once; tokenProceedsRaw=0n round-trips through the DB; deployed capital drops to 0; the same token can be opened again',
    async () => {
      const positions = new PrismaPositionRepository(prisma);
      const txAttempts = new PrismaTransactionAttemptRepository(prisma);
      const exitStates = new PrismaExitStateRepository(prisma);

      const created = await positions.create(makeCreateInput({ tokenAddress: TOKEN, entryUsdgRaw: 500n * U, openIdempotencyKey: 'deploy:f7:1' }));
      await positions.markActive(created.id, '777', new Date());
      await exitStates.updateDecisionState(created.id, (await exitStates.getOrCreate(created.id)).version, { pendingCloseReason: 'OOR_TIMEOUT' });
      const closing = (await positions.markClosing(created.id, `exit:${created.id}:1`))!;

      const removeDeps = usdgOnlyRemoveDeps(500n * U);
      const deps = {
        positions,
        exitStates,
        txAttempts,
        livePositionState: { getLiveState: vi.fn() },
        poolPrice: { getPriceState: vi.fn() },
        swapExecutor: neverSwap,
        buildRemoveLiquidityDeps: vi.fn(() => removeDeps),
        buildSwapDeps: vi.fn(() => { throw new Error('must never build a swap'); }),
        readTokenBalance: vi.fn(async () => 0n),
        walletAddress: WALLET,
      };

      // "Process 1": remove-liquidity reaches VERIFIED, then the process dies inside markClosed.
      const markClosed = vi.spyOn(positions, 'markClosed').mockRejectedValueOnce(new Error('process killed mid-write'));
      await expect(executeExit(closing, deps)).rejects.toThrow(/process killed/);
      expect((await positions.findById(created.id))?.status).toBe('CLOSING');

      // The persisted, receipt-derived proof survived the real JSON round-trip as a bigint 0n.
      const removal = await txAttempts.find(`${closing.closeIdempotencyKey}:removeLiquidity`);
      expect(removal?.status).toBe('VERIFIED');
      expect(removal?.verifyData).toEqual({ liquidityZero: true, usdgProceedsRaw: 500n * U, tokenProceedsRaw: 0n });

      // "Process 2": resume. Nothing is rebuilt or re-broadcast.
      const broadcastsBefore = (removeDeps.broadcastRaw as ReturnType<typeof vi.fn>).mock.calls.length;
      expect(await executeExit(closing, deps)).toEqual({ outcome: 'CLOSED' });
      expect((removeDeps.broadcastRaw as ReturnType<typeof vi.fn>).mock.calls.length).toBe(broadcastsBefore);
      expect(markClosed).toHaveBeenCalledTimes(2);

      // Repeated calls afterward are no-ops.
      expect((await executeExit(closing, deps)).outcome).toBe('PENDING');

      const row = await prisma.position.findUniqueOrThrow({ where: { id: created.id } });
      expect(row.status).toBe('CLOSED');
      expect(row.closeReason).toBe('OOR_TIMEOUT');
      expect(row.realizedUsdgRaw).toBe((500n * U).toString());

      // Capital: raw wallet 1000 after the burn; the closed position no longer counts.
      const snapshot = await new PositionCapitalSnapshotProvider(positions, WALLET, async () => 1000n * U).getSnapshot();
      expect(snapshot).toEqual({ freeUsdgBalance: 1000n * U, totalDeployedUsdg: 0n, activePositionsCount: 0 });

      // Token slot: the REAL partial unique index allows a new non-closed position for the same token.
      const reentry = await positions.create(makeCreateInput({ tokenAddress: TOKEN, entryUsdgRaw: 350n * U, openIdempotencyKey: 'deploy:f7:2' }));
      expect(reentry.status).toBe('OPENING');
    },
    30_000,
  );
});
