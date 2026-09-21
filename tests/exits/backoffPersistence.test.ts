import { describe, expect, it, vi } from 'vitest';
import type { Address } from 'viem';
import { executeExit, type ExecuteExitDeps } from '../../src/exits/executeExit';
import { decodeBlockReason, encodeBlockReason, evaluateSuppression } from '../../src/exits/swapLegBackoff';
import type { TxRequest, TxSafetyDeps } from '../../src/execution/types';
import type { SwapExecutor, SwapQuote } from '../../src/swap/types';
import { InMemoryTransactionAttemptRepository } from '../execution/inMemoryTransactionAttemptRepository';
import { InMemoryPositionRepository } from '../positions/inMemoryPositionRepository';
import { InMemoryExitStateRepository } from './inMemoryExitStateRepository';
import { makeCreateInput } from '../positions/fixtures';
import { config } from '../../src/config';
import { grantAlreadyValid } from '../exits/tokenGrantTestStub';

/**
 * Backoff follow-up: a deterministic block must survive a tick that merely
 * clears the price-impact gate.
 *
 * Production showed the ladder restarting every time the impact gate happened
 * to pass, because the swap leg cleared its block BEFORE attempting the swap.
 * The block is a statement about configuration; only a changed fingerprint or a
 * successful swap ends it.
 */
const TX: TxRequest = { to: '0x1111111111111111111111111111111111111111', data: '0xabcdef', value: 0n };
const WALLET = '0x9999999999999999999999999999999999999999' as Address;
const TOKEN = '0x0000000000000000000000000000000000000002' as Address;
const U = (n: number): bigint => BigInt(n) * 10n ** 18n;
const APPROVED_PROXY = config.uniswapTradingApi.executionTargets.swapProxies[0] as Address;
const VALIDATION_FAILURE = 'SwapQuoteValidationError: swap tx "to" (0x02E5be68D46DAc0B524905bfF209cf47EE6dB2a9) is not an approved execution target for chain 4663';

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
    waitForReceipt: vi.fn(async () => ({ status: 'success' as const, blockNumber: 1n })),
    getReceiptIfAvailable: vi.fn(async () => null),
    verifyOnChain: vi.fn(async () => ({ ok: true as const, data })),
    ...overrides,
  };
}

const quote = (impactPct: number): SwapQuote => ({ amountInRaw: U(500), expectedAmountOutRaw: U(490), minOutputAmountRaw: U(480), priceImpactPct: impactPct, slippageBps: 100, providerQuote: {} });
const executor = (impactPct: number): SwapExecutor => ({
  getQuote: vi.fn(async () => quote(impactPct)),
  checkApproval: vi.fn(async () => ({ needsApproval: false, spender: null })),
  buildSwapTx: vi.fn(),
});

/** CLOSING position, remove-liquidity VERIFIED, with a pre-existing swap-leg block. */
async function scenario(block: { reason: string; fingerprint?: string; sinceMsAgo: number; lastCheckedMsAgo: number } | null) {
  const positions = new InMemoryPositionRepository();
  const exitStates = new InMemoryExitStateRepository();
  const txAttempts = new InMemoryTransactionAttemptRepository();
  const created = await positions.create(makeCreateInput({ entryUsdgRaw: U(500), tokenAddress: TOKEN }));
  await positions.markActive(created.id, '1', new Date());
  await positions.markClosing(created.id, `exit:${created.id}:k`);
  const position = (await positions.findById(created.id))!;
  const now = Date.now();
  exitStates.seed({
    positionId: position.id, pendingCloseReason: 'HARD_STOP_LOSS', swapAttemptCount: 0, trailingPeakPnlPct: null, drawdownConfirmStartedAt: null,
    oorStartedAt: null, safetyExitArmedAt: null, maxDrawdownPnlPct: null, metricsFailureSince: null, swapUsdgBalanceBeforeRaw: null,
    swapMinOutputAmountRaw: null, swapVerifiedUsdgIncreaseRaw: null,
    swapLegBlockedReason: block ? encodeBlockReason(block.reason as never, block.fingerprint) : null,
    swapLegBlockedSince: block ? new Date(now - block.sinceMsAgo) : null,
    swapLegLastCheckedAt: block ? new Date(now - block.lastCheckedMsAgo) : null,
  } as never);
  const remove = await txAttempts.create(`${position.closeIdempotencyKey}:removeLiquidity`, 'exit:removeLiquidity');
  await txAttempts.update(remove.id, { status: 'VERIFIED', verifyData: { liquidityZero: true, usdgProceedsRaw: U(400).toString(), tokenProceedsRaw: U(5).toString() } });
  return { positions, exitStates, txAttempts, position };
}

function deps(ctx: Awaited<ReturnType<typeof scenario>>, over: Partial<ExecuteExitDeps>): ExecuteExitDeps {
  return {
    positions: ctx.positions, exitStates: ctx.exitStates, txAttempts: ctx.txAttempts,
    livePositionState: { getLiveState: vi.fn() }, poolPrice: { getPriceState: vi.fn() },
    swapExecutor: executor(0.001), readTokenBalance: vi.fn(async () => U(500)), readAllowance: vi.fn(async () => U(1000)), walletAddress: WALLET,
    tokenGrantPreflight: grantAlreadyValid,
    buildRemoveLiquidityDeps: vi.fn(() => fakeTxDeps({ liquidityZero: true as const, usdgProceedsRaw: U(400) })),
    buildSwapDeps: vi.fn(() => fakeTxDeps({ usdgIncreaseRaw: U(490), usdgProceedsRaw: U(490) })),
    buildApproveDeps: vi.fn(() => fakeTxDeps({ allowanceRaw: U(500) })),
    warnLog: vi.fn(),
    ...over,
  };
}

const failingSwap = () => vi.fn(() => fakeTxDeps({ usdgIncreaseRaw: 0n, usdgProceedsRaw: 0n }, { buildTransaction: vi.fn(async () => { throw new Error(VALIDATION_FAILURE); }) }));

/** Backdates an existing block so the next tick is past its backoff rung (15-min rung at 60 min blocked). */
async function backdate(ctx: Awaited<ReturnType<typeof scenario>>, minutesAgo: number): Promise<Date> {
  const since = new Date(Date.now() - minutesAgo * 60_000);
  await ctx.exitStates.update(ctx.position.id, { swapLegBlockedSince: since, swapLegLastCheckedAt: since } as never);
  return since;
}

describe('deterministic block survives a passing impact gate', () => {
  it('a tick that clears the impact gate does NOT reset the ladder: blockedSince is preserved', async () => {
    const ctx = await scenario(null);

    // tick 1: the target is unapproved -> the code records its OWN fingerprint
    await executeExit(ctx.position, deps(ctx, { swapExecutor: executor(0.001), buildSwapDeps: failingSwap() }));
    const first = await ctx.exitStates.getOrCreate(ctx.position.id);
    expect(decodeBlockReason(first.swapLegBlockedReason).reason).toBe('TARGET_NOT_APPROVED');
    const fingerprint = decodeBlockReason(first.swapLegBlockedReason).fingerprint;
    expect(fingerprint).toBeTruthy();
    const since = await backdate(ctx, 60);

    // tick 2: impact is fine again, but the target is STILL unapproved -- the identical failure
    await executeExit(ctx.position, deps(ctx, { swapExecutor: executor(0.001), buildSwapDeps: failingSwap() }));

    const after = await ctx.exitStates.getOrCreate(ctx.position.id);
    expect(decodeBlockReason(after.swapLegBlockedReason).fingerprint).toBe(fingerprint);
    expect(after.swapLegBlockedSince).toEqual(since); // ladder NOT restarted by the passing impact gate
    expect(evaluateSuppression(after, new Date()).operatorActionRequired).toBe(true); // 60 min still counts
  });

  it('the preserved age keeps the backoff at its escalated rung (a long-standing block stays suppressed)', async () => {
    const ctx = await scenario(null);
    await executeExit(ctx.position, deps(ctx, { swapExecutor: executor(0.001), buildSwapDeps: failingSwap() }));
    await backdate(ctx, 20); // 20 min blocked, last checked 20 min ago -> 15-min rung -> due

    // one due tick re-checks and re-stamps swapLegLastCheckedAt...
    const due = executor(0.001);
    await executeExit(ctx.position, deps(ctx, { swapExecutor: due, buildSwapDeps: failingSwap() }));
    expect(due.getQuote).toHaveBeenCalledTimes(1);

    // ...and the NEXT tick is suppressed before any provider call, because the age (not the check) drives the rung
    const suppressed = executor(0.001);
    const outcome = await executeExit(ctx.position, deps(ctx, { swapExecutor: suppressed, buildSwapDeps: failingSwap() }));
    expect(outcome.outcome).toBe('PENDING');
    expect(suppressed.getQuote).not.toHaveBeenCalled();
  });

  it('a TRANSIENT block is still cleared when conditions improve (unchanged behaviour)', async () => {
    const ctx = await scenario({ reason: 'PRICE_IMPACT_BLOCKED', sinceMsAgo: 60_000, lastCheckedMsAgo: 60_000 });

    await executeExit(ctx.position, deps(ctx, { swapExecutor: executor(0.001) })); // impact fine now, swap succeeds

    const after = await ctx.exitStates.getOrCreate(ctx.position.id);
    expect(after.swapLegBlockedReason).toBeNull();
    expect((await ctx.positions.findById(ctx.position.id))?.status).toBe('CLOSED');
  });

  it('a successful swap clears a deterministic block too', async () => {
    const ctx = await scenario(null);
    await executeExit(ctx.position, deps(ctx, { swapExecutor: executor(0.001), buildSwapDeps: failingSwap() }));
    expect((await ctx.exitStates.getOrCreate(ctx.position.id)).swapLegBlockedReason).not.toBeNull();
    await backdate(ctx, 60);

    await executeExit(ctx.position, deps(ctx, { swapExecutor: executor(0.001) })); // target approved again -> swap succeeds

    expect((await ctx.exitStates.getOrCreate(ctx.position.id)).swapLegBlockedReason).toBeNull();
    expect((await ctx.positions.findById(ctx.position.id))?.status).toBe('CLOSED');
  });

  it('a CHANGED fingerprint still resets the ladder immediately', async () => {
    const ctx = await scenario(null);
    await executeExit(ctx.position, deps(ctx, { swapExecutor: executor(0.001), buildSwapDeps: failingSwap() }));
    const firstPrint = decodeBlockReason((await ctx.exitStates.getOrCreate(ctx.position.id)).swapLegBlockedReason).fingerprint;
    const since = await backdate(ctx, 60);

    const differentFailure = vi.fn(() => fakeTxDeps({ usdgIncreaseRaw: 0n, usdgProceedsRaw: 0n }, {
      buildTransaction: vi.fn(async () => { throw new Error('SwapQuoteValidationError: SwapProxy calldata names router 0x204FAca1764B154221e35c0d20aBb3c525710498, which is NOT an approved Universal Router'); }),
    }));
    await executeExit(ctx.position, deps(ctx, { swapExecutor: executor(0.001), buildSwapDeps: differentFailure }));

    const after = await ctx.exitStates.getOrCreate(ctx.position.id);
    expect(decodeBlockReason(after.swapLegBlockedReason).fingerprint).not.toBe(firstPrint);
    expect(after.swapLegBlockedSince!.getTime()).toBeGreaterThan(since.getTime()); // fresh condition, evaluated now
  });

  it('an approval-spender block behaves the same way (deterministic, preserved)', async () => {
    const rogue = () => ({ ...executor(0.001), checkApproval: vi.fn(async () => ({ needsApproval: true, spender: '0x02E5be68D46DAc0B524905bfF209cf47EE6dB2a9' as Address })) });
    const ctx = await scenario(null);
    await executeExit(ctx.position, deps(ctx, { swapExecutor: rogue() as never, readAllowance: vi.fn(async () => 0n) }));
    const first = await ctx.exitStates.getOrCreate(ctx.position.id);
    expect(decodeBlockReason(first.swapLegBlockedReason).reason).toBe('APPROVAL_SPENDER_NOT_APPROVED');
    const since = await backdate(ctx, 60);

    await executeExit(ctx.position, deps(ctx, { swapExecutor: rogue() as never, readAllowance: vi.fn(async () => 0n) }));

    const after = await ctx.exitStates.getOrCreate(ctx.position.id);
    expect(decodeBlockReason(after.swapLegBlockedReason).reason).toBe('APPROVAL_SPENDER_NOT_APPROVED');
    expect(after.swapLegBlockedSince).toEqual(since);
  });

  it('safety unchanged: nothing is signed or sent on any of these ticks', async () => {
    const ctx = await scenario(null);
    const swapDeps = failingSwap();
    await executeExit(ctx.position, deps(ctx, { swapExecutor: executor(0.001), buildSwapDeps: swapDeps }));
    await backdate(ctx, 60);
    await executeExit(ctx.position, deps(ctx, { swapExecutor: executor(0.001), buildSwapDeps: swapDeps }));

    for (const r of swapDeps.mock.results) {
      const built = r.value as TxSafetyDeps<unknown>;
      expect(built.signTransaction).not.toHaveBeenCalled();
      expect(built.broadcastRaw).not.toHaveBeenCalled();
    }
    expect((await ctx.positions.findById(ctx.position.id))?.status).toBe('CLOSING');
  });
});
