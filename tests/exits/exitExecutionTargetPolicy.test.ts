import { describe, expect, it, vi } from 'vitest';
import type { Address } from 'viem';
import { executeExit, isSwapTargetValidationFailure, type ExecuteExitDeps } from '../../src/exits/executeExit';
import type { TxRequest, TxSafetyDeps } from '../../src/execution/types';
import type { SwapExecutor, SwapQuote } from '../../src/swap/types';
import { InMemoryTransactionAttemptRepository } from '../execution/inMemoryTransactionAttemptRepository';
import { InMemoryPositionRepository } from '../positions/inMemoryPositionRepository';
import { InMemoryExitStateRepository } from './inMemoryExitStateRepository';
import { makeCreateInput } from '../positions/fixtures';
import { decodeBlockReason, encodeBlockReason } from '../../src/exits/swapLegBackoff';
import { config } from '../../src/config';
import { LEGACY_PROXY } from '../swap/executionTargetFixtures';
import { grantAlreadyValid } from '../exits/tokenGrantTestStub';

const TX: TxRequest = { to: '0x1111111111111111111111111111111111111111', data: '0xabcdef', value: 0n };
const WALLET = '0x9999999999999999999999999999999999999999' as Address;
const TOKEN = '0x0000000000000000000000000000000000000002' as Address;
const USDG = (n: number): bigint => BigInt(n) * 10n ** 18n;
const APPROVED_PROXY = config.uniswapTradingApi.executionTargets.swapProxies[0] as Address;
/** The only spender an exit approval may ever name (see `exits/exitApprovalSpender.ts`). */
const PERMIT2 = config.uniswap.v4.permit2 as Address;
const APPROVED_ROUTER = config.uniswapTradingApi.executionTargets.universalRouters[0] as Address;

function fakeTxDeps<T>(data: T, overrides: Partial<TxSafetyDeps<T>> = {}): TxSafetyDeps<T> {
  return {
    buildTransaction: vi.fn(async () => TX),
    simulate: vi.fn(async () => ({ ok: true }) as const),
    estimateGas: vi.fn(async () => 100_000n),
    getGasPrice: vi.fn(async () => 1_000_000_000n),
    checkGasAffordable: vi.fn(async () => ({ ok: true }) as const),
    getNonce: vi.fn(async () => 7),
    signTransaction: vi.fn(async () => ({ raw: '0xdeadbeef' as `0x${string}`, hash: `0x${'ab'.repeat(32)}` as `0x${string}` })),
    broadcastRaw: vi.fn(async () => undefined),
    waitForReceipt: vi.fn(async () => ({ status: 'success' as const, blockNumber: 123n })),
    getReceiptIfAvailable: vi.fn(async () => null),
    verifyOnChain: vi.fn(async () => ({ ok: true as const, data })),
    ...overrides,
  };
}

async function closingPosition(positions: InMemoryPositionRepository) {
  const created = await positions.create(makeCreateInput({ entryUsdgRaw: USDG(500), tokenAddress: TOKEN }));
  await positions.markActive(created.id, '1', new Date());
  await positions.markClosing(created.id, `exit:${created.id}:attempt-1`);
  const position = await positions.findById(created.id);
  if (!position) throw new Error('unreachable');
  return position;
}

function quote(): SwapQuote {
  return { amountInRaw: USDG(500), expectedAmountOutRaw: USDG(490), minOutputAmountRaw: USDG(480), priceImpactPct: 0.001, slippageBps: 100, providerQuote: { fake: true } };
}

function swapExecutor(spender: Address | null, needsApproval = spender !== null): SwapExecutor {
  return { getQuote: vi.fn(async () => quote()), checkApproval: vi.fn(async () => ({ needsApproval, spender })), buildSwapTx: vi.fn() };
}

/** A CLOSING position whose remove-liquidity leg is already VERIFIED, i.e. exactly where the production positions are stuck. */
async function stuckAfterRemoval(over: { blockedReason?: string | null; blockedSince?: Date | null; lastCheckedAt?: Date | null } = {}) {
  const positions = new InMemoryPositionRepository();
  const exitStates = new InMemoryExitStateRepository();
  const txAttempts = new InMemoryTransactionAttemptRepository();
  const position = await closingPosition(positions);
  exitStates.seed({
    positionId: position.id, pendingCloseReason: 'HARD_STOP_LOSS', swapAttemptCount: 0, trailingPeakPnlPct: null, drawdownConfirmStartedAt: null,
    oorStartedAt: null, safetyExitArmedAt: null, maxDrawdownPnlPct: null, metricsFailureSince: null, swapUsdgBalanceBeforeRaw: null,
    swapMinOutputAmountRaw: null, swapVerifiedUsdgIncreaseRaw: null,
    swapLegBlockedReason: over.blockedReason ?? null, swapLegBlockedSince: over.blockedSince ?? null, swapLegLastCheckedAt: over.lastCheckedAt ?? null,
  } as never);
  const removeKey = `${position.closeIdempotencyKey}:removeLiquidity`;
  const attempt = await txAttempts.create(removeKey, 'exit:removeLiquidity');
  await txAttempts.update(attempt.id, { status: 'VERIFIED', verifyData: { liquidityZero: true, usdgProceedsRaw: USDG(400).toString(), tokenProceedsRaw: USDG(5).toString() } });
  return { positions, exitStates, txAttempts, position };
}

function deps(over: Partial<ExecuteExitDeps>, ctx: Awaited<ReturnType<typeof stuckAfterRemoval>>): ExecuteExitDeps {
  return {
    positions: ctx.positions,
    exitStates: ctx.exitStates,
    txAttempts: ctx.txAttempts,
    livePositionState: { getLiveState: vi.fn() },
    poolPrice: { getPriceState: vi.fn() },
    swapExecutor: swapExecutor(null, false),
    tokenGrantPreflight: grantAlreadyValid,
    readTokenBalance: vi.fn(async () => USDG(500)),
    readAllowance: vi.fn(async () => 0n),
    walletAddress: WALLET,
    buildRemoveLiquidityDeps: vi.fn(() => fakeTxDeps({ liquidityZero: true as const, usdgProceedsRaw: USDG(400), tokenProceedsRaw: USDG(500) })),
    buildSwapDeps: vi.fn(() => fakeTxDeps({ usdgIncreaseRaw: USDG(490), usdgProceedsRaw: USDG(490) })),
    buildApproveDeps: vi.fn(() => fakeTxDeps({ allowanceRaw: USDG(500) })),
    warnLog: vi.fn(),
    ...over,
  };
}

describe('approval spender policy (15-18)', () => {
  it('15. the configured PERMIT2 spender is accepted and the approve leg runs for the exact receipt amount', async () => {
    const ctx = await stuckAfterRemoval();
    const buildApproveDeps = vi.fn(() => fakeTxDeps({ allowanceRaw: USDG(500) }));
    const d = deps({ swapExecutor: swapExecutor(PERMIT2), buildApproveDeps }, ctx);

    const outcome = await executeExit(ctx.position, d);

    // D8: the receipt paid 5 TOKEN (the wallet holds 500) -- the approval is for the RECEIPT amount.
    expect(buildApproveDeps).toHaveBeenCalledWith(TOKEN, PERMIT2, USDG(5));
    expect(outcome.outcome).not.toBe('PENDING');
    expect((await ctx.exitStates.getOrCreate(ctx.position.id)).swapLegBlockedReason).toBeNull();
  });

  it('15b. an approved SwapProxy is REFUSED as an ALLOWANCE spender -- being a legal call target is not authority to pull funds', async () => {
    const ctx = await stuckAfterRemoval();
    const buildApproveDeps = vi.fn(() => fakeTxDeps({ allowanceRaw: USDG(500) }));
    const outcome = await executeExit(ctx.position, deps({ swapExecutor: swapExecutor(APPROVED_PROXY), buildApproveDeps }, ctx));

    expect(outcome.outcome).toBe('PENDING');
    expect(outcome.outcome === 'PENDING' ? outcome.reason : '').toMatch(/SPENDER_NOT_PERMIT2/);
    expect(buildApproveDeps).not.toHaveBeenCalled();
  });

  it('18. the approved Universal Router is REFUSED as a TOKEN ERC20 approval spender (it pulls through Permit2, never directly)', async () => {
    const ctx = await stuckAfterRemoval();
    const buildApproveDeps = vi.fn(() => fakeTxDeps({ allowanceRaw: USDG(500) }));
    const outcome = await executeExit(ctx.position, deps({ swapExecutor: swapExecutor(APPROVED_ROUTER), buildApproveDeps }, ctx));

    expect(outcome.outcome).toBe('PENDING');
    expect(outcome.outcome === 'PENDING' ? outcome.reason : '').toMatch(/SPENDER_NOT_PERMIT2/);
    expect(buildApproveDeps).not.toHaveBeenCalled();
    // the router remains a legal SWAP TARGET -- only the allowance is refused
    expect(config.uniswapTradingApi.executionTargets.universalRouters.map((r) => r.toLowerCase())).toContain(APPROVED_ROUTER.toLowerCase());
  });

  it('16. the DEPRECATED legacy proxy spender is refused -- no approval is built, a durable block is recorded', async () => {
    const ctx = await stuckAfterRemoval();
    const buildApproveDeps = vi.fn(() => fakeTxDeps({ allowanceRaw: USDG(500) }));
    const buildSwapDeps = vi.fn(() => fakeTxDeps({ usdgIncreaseRaw: 0n, usdgProceedsRaw: 0n }));
    const d = deps({ swapExecutor: swapExecutor(LEGACY_PROXY as Address), buildApproveDeps, buildSwapDeps }, ctx);

    const outcome = await executeExit(ctx.position, d);

    expect(outcome).toMatchObject({ outcome: 'PENDING' });
    expect(outcome.outcome === 'PENDING' ? outcome.reason : '').toMatch(/SPENDER_NOT_PERMIT2/);
    expect(buildApproveDeps).not.toHaveBeenCalled();
    expect(buildSwapDeps).not.toHaveBeenCalled();
    expect(await ctx.txAttempts.find(`${ctx.position.closeIdempotencyKey}:approve:0`)).toBeNull();
    const state = await ctx.exitStates.getOrCreate(ctx.position.id);
    expect(decodeBlockReason(state.swapLegBlockedReason).reason).toBe('APPROVAL_SPENDER_NOT_APPROVED');
    expect(state.swapLegBlockedSince).not.toBeNull();
  });

  it('17. an arbitrary API-provided spender is refused the same way', async () => {
    const ctx = await stuckAfterRemoval();
    const buildApproveDeps = vi.fn(() => fakeTxDeps({ allowanceRaw: USDG(500) }));
    const outcome = await executeExit(ctx.position, deps({ swapExecutor: swapExecutor('0x1234567890123456789012345678901234567890' as Address), buildApproveDeps }, ctx));
    expect(outcome.outcome).toBe('PENDING');
    expect(buildApproveDeps).not.toHaveBeenCalled();
  });

  it('25. a refused spender never mutates the position (still CLOSING, same key, same entry amount)', async () => {
    const ctx = await stuckAfterRemoval();
    const before = await ctx.positions.findById(ctx.position.id);
    await executeExit(ctx.position, deps({ swapExecutor: swapExecutor(LEGACY_PROXY as Address) }, ctx));
    expect(await ctx.positions.findById(ctx.position.id)).toEqual(before);
    expect((await ctx.exitStates.getOrCreate(ctx.position.id)).swapAttemptCount).toBe(0);
  });
});

describe('deterministic backoff inside the exit flow (21)', () => {
  it('21. while suppressed, the tick makes ZERO provider calls and creates no transaction attempt', async () => {
    const now = Date.now();
    const ctx = await stuckAfterRemoval({
      blockedReason: encodeBlockReason('TARGET_NOT_APPROVED', 'fp1'),
      blockedSince: new Date(now - 5_000),
      lastCheckedAt: new Date(now - 1_000),
    });
    const executor = swapExecutor(APPROVED_PROXY);
    const buildSwapDeps = vi.fn(() => fakeTxDeps({ usdgIncreaseRaw: 0n, usdgProceedsRaw: 0n }));
    const d = deps({ swapExecutor: executor, buildSwapDeps }, ctx);

    const outcome = await executeExit(ctx.position, d);

    expect(outcome.outcome).toBe('PENDING');
    expect(outcome.outcome === 'PENDING' ? outcome.reason : '').toMatch(/retry suppressed until/);
    expect(executor.getQuote).not.toHaveBeenCalled();
    expect(executor.checkApproval).not.toHaveBeenCalled();
    expect(buildSwapDeps).not.toHaveBeenCalled();
    expect(await ctx.txAttempts.findNonTerminal()).toHaveLength(0);
    expect((await ctx.positions.findById(ctx.position.id))?.status).toBe('CLOSING');
  });

  it('once the window expires the flow resumes normally (the provider IS called again)', async () => {
    const now = Date.now();
    const ctx = await stuckAfterRemoval({
      blockedReason: encodeBlockReason('TARGET_NOT_APPROVED', 'fp1'),
      blockedSince: new Date(now - 60_000),
      lastCheckedAt: new Date(now - 60_000),
    });
    const executor = swapExecutor(APPROVED_PROXY);
    await executeExit(ctx.position, deps({ swapExecutor: executor }, ctx));
    expect(executor.getQuote).toHaveBeenCalledTimes(1);
  });

  it('23. a TRANSIENT block never suppresses the tick', async () => {
    const now = Date.now();
    const ctx = await stuckAfterRemoval({ blockedReason: 'QUOTE_UNAVAILABLE', blockedSince: new Date(now - 1_000), lastCheckedAt: new Date(now - 1_000) });
    const executor = swapExecutor(APPROVED_PROXY);
    await executeExit(ctx.position, deps({ swapExecutor: executor }, ctx));
    expect(executor.getQuote).toHaveBeenCalledTimes(1);
  });

  it('a swap rejected by execution-target validation is recognised and recorded as a deterministic block', async () => {
    const ctx = await stuckAfterRemoval();
    const buildSwapDeps = vi.fn(() =>
      fakeTxDeps(
        { usdgIncreaseRaw: 0n, usdgProceedsRaw: 0n },
        { buildTransaction: vi.fn(async () => { throw new Error('SwapQuoteValidationError: swap tx "to" (0x02E5be68D46DAc0B524905bfF209cf47EE6dB2a9) is not an approved execution target for chain 4663'); }) },
      ),
    );
    const outcome = await executeExit(ctx.position, deps({ swapExecutor: swapExecutor(null, false), buildSwapDeps }, ctx));

    expect(outcome.outcome).toBe('PENDING');
    const state = await ctx.exitStates.getOrCreate(ctx.position.id);
    expect(decodeBlockReason(state.swapLegBlockedReason).reason).toBe('TARGET_NOT_APPROVED');
    expect(decodeBlockReason(state.swapLegBlockedReason).fingerprint).toMatch(/^[0-9a-f]{12}$/);
    // 25. the position itself is untouched
    expect((await ctx.positions.findById(ctx.position.id))?.status).toBe('CLOSING');
    expect((await ctx.exitStates.getOrCreate(ctx.position.id)).swapAttemptCount).toBe(0);
  });

  it('classifier: only a validation failure is treated as deterministic', () => {
    expect(isSwapTargetValidationFailure('[BUILD_FAILED] SwapQuoteValidationError: nope')).toBe(true);
    expect(isSwapTargetValidationFailure('[BUILD_FAILED] HTTP 503 from provider')).toBe(false);
    expect(isSwapTargetValidationFailure('socket hang up')).toBe(false);
  });
});
