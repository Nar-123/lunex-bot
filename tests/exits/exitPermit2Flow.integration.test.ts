import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { getAddress, type Address } from 'viem';
import { execSync } from 'node:child_process';
import { existsSync, rmSync } from 'node:fs';
import path from 'node:path';
import { PrismaClient } from '@prisma/client';
import { PrismaBetterSqlite3 } from '@prisma/adapter-better-sqlite3';
import { PrismaPositionRepository } from '../../src/positions/positionRepository';
import { PrismaTransactionAttemptRepository } from '../../src/execution/transactionAttemptRepository';
import { PrismaExitStateRepository } from '../../src/exits/exitStateRepository';
import { executeExit, type ExecuteExitDeps } from '../../src/exits/executeExit';
import { assessTokenGrant, type TokenGrantAssessment } from '../../src/exits/permit2TokenGrant';
import { EXECUTION_TARGETS } from '../../src/config/constants';
import type { TxRequest, TxSafetyDeps } from '../../src/execution/types';
import type { SwapExecutor, SwapQuote } from '../../src/swap/types';
import { makeCreateInput } from '../positions/fixtures';

/**
 * The Permit2-enabled exit flow against a REAL migrated SQLite database.
 *
 * The property that matters most here is the crash boundary between the grant
 * reaching VERIFIED and the swap running: a restart in that window must resume
 * with the swap, never with a second approval transaction.
 */
const PROJECT_ROOT = path.resolve(__dirname, '../..');
const DB_PATH = path.resolve(PROJECT_ROOT, 'data', 'test-exit-permit2-flow.db');
const DB_URL = `file:${DB_PATH}`;
const U = 10n ** 18n;
const WALLET = '0x9999999999999999999999999999999999999999' as Address;
const UR = getAddress(EXECUTION_TARGETS[4663]!.universalRouters[0]!);
const TARGETS = { chainId: 4663, universalRouters: [UR], swapProxies: [] as string[] };
const RESIDUAL = 3n * U;
const NOW = Math.floor(Date.now() / 1000);
const TX: TxRequest = { to: UR, data: '0x3593564c', value: 0n };

function cleanup(): void {
  for (const s of ['', '-journal', '-wal', '-shm']) if (existsSync(DB_PATH + s)) rmSync(DB_PATH + s);
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

function fakeTxDeps<T>(data: T, over: Partial<TxSafetyDeps<T>> = {}): TxSafetyDeps<T> {
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
    ...over,
  };
}

const QUOTE: SwapQuote = { amountInRaw: RESIDUAL, expectedAmountOutRaw: 290n * U, minOutputAmountRaw: 280n * U, priceImpactPct: 0.001, slippageBps: 100, providerQuote: {}, permitDataPresent: true };
const routable = (): SwapExecutor => ({ getQuote: vi.fn(async () => QUOTE), checkApproval: vi.fn(async () => ({ needsApproval: false, spender: null })), buildSwapTx: vi.fn(async () => TX) });

async function closingPosition() {
  const positions = new PrismaPositionRepository(prisma);
  const token = getAddress(`0x${(seq++).toString(16).padStart(40, '0')}`);
  const created = await positions.create(makeCreateInput({ tokenAddress: token, entryUsdgRaw: 500n * U, openIdempotencyKey: `deploy:${token}` }));
  await positions.markActive(created.id, '1', new Date());
  const closing = (await positions.markClosing(created.id, `exit:${created.id}:1`))!;
  const exitStates = new PrismaExitStateRepository(prisma);
  await exitStates.updateDecisionState(created.id, (await exitStates.getOrCreate(created.id)).version, { pendingCloseReason: 'HARD_STOP_LOSS' });
  return { position: closing, token };
}

/** A real assessment against the production encoder. */
const grantFor = (token: Address, amount: bigint, expiration: number, chainTimestamp = NOW): TokenGrantAssessment =>
  assessTokenGrant({ readFor: { owner: WALLET, token, spender: UR }, expectedOwner: WALLET, expectedToken: token, spender: UR, targets: TARGETS, grant: { amount, expiration, nonce: 0 }, requiredAmount: RESIDUAL, chainTimestamp });

function deps(token: Address, o: { grant: () => TokenGrantAssessment; grantSign?: ReturnType<typeof vi.fn>; swapOver?: Partial<TxSafetyDeps<unknown>> }): ExecuteExitDeps {
  const grantSign = o.grantSign ?? vi.fn(async () => ({ raw: '0x01' as `0x${string}`, hash: `0x${'11'.repeat(32)}` as `0x${string}` }));
  return {
    positions: new PrismaPositionRepository(prisma),
    exitStates: new PrismaExitStateRepository(prisma),
    txAttempts: new PrismaTransactionAttemptRepository(prisma),
    livePositionState: { getLiveState: vi.fn() },
    poolPrice: { getPriceState: vi.fn() },
    swapExecutor: routable(),
    readTokenBalance: vi.fn(async () => RESIDUAL),
    readAllowance: vi.fn(async () => RESIDUAL * 10n),
    walletAddress: WALLET,
    tokenGrantPreflight: vi.fn(async () => o.grant()),
    buildTokenGrantDeps: (() => fakeTxDeps({ amount: RESIDUAL.toString(), expiration: NOW + 86_400, nonce: 0 }, { signTransaction: grantSign as never })) as never,
    simulateSwap: vi.fn(async () => ({ ok: true }) as const),
    buildRemoveLiquidityDeps: vi.fn(() => fakeTxDeps({ liquidityZero: true as const, usdgProceedsRaw: 200n * U, tokenProceedsRaw: RESIDUAL })) as never,
    buildSwapDeps: vi.fn(() => fakeTxDeps({ usdgIncreaseRaw: 290n * U, usdgProceedsRaw: 290n * U }, o.swapOver as never)) as never,
    buildApproveDeps: vi.fn(() => fakeTxDeps({ allowanceRaw: RESIDUAL })),
    warnLog: vi.fn(),
  };
}

const rowsFor = (closeKey: string) => prisma.transactionAttempt.findMany({ where: { idempotencyKey: { startsWith: `permit2:exit:${closeKey}:` } } });

describe('Permit2-enabled exit flow (real SQLite, real migrations)', () => {
  it('CLOSING -> missing grant -> approval leg VERIFIED -> swap -> CLOSED', async () => {
    const { position, token } = await closingPosition();
    const out = await executeExit(position, deps(token, { grant: () => grantFor(token, 0n, 0) }));

    expect(out.outcome).toBe('CLOSED');
    const grants = await rowsFor(position.closeIdempotencyKey!);
    expect(grants).toHaveLength(1);
    expect(grants[0]).toMatchObject({ purpose: 'exit:permit2Grant', status: 'VERIFIED' });
    const swap = await prisma.transactionAttempt.findFirst({ where: { idempotencyKey: `${position.closeIdempotencyKey}:swap:0` } });
    expect(swap?.status).toBe('VERIFIED');
  });

  it('an existing sufficient grant -> NO approval row -> swap directly', async () => {
    const { position, token } = await closingPosition();
    const out = await executeExit(position, deps(token, { grant: () => grantFor(token, RESIDUAL, NOW + 86_400) }));
    expect(out.outcome).toBe('CLOSED');
    expect(await rowsFor(position.closeIdempotencyKey!)).toHaveLength(0);
  });

  it('CRASH BOUNDARY: grant VERIFIED, swap never ran -> after restart the swap resumes with NO second approval', async () => {
    const { position, token } = await closingPosition();

    // 1st process: the grant reaches VERIFIED, then the process "dies" before
    // the swap can be signed (a throw inside the swap build models the crash).
    const firstSign = vi.fn(async () => ({ raw: '0x01' as `0x${string}`, hash: `0x${'11'.repeat(32)}` as `0x${string}` }));
    await executeExit(position, deps(token, {
      grant: () => grantFor(token, 0n, 0),
      grantSign: firstSign,
      swapOver: { simulate: vi.fn(async () => { throw new Error('process killed'); }) },
    })).catch(() => undefined);
    expect(firstSign).toHaveBeenCalledTimes(1);
    const afterCrash = await rowsFor(position.closeIdempotencyKey!);
    expect(afterCrash).toHaveLength(1);
    expect(afterCrash[0]?.status).toBe('VERIFIED');

    // 2nd process: a FRESH PrismaClient (restart); the pre-flight is stale and
    // still says the grant is missing -- the durable VERIFIED row must win.
    const restarted = new PrismaClient({ adapter: new PrismaBetterSqlite3({ url: DB_URL }) });
    try {
      const secondSign = vi.fn(async () => ({ raw: '0x01' as `0x${string}`, hash: `0x${'11'.repeat(32)}` as `0x${string}` }));
      const current = (await new PrismaPositionRepository(restarted).findById(position.id))!;
      const d = deps(token, { grant: () => grantFor(token, 0n, 0), grantSign: secondSign });
      const out = await executeExit(current, {
        ...d,
        positions: new PrismaPositionRepository(restarted),
        exitStates: new PrismaExitStateRepository(restarted),
        txAttempts: new PrismaTransactionAttemptRepository(restarted),
      });

      expect(secondSign).not.toHaveBeenCalled(); // no duplicate approval transaction
      const grants = await rowsFor(position.closeIdempotencyKey!);
      expect(grants).toHaveLength(1);
      expect(grants[0]?.id).toBe(afterCrash[0]?.id);
      expect(out.outcome).not.toBe('FAILED');
    } finally {
      await restarted.$disconnect();
    }
  });

  it('RESTART AT A LATER BLOCK: chain time moved 1h, pre-flight stale -> SAME key, still no second approval', async () => {
    const { position, token } = await closingPosition();
    const firstSign = vi.fn(async () => ({ raw: '0x01' as `0x${string}`, hash: `0x${'11'.repeat(32)}` as `0x${string}` }));
    await executeExit(position, deps(token, {
      grant: () => grantFor(token, 0n, 0, NOW),
      grantSign: firstSign,
      swapOver: { simulate: vi.fn(async () => { throw new Error('process killed'); }) },
    })).catch(() => undefined);
    expect(firstSign).toHaveBeenCalledTimes(1);

    // an hour later the NEW expiration a fresh assessment computes is different --
    // the key must not be, because it identifies the grant being replaced (still 0)
    const secondSign = vi.fn(async () => ({ raw: '0x01' as `0x${string}`, hash: `0x${'11'.repeat(32)}` as `0x${string}` }));
    const current = (await new PrismaPositionRepository(prisma).findById(position.id))!;
    await executeExit(current, deps(token, { grant: () => grantFor(token, 0n, 0, NOW + 3600), grantSign: secondSign }));

    expect(secondSign).not.toHaveBeenCalled();
    expect(await rowsFor(position.closeIdempotencyKey!)).toHaveLength(1);
  });

  it('a grant that EXPIRED AGAIN within the same close lifecycle gets a NEW approval -- never stuck behind a cached VERIFIED row', async () => {
    const { position, token } = await closingPosition();
    // first approval replaces the empty grant (expiration 0)
    await executeExit(position, deps(token, {
      grant: () => grantFor(token, 0n, 0, NOW),
      swapOver: { simulate: vi.fn(async () => ({ ok: false, reason: 'transient' }) as const) },
    }));
    expect(await rowsFor(position.closeIdempotencyKey!)).toHaveLength(1);

    // much later, that grant (expiration E1) has itself expired
    const E1 = NOW + 86_400;
    const reSign = vi.fn(async () => ({ raw: '0x01' as `0x${string}`, hash: `0x${'33'.repeat(32)}` as `0x${string}` }));
    const current = (await new PrismaPositionRepository(prisma).findById(position.id))!;
    await executeExit(current, deps(token, { grant: () => grantFor(token, RESIDUAL, E1, E1 + 60), grantSign: reSign }));

    expect(reSign).toHaveBeenCalledTimes(1); // a genuinely new need -> a new approval
    const rows = await rowsFor(position.closeIdempotencyKey!);
    expect(rows).toHaveLength(2);
    expect(new Set(rows.map((r) => r.idempotencyKey)).size).toBe(2);
    expect(rows.some((r) => r.idempotencyKey.endsWith(':from0'))).toBe(true);
    expect(rows.some((r) => r.idempotencyKey.endsWith(`:from${E1}`))).toBe(true);
  });

  it('a failed approval leaves the position CLOSING, with no swap attempt row', async () => {
    const { position, token } = await closingPosition();
    const out = await executeExit(position, deps(token, {
      grant: () => grantFor(token, 0n, 0),
      grantSign: vi.fn(async () => { throw new Error('eth_signTransaction unavailable'); }),
    }));
    expect(out.outcome).not.toBe('CLOSED');
    expect((await new PrismaPositionRepository(prisma).findById(position.id))?.status).toBe('CLOSING');
    const swap = await prisma.transactionAttempt.findFirst({ where: { idempotencyKey: { startsWith: `${position.closeIdempotencyKey}:swap:` } } });
    expect(swap).toBeNull();
  });
});
