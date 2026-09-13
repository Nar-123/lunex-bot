import { describe, expect, it, vi } from 'vitest';
import type { Address } from 'viem';
import { buildSwapDeps, shouldBlockForPriceImpact } from '../../src/exits/swapTx';
import { InMemoryExitStateRepository } from './inMemoryExitStateRepository';
import type { SwapExecutor, SwapQuote } from '../../src/swap/types';

const TOKEN = '0x0000000000000000000000000000000000000002' as Address;
const WALLET = '0x9999999999999999999999999999999999999999' as Address;
const USDG = (n: number): bigint => BigInt(n) * 10n ** 18n;
const SWAP_TX = { to: '0x1111111111111111111111111111111111111111' as Address, data: '0xabcdef' as `0x${string}`, value: 0n };

function makeQuote(overrides: Partial<SwapQuote> = {}): SwapQuote {
  return { amountInRaw: USDG(0), expectedAmountOutRaw: USDG(100), minOutputAmountRaw: 0n, priceImpactPct: 0.001, slippageBps: 100, providerQuote: { fake: true }, ...overrides };
}

describe('shouldBlockForPriceImpact -- OFF by default per spec, both states directly testable', () => {
  it('never blocks when disabled, regardless of how large the impact is', () => {
    expect(shouldBlockForPriceImpact(0.5, false, 0.01)).toBe(false);
  });

  it('blocks when enabled and impact exceeds the max', () => {
    expect(shouldBlockForPriceImpact(0.02, true, 0.01)).toBe(true);
  });

  it('does not block when enabled but impact is within the max', () => {
    expect(shouldBlockForPriceImpact(0.005, true, 0.01)).toBe(false);
  });

  it('does not block exactly at the max (strictly greater-than, not >=)', () => {
    expect(shouldBlockForPriceImpact(0.01, true, 0.01)).toBe(false);
  });
});

describe('buildSwapDeps -- takes an already-fetched quote, builds calldata for it, persists the verification baseline', () => {
  it('builds calldata from the given quote via swapExecutor.buildSwapTx, without calling getQuote itself', async () => {
    const exitStates = new InMemoryExitStateRepository();
    const quote = makeQuote();
    const swapExecutor: SwapExecutor = {
      getQuote: vi.fn(),
      checkApproval: vi.fn(async () => ({ needsApproval: false, spender: null })),
      buildSwapTx: vi.fn(async () => SWAP_TX),
    };

    const deps = buildSwapDeps('pos-1', TOKEN, quote, swapExecutor, exitStates, {
      readBalance: vi.fn(async () => USDG(100)),
      walletAddress: WALLET,
    });

    const tx = await deps.buildTransaction();

    expect(swapExecutor.getQuote).not.toHaveBeenCalled();
    expect(swapExecutor.buildSwapTx).toHaveBeenCalledWith(TOKEN, quote);
    expect(tx).toEqual(SWAP_TX);
  });

  it('persists the USDG balance baseline and the quote\'s minOutputAmountRaw before returning calldata', async () => {
    const exitStates = new InMemoryExitStateRepository();
    const quote = makeQuote({ minOutputAmountRaw: USDG(42) });
    const swapExecutor: SwapExecutor = { getQuote: vi.fn(), checkApproval: vi.fn(async () => ({ needsApproval: false, spender: null })), buildSwapTx: vi.fn(async () => SWAP_TX) };

    const deps = buildSwapDeps('pos-1', TOKEN, quote, swapExecutor, exitStates, {
      readBalance: vi.fn(async () => USDG(1000)),
      walletAddress: WALLET,
    });
    await deps.buildTransaction();

    const exitState = await exitStates.getOrCreate('pos-1');
    expect(exitState.swapUsdgBalanceBeforeRaw).toBe(USDG(1000));
    expect(exitState.swapMinOutputAmountRaw).toBe(USDG(42));
  });
});

describe('buildSwapDeps -- verifyOnChain requires a genuine USDG increase', () => {
  it('fails verification when the balance did not increase at all, even with no minimum configured (protection OFF)', async () => {
    const exitStates = new InMemoryExitStateRepository();
    await exitStates.update('pos-1', { swapUsdgBalanceBeforeRaw: USDG(1000), swapMinOutputAmountRaw: 0n });
    const swapExecutor: SwapExecutor = { getQuote: vi.fn(), checkApproval: vi.fn(async () => ({ needsApproval: false, spender: null })), buildSwapTx: vi.fn() };

    const deps = buildSwapDeps('pos-1', TOKEN, makeQuote(), swapExecutor, exitStates, {
      readBalance: vi.fn(async () => USDG(1000)), // unchanged -- swap had zero effect
      walletAddress: WALLET,
    });

    const result = await deps.verifyOnChain('0xaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa' as `0x${string}`);
    expect(result.ok).toBe(false);
  });

  it('passes verification once the balance genuinely increased (protection OFF, no minimum enforced beyond "> 0")', async () => {
    const exitStates = new InMemoryExitStateRepository();
    await exitStates.update('pos-1', { swapUsdgBalanceBeforeRaw: USDG(1000), swapMinOutputAmountRaw: 0n });
    const swapExecutor: SwapExecutor = { getQuote: vi.fn(), checkApproval: vi.fn(async () => ({ needsApproval: false, spender: null })), buildSwapTx: vi.fn() };

    const deps = buildSwapDeps('pos-1', TOKEN, makeQuote(), swapExecutor, exitStates, {
      readBalance: vi.fn(async () => USDG(1050)),
      readUsdgTransfersTo: vi.fn(async () => USDG(50)), // the swap's own receipt paid out exactly the increase
      walletAddress: WALLET,
    });

    const result = await deps.verifyOnChain('0xaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa' as `0x${string}`);
    expect(result).toEqual({ ok: true, data: { usdgIncreaseRaw: USDG(50), usdgProceedsRaw: USDG(50) } });
  });

  it('fails verification when the increase is genuinely positive but below a configured minimum (protection ON)', async () => {
    const exitStates = new InMemoryExitStateRepository();
    await exitStates.update('pos-1', { swapUsdgBalanceBeforeRaw: USDG(1000), swapMinOutputAmountRaw: USDG(100) });
    const swapExecutor: SwapExecutor = { getQuote: vi.fn(), checkApproval: vi.fn(async () => ({ needsApproval: false, spender: null })), buildSwapTx: vi.fn() };

    const deps = buildSwapDeps('pos-1', TOKEN, makeQuote(), swapExecutor, exitStates, {
      readBalance: vi.fn(async () => USDG(1050)), // increased by 50, but the minimum required is 100
      walletAddress: WALLET,
    });

    const result = await deps.verifyOnChain('0xaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa' as `0x${string}`);
    expect(result.ok).toBe(false);
  });

  it('fails loudly (does not silently pass) when no baseline was ever recorded -- an invariant violation, not a valid state', async () => {
    const exitStates = new InMemoryExitStateRepository();
    const swapExecutor: SwapExecutor = { getQuote: vi.fn(), checkApproval: vi.fn(async () => ({ needsApproval: false, spender: null })), buildSwapTx: vi.fn() };
    const deps = buildSwapDeps('pos-1', TOKEN, makeQuote(), swapExecutor, exitStates, { readBalance: vi.fn(async () => USDG(1000)), walletAddress: WALLET });

    const result = await deps.verifyOnChain('0xaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa' as `0x${string}`);
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.reason).toMatch(/swapUsdgBalanceBeforeRaw/);
  });
});

describe('buildSwapDeps -- P1: a failed proceeds read after the balance check passed is resumable, never definitive', () => {
  const HASH = '0xaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa' as `0x${string}`;
  const noopExecutor = (): SwapExecutor => ({ getQuote: vi.fn(), checkApproval: vi.fn(async () => ({ needsApproval: false, spender: null })), buildSwapTx: vi.fn(async () => SWAP_TX) });

  it('returns resumable:true and persists the accepted USDG increase', async () => {
    const exitStates = new InMemoryExitStateRepository();
    await exitStates.update('pos-1', { swapUsdgBalanceBeforeRaw: USDG(1000), swapMinOutputAmountRaw: 0n });
    const deps = buildSwapDeps('pos-1', TOKEN, makeQuote(), noopExecutor(), exitStates, {
      readBalance: vi.fn(async () => USDG(1050)),
      readUsdgTransfersTo: vi.fn(async () => { throw new Error('RPC timeout'); }),
      walletAddress: WALLET,
    });

    const result = await deps.verifyOnChain(HASH);

    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.resumable).toBe(true);
      expect(result.reason).toMatch(/proceeds could not be measured/);
    }
    expect((await exitStates.getOrCreate('pos-1')).swapVerifiedUsdgIncreaseRaw).toBe(USDG(50));
  });

  it('a resumed verify reuses the persisted increase and never re-reads the live balance -- a concurrent USDG outflow cannot falsely fail an already-filled swap', async () => {
    const exitStates = new InMemoryExitStateRepository();
    await exitStates.update('pos-1', { swapUsdgBalanceBeforeRaw: USDG(1000), swapMinOutputAmountRaw: 0n, swapVerifiedUsdgIncreaseRaw: USDG(50) });
    const readBalance = vi.fn(async () => USDG(600)); // a mint spent 450 USDG between ticks
    const deps = buildSwapDeps('pos-1', TOKEN, null, noopExecutor(), exitStates, {
      readBalance,
      readUsdgTransfersTo: vi.fn(async () => USDG(50)),
      walletAddress: WALLET,
    });

    const result = await deps.verifyOnChain(HASH);

    expect(result).toEqual({ ok: true, data: { usdgIncreaseRaw: USDG(50), usdgProceedsRaw: USDG(50) } });
    expect(readBalance).not.toHaveBeenCalled();
  });

  it('a failed BALANCE check stays definitive (no resumable flag) and persists nothing', async () => {
    const exitStates = new InMemoryExitStateRepository();
    await exitStates.update('pos-1', { swapUsdgBalanceBeforeRaw: USDG(1000), swapMinOutputAmountRaw: 0n });
    const readUsdgTransfersTo = vi.fn(async () => USDG(0));
    const deps = buildSwapDeps('pos-1', TOKEN, makeQuote(), noopExecutor(), exitStates, {
      readBalance: vi.fn(async () => USDG(1000)),
      readUsdgTransfersTo,
      walletAddress: WALLET,
    });

    const result = await deps.verifyOnChain(HASH);

    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.resumable).toBeUndefined();
    expect(readUsdgTransfersTo).not.toHaveBeenCalled();
    expect((await exitStates.getOrCreate('pos-1')).swapVerifiedUsdgIncreaseRaw).toBeNull();
  });

  it('buildTransaction resets swapVerifiedUsdgIncreaseRaw for every new attempt', async () => {
    const exitStates = new InMemoryExitStateRepository();
    await exitStates.update('pos-1', { swapVerifiedUsdgIncreaseRaw: USDG(77) }); // left over from an earlier attempt
    const deps = buildSwapDeps('pos-1', TOKEN, makeQuote(), noopExecutor(), exitStates, { readBalance: vi.fn(async () => USDG(1000)), walletAddress: WALLET });

    await deps.buildTransaction();

    expect((await exitStates.getOrCreate('pos-1')).swapVerifiedUsdgIncreaseRaw).toBeNull();
  });

  it('resume-only deps (quote null) refuse to build calldata and never call buildSwapTx or read a balance', async () => {
    const exitStates = new InMemoryExitStateRepository();
    const executor = noopExecutor();
    const readBalance = vi.fn(async () => USDG(1000));
    const deps = buildSwapDeps('pos-1', TOKEN, null, executor, exitStates, { readBalance, walletAddress: WALLET });

    await expect(deps.buildTransaction()).rejects.toThrow(/resume-only/);
    expect(executor.buildSwapTx).not.toHaveBeenCalled();
    expect(readBalance).not.toHaveBeenCalled();
  });
});

describe('buildSwapDeps -- restart-safety of the verification baseline', () => {
  it('the baseline set during buildTransaction is what a LATER, independent verifyOnChain call reads back -- not a value re-read fresh at verify time', async () => {
    const exitStates = new InMemoryExitStateRepository();
    const swapExecutor: SwapExecutor = { getQuote: vi.fn(), checkApproval: vi.fn(async () => ({ needsApproval: false, spender: null })), buildSwapTx: vi.fn(async () => SWAP_TX) };

    // "Before restart": buildTransaction runs once, captures balance=1000 as the baseline.
    const beforeRestartDeps = buildSwapDeps('pos-1', TOKEN, makeQuote(), swapExecutor, exitStates, {
      readBalance: vi.fn(async () => USDG(1000)),
      walletAddress: WALLET,
    });
    await beforeRestartDeps.buildTransaction();

    // "After restart": a completely SEPARATE buildSwapDeps call (simulating
    // a new process), whose readBalance now returns a DIFFERENT ("current")
    // value -- verifyOnChain must use the PERSISTED baseline (1000), not
    // whatever readBalance happens to return generically.
    const afterRestartDeps = buildSwapDeps('pos-1', TOKEN, makeQuote(), swapExecutor, exitStates, {
      readBalance: vi.fn(async () => USDG(1075)), // current balance, post-swap
      readUsdgTransfersTo: vi.fn(async () => USDG(75)), // receipt decoder, independently injectable (a restarted process re-reads the same receipt)
      walletAddress: WALLET,
    });
    const result = await afterRestartDeps.verifyOnChain('0xaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa' as `0x${string}`);

    expect(result).toEqual({ ok: true, data: { usdgIncreaseRaw: USDG(75), usdgProceedsRaw: USDG(75) } }); // 1075 - 1000 (the ORIGINAL baseline), not recomputed from scratch
  });
});
