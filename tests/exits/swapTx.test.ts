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
    // The calldata is exactly the builder's; the quote snapshot rides along (never sent on-chain).
    expect({ to: tx.to, data: tx.data, value: tx.value }).toEqual(SWAP_TX);
    expect(tx.buildContext).toMatchObject({ kind: 'exit-swap/v1', positionId: 'pos-1' });
  });

  it('same-attempt race fix: returns the USDG baseline and the quote-derived values WITH the calldata (persisted atomically at BUILT) and writes NOTHING to shared ExitState', async () => {
    const exitStates = new InMemoryExitStateRepository();
    const quote = makeQuote({ minOutputAmountRaw: USDG(42) });
    const swapExecutor: SwapExecutor = { getQuote: vi.fn(), checkApproval: vi.fn(async () => ({ needsApproval: false, spender: null })), buildSwapTx: vi.fn(async () => SWAP_TX) };

    const deps = buildSwapDeps('pos-1', TOKEN, quote, swapExecutor, exitStates, {
      readBalance: vi.fn(async () => USDG(1000)),
      walletAddress: WALLET,
    });
    const versionBefore = (await exitStates.getOrCreate('pos-1')).version;
    const tx = await deps.buildTransaction();

    expect(tx.buildContext).toEqual({
      kind: 'exit-swap/v1',
      positionId: 'pos-1',
      swapAttemptCount: 0,
      amountInRaw: quote.amountInRaw,
      expectedAmountOutRaw: quote.expectedAmountOutRaw,
      minOutputAmountRaw: USDG(42),
      priceImpactPct: quote.priceImpactPct,
      slippageBps: quote.slippageBps,
      usdgBalanceBeforeRaw: USDG(1000),
    });
    const exitState = await exitStates.getOrCreate('pos-1');
    expect(exitState.version).toBe(versionBefore); // no shared write at all
    expect(exitState.swapUsdgBalanceBeforeRaw).toBeNull();
    expect(exitState.swapMinOutputAmountRaw).toBeNull();
  });
});

describe('buildSwapDeps -- P0-5: verifyOnChain requires genuine RECEIPT-SCOPED USDG proceeds (primary proof), never a wallet balance delta alone', () => {
  const HASH = '0xaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa' as `0x${string}`;

  it('fails verification when the swap\'s OWN receipt shows zero USDG paid, even with no minimum configured (protection OFF)', async () => {
    const exitStates = new InMemoryExitStateRepository();
    await exitStates.update('pos-1', { swapUsdgBalanceBeforeRaw: USDG(1000), swapMinOutputAmountRaw: 0n });
    const swapExecutor: SwapExecutor = { getQuote: vi.fn(), checkApproval: vi.fn(async () => ({ needsApproval: false, spender: null })), buildSwapTx: vi.fn() };

    const deps = buildSwapDeps('pos-1', TOKEN, makeQuote(), swapExecutor, exitStates, {
      readBalance: vi.fn(async () => USDG(1000)),
      readUsdgTransfersTo: vi.fn(async () => USDG(0)), // the swap's own confirmed receipt paid nothing
      walletAddress: WALLET,
    });

    const result = await deps.verifyOnChain(HASH);
    expect(result.ok).toBe(false);
  });

  it('acceptance #2: swap output = 0, PLUS an unrelated wallet balance increase -> NOT VERIFIED (the exact false-positive P0-5 fixes)', async () => {
    const exitStates = new InMemoryExitStateRepository();
    await exitStates.update('pos-1', { swapUsdgBalanceBeforeRaw: USDG(1000), swapMinOutputAmountRaw: 0n });
    const swapExecutor: SwapExecutor = { getQuote: vi.fn(), checkApproval: vi.fn(async () => ({ needsApproval: false, spender: null })), buildSwapTx: vi.fn() };

    const deps = buildSwapDeps('pos-1', TOKEN, makeQuote(), swapExecutor, exitStates, {
      // The wallet balance DID increase by 500 -- but from an UNRELATED
      // incoming transfer (a deposit, another position's exit, anything
      // outside THIS swap's own transaction), not from this swap, which
      // genuinely paid 0. Under the OLD balance-delta-as-primary-proof
      // logic, this would have been falsely accepted as VERIFIED.
      readBalance: vi.fn(async () => USDG(1500)),
      readUsdgTransfersTo: vi.fn(async () => USDG(0)), // THIS swap's own receipt: paid nothing
      walletAddress: WALLET,
    });

    const result = await deps.verifyOnChain(HASH);
    expect(result.ok).toBe(false); // NOT VERIFIED, despite the wallet balance genuinely being higher
  });

  it('acceptance #1: passes verification when the swap\'s own receipt shows genuine proceeds (protection OFF, minimum is "> 0")', async () => {
    const exitStates = new InMemoryExitStateRepository();
    await exitStates.update('pos-1', { swapUsdgBalanceBeforeRaw: USDG(1000), swapMinOutputAmountRaw: 0n });
    const swapExecutor: SwapExecutor = { getQuote: vi.fn(), checkApproval: vi.fn(async () => ({ needsApproval: false, spender: null })), buildSwapTx: vi.fn() };

    const deps = buildSwapDeps('pos-1', TOKEN, makeQuote(), swapExecutor, exitStates, {
      readBalance: vi.fn(async () => USDG(1050)),
      readUsdgTransfersTo: vi.fn(async () => USDG(50)), // the swap's own receipt paid out exactly this
      walletAddress: WALLET,
    });

    const result = await deps.verifyOnChain(HASH);
    expect(result).toEqual({ ok: true, data: { usdgIncreaseRaw: USDG(50), usdgProceedsRaw: USDG(50) } });
  });

  it('acceptance #5: receipt-scoped proceeds EXACTLY at the configured minimum -> VERIFIED (inclusive boundary)', async () => {
    const exitStates = new InMemoryExitStateRepository();
    await exitStates.update('pos-1', { swapUsdgBalanceBeforeRaw: USDG(1000), swapMinOutputAmountRaw: USDG(100) });
    const deps = buildSwapDeps('pos-1', TOKEN, makeQuote(), { getQuote: vi.fn(), checkApproval: vi.fn(async () => ({ needsApproval: false, spender: null })), buildSwapTx: vi.fn() }, exitStates, {
      readBalance: vi.fn(async () => USDG(1100)),
      readUsdgTransfersTo: vi.fn(async () => USDG(100)), // exactly the minimum
      walletAddress: WALLET,
    });

    const result = await deps.verifyOnChain(HASH);
    expect(result.ok).toBe(true);
  });

  it('acceptance #7 (partial output): receipt-scoped proceeds genuinely positive but below a configured minimum (protection ON) -> NOT VERIFIED', async () => {
    const exitStates = new InMemoryExitStateRepository();
    await exitStates.update('pos-1', { swapUsdgBalanceBeforeRaw: USDG(1000), swapMinOutputAmountRaw: USDG(100) });
    const swapExecutor: SwapExecutor = { getQuote: vi.fn(), checkApproval: vi.fn(async () => ({ needsApproval: false, spender: null })), buildSwapTx: vi.fn() };

    const deps = buildSwapDeps('pos-1', TOKEN, makeQuote(), swapExecutor, exitStates, {
      readBalance: vi.fn(async () => USDG(1050)),
      readUsdgTransfersTo: vi.fn(async () => USDG(50)), // the swap's own receipt: 50, but the minimum required is 100
      walletAddress: WALLET,
    });

    const result = await deps.verifyOnChain(HASH);
    expect(result.ok).toBe(false);
  });

  it('receipt-scoped proceeds ALONE are sufficient even when no balance baseline was ever recorded -- the primary proof no longer depends on it', async () => {
    const exitStates = new InMemoryExitStateRepository(); // no swapUsdgBalanceBeforeRaw seeded at all
    const swapExecutor: SwapExecutor = { getQuote: vi.fn(), checkApproval: vi.fn(async () => ({ needsApproval: false, spender: null })), buildSwapTx: vi.fn() };
    const readBalance = vi.fn(async () => USDG(1000));
    const deps = buildSwapDeps('pos-1', TOKEN, makeQuote(), swapExecutor, exitStates, {
      readBalance,
      readUsdgTransfersTo: vi.fn(async () => USDG(75)),
      walletAddress: WALLET,
    });

    const result = await deps.verifyOnChain(HASH);
    expect(result).toEqual({ ok: true, data: { usdgIncreaseRaw: USDG(0), usdgProceedsRaw: USDG(75) } });
    expect(readBalance).not.toHaveBeenCalled(); // no baseline to compare against -- defense-in-depth check is skipped, never blocks
  });

  it('acceptance #6 regression: multiple Transfer events inside the SAME confirmed receipt sum together (documented limitation, not a false negative)', async () => {
    // readUsdgTransfersTo already sums every Transfer(...->wallet) event
    // inside ONE confirmed tx (blockchain/erc20.ts) -- this proves that
    // behavior is what buildSwapDeps actually consumes as its proceeds
    // figure, and that it is still scoped to the ONE tx hash (never a
    // wallet-wide window).
    const exitStates = new InMemoryExitStateRepository();
    const readUsdgTransfersTo = vi.fn(async () => USDG(30) + USDG(20)); // two legs of the same swap tx, already summed by the receipt decoder
    const deps = buildSwapDeps('pos-1', TOKEN, makeQuote(), { getQuote: vi.fn(), checkApproval: vi.fn(async () => ({ needsApproval: false, spender: null })), buildSwapTx: vi.fn() }, exitStates, {
      readBalance: vi.fn(async () => USDG(1050)),
      readUsdgTransfersTo,
      walletAddress: WALLET,
    });

    const result = await deps.verifyOnChain(HASH);
    expect(result.ok).toBe(true);
    expect(readUsdgTransfersTo).toHaveBeenCalledWith(HASH, expect.any(String), WALLET); // exact tx hash, exact expected token, exact expected recipient
  });
});

describe('buildSwapDeps -- P1: a failed proceeds read after the balance check passed is resumable, never definitive', () => {
  const HASH = '0xaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa' as `0x${string}`;
  const noopExecutor = (): SwapExecutor => ({ getQuote: vi.fn(), checkApproval: vi.fn(async () => ({ needsApproval: false, spender: null })), buildSwapTx: vi.fn(async () => SWAP_TX) });

  it('P0-5: a failed RECEIPT read is resumable immediately -- the balance-delta defense-in-depth is never even reached (receipt is now the primary, first-checked proof)', async () => {
    const exitStates = new InMemoryExitStateRepository();
    await exitStates.update('pos-1', { swapUsdgBalanceBeforeRaw: USDG(1000), swapMinOutputAmountRaw: 0n });
    const readBalance = vi.fn(async () => USDG(1050));
    const deps = buildSwapDeps('pos-1', TOKEN, makeQuote(), noopExecutor(), exitStates, {
      readBalance,
      readUsdgTransfersTo: vi.fn(async () => { throw new Error('RPC timeout'); }),
      walletAddress: WALLET,
    });

    const result = await deps.verifyOnChain(HASH);

    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.resumable).toBe(true);
      expect(result.reason).toMatch(/could not read the swap's own confirmed receipt/);
    }
    expect(readBalance).not.toHaveBeenCalled(); // never reached -- the primary (receipt) check failed first
    expect((await exitStates.getOrCreate('pos-1')).swapVerifiedUsdgIncreaseRaw).toBeNull();
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

  it('P0-5: a failed RECEIPT check (zero proceeds) stays definitive (no resumable flag), and the balance-delta defense-in-depth is never even reached', async () => {
    const exitStates = new InMemoryExitStateRepository();
    await exitStates.update('pos-1', { swapUsdgBalanceBeforeRaw: USDG(1000), swapMinOutputAmountRaw: 0n });
    const readUsdgTransfersTo = vi.fn(async () => USDG(0));
    const readBalance = vi.fn(async () => USDG(1000));
    const deps = buildSwapDeps('pos-1', TOKEN, makeQuote(), noopExecutor(), exitStates, {
      readBalance,
      readUsdgTransfersTo,
      walletAddress: WALLET,
    });

    const result = await deps.verifyOnChain(HASH);

    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.resumable).toBeUndefined();
    expect(readUsdgTransfersTo).toHaveBeenCalled(); // now the FIRST, primary check
    expect(readBalance).not.toHaveBeenCalled(); // defense-in-depth check never reached -- the primary check already failed definitively
    expect((await exitStates.getOrCreate('pos-1')).swapVerifiedUsdgIncreaseRaw).toBeNull();
  });

  it('a snapshot-built attempt never picks up a shared swapVerifiedUsdgIncreaseRaw left over from an earlier attempt -- its balance delta comes from its OWN baseline', async () => {
    const exitStates = new InMemoryExitStateRepository();
    await exitStates.update('pos-1', { swapVerifiedUsdgIncreaseRaw: USDG(77) }); // left over from an earlier attempt
    const deps = buildSwapDeps('pos-1', TOKEN, makeQuote(), noopExecutor(), exitStates, {
      readBalance: vi.fn().mockResolvedValueOnce(USDG(1000)).mockResolvedValue(USDG(1030)),
      readUsdgTransfersTo: vi.fn(async () => USDG(30)),
      walletAddress: WALLET,
    });
    const tx = await deps.buildTransaction();
    const result = await deps.verifyOnChain(HASH, { id: 'a1', txRequest: tx });
    expect(result).toEqual({ ok: true, data: { usdgIncreaseRaw: USDG(30), usdgProceedsRaw: USDG(30) } });
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
    const builtTx = await beforeRestartDeps.buildTransaction();

    // "After restart": a completely SEPARATE buildSwapDeps call (simulating
    // a new process), whose readBalance now returns a DIFFERENT ("current")
    // value -- verifyOnChain must use the PERSISTED baseline (1000), not
    // whatever readBalance happens to return generically.
    const afterRestartDeps = buildSwapDeps('pos-1', TOKEN, makeQuote(), swapExecutor, exitStates, {
      readBalance: vi.fn(async () => USDG(1075)), // current balance, post-swap
      readUsdgTransfersTo: vi.fn(async () => USDG(75)), // receipt decoder, independently injectable (a restarted process re-reads the same receipt)
      walletAddress: WALLET,
    });
    // The attempt row's real JSON round-trip (TransactionAttemptRepository's bigint tagging).
    const persistedTx = JSON.parse(
      JSON.stringify(builtTx, (_k, v: unknown) => (typeof v === 'bigint' ? `bigint:${v.toString()}` : v)),
      (_k, v: unknown) => (typeof v === 'string' && v.startsWith('bigint:') ? BigInt(v.slice(7)) : v),
    );
    const result = await afterRestartDeps.verifyOnChain('0xaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa' as `0x${string}`, { id: 'a1', txRequest: persistedTx });

    expect(result).toEqual({ ok: true, data: { usdgIncreaseRaw: USDG(75), usdgProceedsRaw: USDG(75) } }); // 1075 - 1000 (the ORIGINAL baseline), not recomputed from scratch
  });
});
