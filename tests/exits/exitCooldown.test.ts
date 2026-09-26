import { describe, expect, it, vi } from 'vitest';
import type { Address } from 'viem';
import { executeExit } from '../../src/exits/executeExit';
import type { ExecuteExitDeps } from '../../src/exits/executeExit';
import type { TxRequest, TxSafetyDeps } from '../../src/execution/types';
import type { SwapExecutor, SwapQuote } from '../../src/swap/types';
import { EMPTY_EXIT_STATE } from '../../src/exits/types';
import { InMemoryPositionRepository } from '../positions/inMemoryPositionRepository';
import { InMemoryExitStateRepository } from './inMemoryExitStateRepository';
import { InMemoryTransactionAttemptRepository } from '../execution/inMemoryTransactionAttemptRepository';
import { makeCreateInput } from '../positions/fixtures';
import { grantAlreadyValid } from '../exits/tokenGrantTestStub';

// Cooldown crash-gap fix: the cooldown is recorded by markClosed itself (the
// real repository does it in the same DB transaction -- see
// cooldownFinalization.integration.test.ts). These drive the REAL
// executeExit through every close outcome and check that ONLY a genuinely
// successful close records a cooldown -- exactly once, stamped with the
// close time.

const WALLET = '0x9999999999999999999999999999999999999999' as Address;
const TOKEN = '0x0000000000000000000000000000000000000002' as Address;
const USDG = (n: number): bigint => BigInt(n) * 10n ** 18n;
const TX: TxRequest = { to: '0x1111111111111111111111111111111111111111', data: '0xabcdef', value: 0n };

function fakeTxDeps<T>(data: T, overrides: Partial<TxSafetyDeps<T>> = {}): TxSafetyDeps<T> {
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
    ...overrides,
  };
}

const quote = (o: Partial<SwapQuote> = {}): SwapQuote => ({ amountInRaw: USDG(3), expectedAmountOutRaw: USDG(100), minOutputAmountRaw: 0n, priceImpactPct: 0.001, slippageBps: 100, providerQuote: {}, ...o });
const executor = (q: SwapQuote | Error): SwapExecutor => ({
  getQuote: vi.fn(async () => {
    if (q instanceof Error) throw q;
    return q;
  }),
  checkApproval: vi.fn(async () => ({ needsApproval: false, spender: null })),
  buildSwapTx: vi.fn(async () => TX),
});

async function setup(reason: 'HARD_STOP_LOSS' | 'SAFETY_EXIT' | 'OOR_TIMEOUT' = 'HARD_STOP_LOSS') {
  const cooldown = { recordExit: vi.fn(async (_token: string, _exitedAt?: Date) => undefined) };
  const txAttempts = new InMemoryTransactionAttemptRepository();
  const positions = new InMemoryPositionRepository(txAttempts, cooldown);
  const exitStates = new InMemoryExitStateRepository();
  const created = await positions.create(makeCreateInput({ tokenAddress: TOKEN, entryUsdgRaw: USDG(500) }));
  await positions.markActive(created.id, '1', new Date());
  const position = (await positions.markClosing(created.id, `exit:${created.id}:1`))!;
  exitStates.seed({ positionId: created.id, ...EMPTY_EXIT_STATE, pendingCloseReason: reason });
  const deps = (o: Partial<ExecuteExitDeps>): ExecuteExitDeps => ({
    positions,
    exitStates,
    txAttempts,
    livePositionState: { getLiveState: vi.fn() },
    poolPrice: { getPriceState: vi.fn() },
    swapExecutor: executor(quote()),
    tokenGrantPreflight: grantAlreadyValid,
    readTokenBalance: vi.fn(async () => USDG(3)),
    readAllowance: vi.fn(async () => 10n ** 30n), // HIGH-1: TOKEN->Permit2 allowance already sufficient, so the approve leg is skipped (it is not this test's subject)
    walletAddress: WALLET,
    warnLog: vi.fn(),
    ...o,
  });
  return { cooldown, positions, position, deps };
}

const removePaying = (usdg: bigint, token: bigint) => vi.fn(() => fakeTxDeps({ liquidityZero: true as const, usdgProceedsRaw: usdg, tokenProceedsRaw: token }));

describe('Cooldown crash-gap fix -- only a genuinely successful close records a cooldown (real executeExit)', () => {
  it.each(['HARD_STOP_LOSS', 'SAFETY_EXIT', 'OOR_TIMEOUT'] as const)('(1, 24) USDG-only close after %s -> CLOSED and exactly one cooldown, stamped with closedAt', async (reason) => {
    const ctx = await setup(reason);
    const outcome = await executeExit(ctx.position, ctx.deps({ buildRemoveLiquidityDeps: removePaying(USDG(500), 0n) }));
    expect(outcome).toEqual({ outcome: 'CLOSED' });
    const closed = await ctx.positions.findById(ctx.position.id);
    expect(closed?.closeReason).toBe(reason);
    expect(ctx.cooldown.recordExit).toHaveBeenCalledTimes(1);
    expect(ctx.cooldown.recordExit).toHaveBeenCalledWith(TOKEN, closed!.closedAt);
  });

  it('(2) TOKEN swap close -> CLOSED and exactly one cooldown', async () => {
    const ctx = await setup();
    const outcome = await executeExit(ctx.position, ctx.deps({ buildRemoveLiquidityDeps: removePaying(USDG(200), USDG(3)), buildSwapDeps: vi.fn(() => fakeTxDeps({ usdgIncreaseRaw: USDG(290), usdgProceedsRaw: USDG(290) })) }));
    expect(outcome).toEqual({ outcome: 'CLOSED' });
    expect(ctx.cooldown.recordExit).toHaveBeenCalledTimes(1);
  });

  it('(3) failed exit (remove-liquidity definitively failed -> back to ACTIVE) -> no cooldown', async () => {
    const ctx = await setup();
    const outcome = await executeExit(ctx.position, ctx.deps({ buildRemoveLiquidityDeps: vi.fn(() => fakeTxDeps({ liquidityZero: true as const, usdgProceedsRaw: 0n }, { simulate: vi.fn(async () => ({ ok: false as const, reason: 'would revert' })) })) }));
    expect(outcome.outcome).toBe('REVERTED_TO_ACTIVE');
    expect(ctx.cooldown.recordExit).not.toHaveBeenCalled();
  });

  it('(4, 5, 25) TOKEN dust whose quote is unavailable -> PENDING, stays CLOSING, no cooldown', async () => {
    const ctx = await setup();
    const outcome = await executeExit(ctx.position, ctx.deps({ buildRemoveLiquidityDeps: removePaying(USDG(500), 37n), readTokenBalance: vi.fn(async () => 37n), swapExecutor: executor(new Error('HTTP 404 No quotes available')) }));
    expect(outcome.outcome).toBe('PENDING');
    expect((await ctx.positions.findById(ctx.position.id))?.status).toBe('CLOSING');
    expect(ctx.cooldown.recordExit).not.toHaveBeenCalled();
  });

  it('(6) price-impact blocked -> PENDING, no cooldown', async () => {
    const ctx = await setup();
    const outcome = await executeExit(ctx.position, ctx.deps({ buildRemoveLiquidityDeps: removePaying(USDG(200), USDG(3)), swapExecutor: executor(quote({ priceImpactPct: null })) }));
    expect(outcome.outcome).toBe('PENDING');
    expect(ctx.cooldown.recordExit).not.toHaveBeenCalled();
  });

  it('(7) ambiguous transaction (broadcast uncertain) -> PENDING, no cooldown', async () => {
    const ctx = await setup();
    const outcome = await executeExit(ctx.position, ctx.deps({ buildRemoveLiquidityDeps: vi.fn(() => fakeTxDeps({ liquidityZero: true as const, usdgProceedsRaw: 0n, tokenProceedsRaw: 0n }, { broadcastRaw: vi.fn(async () => { throw new Error('ECONNRESET'); }) })) }));
    expect(outcome.outcome).toBe('PENDING');
    expect(ctx.cooldown.recordExit).not.toHaveBeenCalled();
  });

  it('(10, 13) a failure while recording the cooldown rolls the close back (still CLOSING, no proceeds); the retry closes with exactly one cooldown', async () => {
    const ctx = await setup();
    ctx.cooldown.recordExit.mockRejectedValueOnce(new Error('crash while writing cooldown'));
    const deps = ctx.deps({ buildRemoveLiquidityDeps: removePaying(USDG(500), 0n) });
    await expect(executeExit(ctx.position, deps)).rejects.toThrow(/crash while writing cooldown/);
    expect(await ctx.positions.findById(ctx.position.id)).toMatchObject({ status: 'CLOSING', realizedUsdgRaw: null, closedAt: null });

    expect(await executeExit(ctx.position, deps)).toEqual({ outcome: 'CLOSED' });
    expect(ctx.cooldown.recordExit).toHaveBeenCalledTimes(2); // 1 rolled back + 1 committed
    expect((await ctx.positions.findById(ctx.position.id))?.realizedUsdgRaw).toBe(USDG(500));
    expect((await executeExit(ctx.position, deps)).outcome).toBe('PENDING'); // repeated calls: no further cooldown
    expect(ctx.cooldown.recordExit).toHaveBeenCalledTimes(2);
  });

  it('(14) two concurrent finalizations of the same close: one CLOSED, one cooldown', async () => {
    const ctx = await setup();
    const deps = ctx.deps({ buildRemoveLiquidityDeps: removePaying(USDG(500), 0n) });
    const outcomes = await Promise.all([executeExit(ctx.position, deps), executeExit(ctx.position, deps)]);
    expect(outcomes.map((o) => o.outcome).sort()).toEqual(['CLOSED', 'PENDING']);
    expect(ctx.cooldown.recordExit).toHaveBeenCalledTimes(1);
  });
});
