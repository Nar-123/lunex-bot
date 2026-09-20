import { describe, expect, it, vi } from 'vitest';
import type { Address } from 'viem';
import { DUST_CONFIRMATION, isDustValue, isQuoteFresh, settleResidualDust, type DustSettlementDeps } from '../../src/exits/dustSettlement';
import { InMemoryPositionRepository } from '../positions/inMemoryPositionRepository';
import { InMemoryTransactionAttemptRepository } from '../execution/inMemoryTransactionAttemptRepository';
import { makeCreateInput } from '../positions/fixtures';
import type { SwapExecutor, SwapQuote } from '../../src/swap/types';
import { config } from '../../src/config';

const WALLET = '0x9999999999999999999999999999999999999999' as Address;
const TOKEN = '0x0000000000000000000000000000000000000002' as Address;
const THRESHOLD = config.rules.exits.DUST_SETTLEMENT.MAX_USDG_VALUE_RAW;
const T0 = new Date('2026-09-20T06:00:00.000Z');

/** The two live residuals this policy exists for (raw token units and their quoted USDG value). */
const PONS = { residual: 14467194911816926n, value: 8712n };
const MEME = { residual: 18637992326280697n, value: 536n };

function quoteExecutor(valueRaw: bigint, over: Partial<SwapExecutor> = {}): SwapExecutor {
  return {
    getQuote: vi.fn(async (_t: Address, amountInRaw: bigint) => ({
      amountInRaw,
      expectedAmountOutRaw: valueRaw,
      minOutputAmountRaw: 0n,
      priceImpactPct: 0.001,
      slippageBps: 100,
      providerQuote: { fake: true },
    }) satisfies SwapQuote),
    checkApproval: vi.fn(async () => ({ needsApproval: false, spender: null })),
    buildSwapTx: vi.fn(async () => { throw new Error('dust settlement must never build a swap transaction'); }),
    ...over,
  };
}

/** A CLOSING position whose remove-liquidity is VERIFIED with a TOKEN residual -- the production shape. */
async function scenario(opts: { residual?: bigint; removeUsdg?: bigint; status?: 'CLOSING' | 'ACTIVE' | 'OPENING' } = {}) {
  const positions = new InMemoryPositionRepository();
  const txAttempts = new InMemoryTransactionAttemptRepository();
  const created = await positions.create(makeCreateInput({ entryUsdgRaw: 20_906_915n, tokenAddress: TOKEN }));
  const status = opts.status ?? 'CLOSING';
  if (status !== 'OPENING') await positions.markActive(created.id, '1', T0);
  if (status === 'CLOSING') await positions.markClosing(created.id, `exit:${created.id}:lifecycle-1`);
  const position = (await positions.findById(created.id))!;
  if (status === 'CLOSING') {
    const attempt = await txAttempts.create(`${position.closeIdempotencyKey}:removeLiquidity`, 'exit:removeLiquidity');
    await txAttempts.update(attempt.id, {
      status: 'VERIFIED',
      verifyData: { liquidityZero: true, usdgProceedsRaw: (opts.removeUsdg ?? 20_915_201n).toString(), tokenProceedsRaw: (opts.residual ?? PONS.residual).toString() },
    });
  }
  return { positions, txAttempts, position };
}

function deps(ctx: Awaited<ReturnType<typeof scenario>>, executor: SwapExecutor, over: Partial<DustSettlementDeps> = {}): DustSettlementDeps {
  return {
    positions: ctx.positions,
    txAttempts: ctx.txAttempts,
    swapExecutor: executor,
    readTokenBalance: vi.fn(async () => 10n ** 30n),
    walletAddress: WALLET,
    now: () => T0,
    auditLog: vi.fn(),
    ...over,
  };
}

const request = (ctx: Awaited<ReturnType<typeof scenario>>, over: Record<string, unknown> = {}) => ({
  positionId: ctx.position.id,
  closeIdempotencyKey: ctx.position.closeIdempotencyKey ?? '',
  confirm: DUST_CONFIRMATION,
  actor: 'admin',
  requestId: 'req-1',
  ...over,
});

describe('dust policy (pure)', () => {
  it('1/2/3. strictly below the threshold is dust; exactly at or above is not', () => {
    expect(isDustValue(THRESHOLD - 1n, THRESHOLD)).toBe(true);
    expect(isDustValue(THRESHOLD, THRESHOLD)).toBe(false);
    expect(isDustValue(THRESHOLD + 1n, THRESHOLD)).toBe(false);
  });

  it('a zero/disabled threshold disables the mechanism entirely, and a negative quote is never dust', () => {
    expect(isDustValue(0n, 0n)).toBe(false);
    expect(isDustValue(5n, -1n)).toBe(false);
    expect(isDustValue(-1n, THRESHOLD)).toBe(false);
  });

  it('6. quote freshness window', () => {
    const maxAge = config.rules.exits.DUST_SETTLEMENT.QUOTE_MAX_AGE_MS;
    expect(isQuoteFresh(T0, new Date(T0.getTime() + maxAge), maxAge)).toBe(true);
    expect(isQuoteFresh(T0, new Date(T0.getTime() + maxAge + 1), maxAge)).toBe(false);
    expect(isQuoteFresh(T0, new Date(T0.getTime() - 1), maxAge)).toBe(false); // clock went backwards
  });

  it('the shipped threshold is documented-economic: below the ~0.056 USDG cost of the cheapest exit swap', () => {
    expect(THRESHOLD).toBe(20_000n); // 0.02 USDG at 6 decimals
    expect(THRESHOLD).toBeLessThan(56_000n);
  });
});

describe('dust settlement (orchestration)', () => {
  it('21. PONS-like residual (0.008712 USDG) is settled: CLOSED once, dust recorded, no swap built', async () => {
    const ctx = await scenario({ residual: PONS.residual });
    const executor = quoteExecutor(PONS.value);
    const audit = vi.fn();

    const result = await settleResidualDust(deps(ctx, executor, { auditLog: audit }), request(ctx));

    expect(result.outcome).toBe('SETTLED');
    if (result.outcome !== 'SETTLED') throw new Error('unreachable');
    expect(result.residualTokenRaw).toBe(PONS.residual);
    expect(result.quotedUsdgRaw).toBe(PONS.value);
    expect(result.thresholdUsdgRaw).toBe(THRESHOLD);

    // 16. closed exactly once, through the normal lifecycle
    const closed = await ctx.positions.findById(ctx.position.id);
    expect(closed?.status).toBe('CLOSED');
    expect(closed?.closeReason).toBe('DUST_SETTLEMENT');
    // 18. proceeds are the receipts' USDG only -- the dust is NOT added
    expect(closed?.realizedUsdgRaw).toBe(20_915_201n);
    // 17. the abandonment is explicit and separate
    const record = await ctx.positions.findDustSettlementByPositionId(ctx.position.id);
    expect(record).toMatchObject({ residualTokenRaw: PONS.residual, quotedUsdgRaw: PONS.value, thresholdUsdgRaw: THRESHOLD, actor: 'admin', tokenDecimals: 18 });
    // 13/14. nothing on-chain, no fabricated hash
    expect(executor.buildSwapTx).not.toHaveBeenCalled();
    expect(JSON.stringify(record, (_k, v) => (typeof v === 'bigint' ? v.toString() : v))).not.toMatch(/txHash|0x[0-9a-f]{64}/i);
    expect(await ctx.txAttempts.findNonTerminal()).toHaveLength(0);
    // audit event
    expect(audit).toHaveBeenCalledWith('DUST_SETTLEMENT', expect.objectContaining({
      positionId: ctx.position.id, actor: 'admin', action: 'DUST_SETTLEMENT', token: TOKEN,
      residualAmountRaw: PONS.residual.toString(), tokenDecimals: 18, quotedUsdgRaw: PONS.value.toString(),
      thresholdUsdgRaw: THRESHOLD.toString(), requestId: 'req-1',
    }));
  });

  it('22. MEME-like residual (0.000536 USDG) is settled the same way', async () => {
    const ctx = await scenario({ residual: MEME.residual, removeUsdg: 20_910_340n });
    const result = await settleResidualDust(deps(ctx, quoteExecutor(MEME.value)), request(ctx));
    expect(result.outcome).toBe('SETTLED');
    expect((await ctx.positions.findById(ctx.position.id))?.realizedUsdgRaw).toBe(20_910_340n);
  });

  it('4. the quote is taken for EXACTLY the receipt-proven residual', async () => {
    const ctx = await scenario({ residual: PONS.residual });
    const executor = quoteExecutor(PONS.value);
    await settleResidualDust(deps(ctx, executor), request(ctx));
    expect(executor.getQuote).toHaveBeenCalledWith(TOKEN, PONS.residual, config.rules.exits.DUST_SETTLEMENT.QUOTE_SLIPPAGE_BPS);
  });

  it('4b. a quote that answers for a DIFFERENT amount is refused', async () => {
    const ctx = await scenario({ residual: PONS.residual });
    const executor = quoteExecutor(PONS.value, {
      getQuote: vi.fn(async () => ({ amountInRaw: 1n, expectedAmountOutRaw: 1n, minOutputAmountRaw: 0n, priceImpactPct: 0, slippageBps: 100, providerQuote: {} })),
    });
    expect(await settleResidualDust(deps(ctx, executor), request(ctx))).toMatchObject({ outcome: 'REJECTED', reason: 'QUOTE_UNAVAILABLE' });
  });

  it('2/3/23. a residual at or above the threshold is refused and the position stays CLOSING', async () => {
    for (const value of [THRESHOLD, THRESHOLD + 1n, 20_000_000n]) {
      const ctx = await scenario({ residual: PONS.residual });
      const result = await settleResidualDust(deps(ctx, quoteExecutor(value)), request(ctx));
      expect(result).toMatchObject({ outcome: 'REJECTED', reason: 'NOT_DUST' });
      expect((await ctx.positions.findById(ctx.position.id))?.status).toBe('CLOSING');
      expect(await ctx.positions.findDustSettlementByPositionId(ctx.position.id)).toBeNull();
    }
  });

  it('5. a failing quote rejects (a residual is never assumed worthless)', async () => {
    const ctx = await scenario();
    const executor = quoteExecutor(0n, { getQuote: vi.fn(async () => { throw new Error('provider 503'); }) });
    expect(await settleResidualDust(deps(ctx, executor), request(ctx))).toMatchObject({ outcome: 'REJECTED', reason: 'QUOTE_UNAVAILABLE' });
    expect((await ctx.positions.findById(ctx.position.id))?.status).toBe('CLOSING');
  });

  it('6. a quote that takes longer than the freshness window rejects', async () => {
    const ctx = await scenario();
    let call = 0;
    const clock = () => new Date(T0.getTime() + (call++ === 0 ? 0 : config.rules.exits.DUST_SETTLEMENT.QUOTE_MAX_AGE_MS + 1));
    expect(await settleResidualDust(deps(ctx, quoteExecutor(PONS.value), { now: clock }), request(ctx))).toMatchObject({ outcome: 'REJECTED', reason: 'QUOTE_STALE' });
  });

  it('7/8. an ACTIVE or OPENING position can never be dust-settled', async () => {
    for (const status of ['ACTIVE', 'OPENING'] as const) {
      const ctx = await scenario({ status });
      const result = await settleResidualDust(deps(ctx, quoteExecutor(PONS.value)), request(ctx, { closeIdempotencyKey: 'exit:whatever' }));
      expect(result).toMatchObject({ outcome: 'REJECTED', reason: 'POSITION_NOT_CLOSING' });
      expect((await ctx.positions.findById(ctx.position.id))?.status).toBe(status);
    }
  });

  it('9. an in-flight exit transaction blocks settlement', async () => {
    for (const inFlight of ['SIGNED', 'SENT', 'CONFIRMED'] as const) {
      const ctx = await scenario();
      const swap = await ctx.txAttempts.create(`${ctx.position.closeIdempotencyKey}:swap:0`, 'exit:swap');
      await ctx.txAttempts.update(swap.id, { status: inFlight });
      expect(await settleResidualDust(deps(ctx, quoteExecutor(PONS.value)), request(ctx))).toMatchObject({ outcome: 'REJECTED', reason: 'EXIT_TX_IN_FLIGHT' });
    }
  });

  it('a VERIFIED swap means the normal exit owns this position', async () => {
    const ctx = await scenario();
    const swap = await ctx.txAttempts.create(`${ctx.position.closeIdempotencyKey}:swap:0`, 'exit:swap');
    await ctx.txAttempts.update(swap.id, { status: 'VERIFIED', verifyData: { usdgProceedsRaw: '5' } });
    expect(await settleResidualDust(deps(ctx, quoteExecutor(PONS.value)), request(ctx))).toMatchObject({ outcome: 'REJECTED', reason: 'SWAP_ALREADY_VERIFIED' });
  });

  it('10/19. a repeated request is idempotent: ALREADY_SETTLED, one close, one record', async () => {
    const ctx = await scenario();
    const executor = quoteExecutor(PONS.value);
    const first = await settleResidualDust(deps(ctx, executor), request(ctx));
    const second = await settleResidualDust(deps(ctx, executor), request(ctx));
    expect(first.outcome).toBe('SETTLED');
    expect(second.outcome).toBe('ALREADY_SETTLED');
    expect(ctx.positions.dustSettlements.size).toBe(1);
    expect((await ctx.positions.findById(ctx.position.id))?.closedAt).toEqual(T0);
    expect(executor.getQuote).toHaveBeenCalledTimes(1); // the repeat does not even re-quote
  });

  it('11. a lifecycle (closeIdempotencyKey) mismatch rejects', async () => {
    const ctx = await scenario();
    const result = await settleResidualDust(deps(ctx, quoteExecutor(PONS.value)), request(ctx, { closeIdempotencyKey: 'exit:someone-elses-lifecycle' }));
    expect(result).toMatchObject({ outcome: 'REJECTED', reason: 'STALE_CLOSE_LIFECYCLE' });
    expect((await ctx.positions.findById(ctx.position.id))?.status).toBe('CLOSING');
  });

  it('12. an explicit confirmation is required', async () => {
    const ctx = await scenario();
    for (const confirm of ['', 'yes', 'abandon_dust']) {
      expect(await settleResidualDust(deps(ctx, quoteExecutor(PONS.value)), request(ctx, { confirm }))).toMatchObject({ outcome: 'REJECTED', reason: 'NOT_CONFIRMED' });
    }
  });

  it('a residual that is no longer intact in the wallet is refused (that is receipt settlement\'s job)', async () => {
    const ctx = await scenario({ residual: PONS.residual });
    const low = deps(ctx, quoteExecutor(PONS.value), { readTokenBalance: vi.fn(async () => PONS.residual - 1n) });
    expect(await settleResidualDust(low, request(ctx))).toMatchObject({ outcome: 'REJECTED', reason: 'BALANCE_BELOW_RESIDUAL' });

    const unreadable = deps(ctx, quoteExecutor(PONS.value), { readTokenBalance: vi.fn(async () => { throw new Error('rpc down'); }) });
    expect(await settleResidualDust(unreadable, request(ctx))).toMatchObject({ outcome: 'REJECTED', reason: 'BALANCE_UNVERIFIABLE' });
  });

  it('a position with no proven TOKEN residual is refused', async () => {
    const ctx = await scenario({ residual: 0n });
    expect(await settleResidualDust(deps(ctx, quoteExecutor(1n)), request(ctx))).toMatchObject({ outcome: 'REJECTED', reason: 'NO_TOKEN_RESIDUAL' });
  });

  it('an unverified remove-liquidity leg is refused', async () => {
    const ctx = await scenario();
    const attempts = await ctx.txAttempts.find(`${ctx.position.closeIdempotencyKey}:removeLiquidity`);
    await ctx.txAttempts.update(attempts!.id, { status: 'FAILED' }, attempts!.version);
    expect(await settleResidualDust(deps(ctx, quoteExecutor(PONS.value)), request(ctx))).toMatchObject({ outcome: 'REJECTED', reason: 'REMOVE_NOT_VERIFIED' });
  });

  it('20. the decision is VALUE-based: identical raw amounts with different decimals/prices decide differently', async () => {
    // same raw residual, two different quoted values -> opposite decisions
    const dusty = await scenario({ residual: 1_000_000_000_000n });
    expect((await settleResidualDust(deps(dusty, quoteExecutor(THRESHOLD - 1n)), request(dusty))).outcome).toBe('SETTLED');

    const valuable = await scenario({ residual: 1_000_000_000_000n });
    expect(await settleResidualDust(deps(valuable, quoteExecutor(THRESHOLD)), request(valuable))).toMatchObject({ outcome: 'REJECTED', reason: 'NOT_DUST' });
  });

  it('18/19. a lifecycle that changes between the check and the close aborts: nothing is written', async () => {
    const ctx = await scenario({ residual: PONS.residual });
    const executor = quoteExecutor(PONS.value, {
      // the close lifecycle moves on while the valuation quote is in flight
      getQuote: vi.fn(async (_t: Address, amountInRaw: bigint) => {
        const live = await ctx.positions.findById(ctx.position.id);
        if (live) live.closeIdempotencyKey = 'exit:a-newer-lifecycle';
        return { amountInRaw, expectedAmountOutRaw: PONS.value, minOutputAmountRaw: 0n, priceImpactPct: 0.001, slippageBps: 100, providerQuote: {} };
      }),
    });

    const result = await settleResidualDust(deps(ctx, executor), request(ctx));

    expect(result).toMatchObject({ outcome: 'REJECTED', reason: 'CLOSE_LOST_RACE' });
    expect((await ctx.positions.findById(ctx.position.id))?.status).toBe('CLOSING');
    expect(await ctx.positions.findDustSettlementByPositionId(ctx.position.id)).toBeNull();
  });

  it('15/13. releases accounting capital exactly once and produces no transaction attempt', async () => {
    const ctx = await scenario();
    const deployedBefore = await ctx.positions.findAllClosing();
    await settleResidualDust(deps(ctx, quoteExecutor(PONS.value)), request(ctx));
    const deployedAfter = await ctx.positions.findAllClosing();
    expect(deployedBefore).toHaveLength(1); // CLOSING -> still counted as deployed capital
    expect(deployedAfter).toHaveLength(0); // released by the close, exactly once
    expect((await ctx.positions.findAllActive())).toHaveLength(0);
    expect(await ctx.txAttempts.findNonTerminal()).toHaveLength(0);
  });
});
