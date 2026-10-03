import { describe, expect, it } from 'vitest';
import { Token } from '@uniswap/sdk-core';
import { estimateExitPriceImpact } from '../../src/pools/priceImpact';
import type { V4PoolKey, V4PoolStateSnapshot } from '../../src/pools/types';

const CHAIN_ID = 4663;
const USDG = new Token(CHAIN_ID, '0x1111111111111111111111111111111111111111', 18, 'USDG', 'USDG');
const TOKEN = new Token(CHAIN_ID, '0xffffffffffffffffffffffffffffffffffffffff', 18, 'TOKEN', 'Test Token');

// tick 0 -> sqrtPriceX96 = 2^96 -> a clean 1:1 mid price between currency0/currency1.
const SQRT_PRICE_X96_AT_TICK_0 = (2n ** 96n).toString();

const TICK_SPACING = 60;
const FULL_RANGE_LOWER = -887220; // nearest multiple of 60 within [MIN_TICK, MAX_TICK]
const FULL_RANGE_UPPER = 887220;

const key: V4PoolKey = {
  currency0: '0x1111111111111111111111111111111111111111',
  currency1: '0xffffffffffffffffffffffffffffffffffffffff',
  fee: 3000,
  tickSpacing: TICK_SPACING,
  hooks: '0x0000000000000000000000000000000000000000',
};

function stateWithLiquidity(liquidity: bigint): V4PoolStateSnapshot {
  return {
    sqrtPriceX96: BigInt(SQRT_PRICE_X96_AT_TICK_0),
    liquidity,
    tickCurrent: 0,
    ticks: [
      { index: FULL_RANGE_LOWER, liquidityNet: liquidity, liquidityGross: liquidity },
      { index: FULL_RANGE_UPPER, liquidityNet: -liquidity, liquidityGross: liquidity },
    ],
    // Full-range scan: these fixtures model a pool whose entire tick range
    // was read, so the completeness check never fires and each case keeps
    // exercising exactly what it was written for.
    tickWindow: { lowerTick: -887272, upperTick: 887272 },
  };
}

// A full-range scan knows the WHOLE tick space, so the window is the SDK's
// absolute tick bounds -- not the nearest tickSpacing multiple. A swap that
// exhausts a pool legitimately walks to MIN_TICK/MAX_TICK, and that is a
// genuine "this pool is too shallow" result computed entirely on data we
// have, not an unproven extrapolation.
const MIN_TICK = -887272;
const MAX_TICK = 887272;
const FULL_WINDOW = { lowerTick: MIN_TICK, upperTick: MAX_TICK };

const POSITION_SIZE_USDG_RAW = 1_000n * 10n ** 18n; // 1000 USDG, 18 decimals

describe('estimateExitPriceImpact', () => {
  it('reports low impact (passes) for deep liquidity relative to position size', async () => {
    const result = await estimateExitPriceImpact(
      key,
      stateWithLiquidity(10n ** 30n),
      TOKEN,
      USDG,
      POSITION_SIZE_USDG_RAW,
    );
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.priceImpactPct).toBeLessThan(0.01);
      expect(result.passesThreshold).toBe(true);
    }
  });

  it('reports high impact (fails) for shallow liquidity relative to position size', async () => {
    const result = await estimateExitPriceImpact(
      key,
      stateWithLiquidity(10n ** 21n),
      TOKEN,
      USDG,
      POSITION_SIZE_USDG_RAW,
    );
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.priceImpactPct).toBeGreaterThan(0.01);
      expect(result.passesThreshold).toBe(false);
    }
  });

  it('rejects conservatively (ok: false) for a pool with swap-affecting hooks, never guesses', async () => {
    // Bit 7 (0x80 in the low byte) of a v4 hook address encodes the
    // `beforeSwap` permission -- this address is crafted specifically to
    // trigger `Hook.hasSwapPermissions`.
    const hookedKey: V4PoolKey = { ...key, hooks: ('0x' + '00'.repeat(19) + '80') as `0x${string}` };
    const result = await estimateExitPriceImpact(
      hookedKey,
      stateWithLiquidity(10n ** 30n),
      TOKEN,
      USDG,
      POSITION_SIZE_USDG_RAW,
    );
    expect(result.ok).toBe(false);
  });

  describe('H7 regression: a GENUINELY truncated (non-zero-net) tick window -- self-describing rejection, never a false low impact', () => {
    it('a tick list missing its upper boundary (net sum != 0) is rejected with a clear, self-describing reason -- NOT a smoothly-degrading high-impact number', async () => {
      const liquidity = 10n ** 21n;
      // A real position spans [-6000, 6000] (current tick 0 is inside it),
      // but the fetch window only captured the LOWER boundary tick -- the
      // upper boundary (+6000, which would net this back to zero) fell
      // outside the window. This is what a GENUINELY truncated fetch
      // produces -- unlike the old (wrong) fixture this test replaces,
      // which used a complete, net-zero pair and therefore could never
      // have exercised real truncation at all.
      const truncatedState: V4PoolStateSnapshot = {
        sqrtPriceX96: BigInt(SQRT_PRICE_X96_AT_TICK_0),
        liquidity,
        tickCurrent: 0,
        ticks: [{ index: -6000, liquidityNet: liquidity, liquidityGross: liquidity }],
        tickWindow: FULL_WINDOW,
      };

      const result = await estimateExitPriceImpact(key, truncatedState, TOKEN, USDG, POSITION_SIZE_USDG_RAW);

      // Never a "pass" (false low impact), and never a wrongly-passing
      // high-impact rejection with the wrong reason -- a clear,
      // self-describing truncation diagnosis instead.
      expect(result.ok).toBe(false);
      if (!result.ok) {
        expect(result.reason).toMatch(/truncated/);
        expect(result.reason).toMatch(/does not|sums to/);
      }
    });

    it('a complete, genuinely net-zero tick list is NOT flagged as truncated (the pre-check does not false-positive on a real, complete window)', async () => {
      const liquidity = 10n ** 21n;
      const completeState: V4PoolStateSnapshot = {
        sqrtPriceX96: BigInt(SQRT_PRICE_X96_AT_TICK_0),
        liquidity,
        tickCurrent: 0,
        ticks: [
          { index: -6000, liquidityNet: liquidity, liquidityGross: liquidity },
          { index: 6000, liquidityNet: -liquidity, liquidityGross: liquidity },
        ],
        tickWindow: FULL_WINDOW,
      };
      const result = await estimateExitPriceImpact(key, completeState, TOKEN, USDG, POSITION_SIZE_USDG_RAW);
      expect(result.ok).toBe(true);
    });
  });

  describe('tick-window completeness: zero-net is necessary but NEVER sufficient', () => {
    const SHALLOW = 10n ** 21n;
    const NARROW = { lowerTick: -600, upperTick: 600 };

    const snapshot = (over: Partial<V4PoolStateSnapshot>): V4PoolStateSnapshot => ({
      sqrtPriceX96: BigInt(SQRT_PRICE_X96_AT_TICK_0),
      liquidity: SHALLOW,
      tickCurrent: 0,
      ticks: [],
      tickWindow: FULL_WINDOW,
      ...over,
    });

    /**
     * A narrow window whose fetched ticks are net-zero and genuinely inside
     * it, with enough liquidity left after the inner crossing that the swap
     * keeps walking past the window edge. This is the exact shape that
     * exercises the SDK's silent-extrapolation path: the tick list is
     * non-empty (so no `LENGTH` invariant fires), it sums to zero (so the
     * necessary check passes), and the walk still ends on data that was
     * never fetched.
     */
    const cancellingPairInNarrowWindow = (): V4PoolStateSnapshot =>
      snapshot({
        liquidity: 2n * SHALLOW,
        ticks: [
          { index: -540, liquidityNet: SHALLOW, liquidityGross: SHALLOW },
          { index: 540, liquidityNet: -SHALLOW, liquidityGross: SHALLOW },
        ],
        tickWindow: NARROW,
      });
    const BIG_EXIT = POSITION_SIZE_USDG_RAW * 50n;

    it('complete window: the whole walk stays inside the scanned range, so the estimate is accepted', async () => {
      const result = await estimateExitPriceImpact(key, stateWithLiquidity(10n ** 30n), TOKEN, USDG, POSITION_SIZE_USDG_RAW);
      expect(result.ok).toBe(true);
    });

    it('a narrow window is fine as long as the walk stays inside it -- no false positives', async () => {
      const result = await estimateExitPriceImpact(
        key,
        snapshot({
          liquidity: 10n ** 30n,
          ticks: [
            { index: -540, liquidityNet: 10n ** 30n, liquidityGross: 10n ** 30n },
            { index: 540, liquidityNet: -(10n ** 30n), liquidityGross: 10n ** 30n },
          ],
          tickWindow: NARROW,
        }),
        TOKEN,
        USDG,
        POSITION_SIZE_USDG_RAW,
      );
      expect(result.ok).toBe(true);
    });

    it('incomplete window: a swap that walks outside the scanned range is rejected, not estimated', async () => {
      const result = await estimateExitPriceImpact(key, cancellingPairInNarrowWindow(), TOKEN, USDG, BIG_EXIT);
      expect(result.ok).toBe(false);
      if (!result.ok) expect(result.reason).toMatch(/could not be proven complete/);
    });

    it('missing NEGATIVE liquidityNet (upper boundary never fetched) is rejected by the zero-net necessary check', async () => {
      const result = await estimateExitPriceImpact(
        key,
        snapshot({ ticks: [{ index: -6000, liquidityNet: SHALLOW, liquidityGross: SHALLOW }] }),
        TOKEN,
        USDG,
        POSITION_SIZE_USDG_RAW,
      );
      expect(result.ok).toBe(false);
      if (!result.ok) expect(result.reason).toMatch(/truncated/);
    });

    it('missing POSITIVE liquidityNet (lower boundary never fetched) is rejected by the zero-net necessary check', async () => {
      const result = await estimateExitPriceImpact(
        key,
        snapshot({ ticks: [{ index: 6000, liquidityNet: -SHALLOW, liquidityGross: SHALLOW }] }),
        TOKEN,
        USDG,
        POSITION_SIZE_USDG_RAW,
      );
      expect(result.ok).toBe(false);
      if (!result.ok) expect(result.reason).toMatch(/truncated/);
    });

    it('THE BUG: a window missing BOTH a positive and a negative tick whose nets cancel still sums to zero -- and is STILL rejected', async () => {
      // Models a real pool holding a position spanning [-12000, +12000]:
      // `+L` at the lower boundary and `-L` at the upper one. The fetch
      // window only reached +/-600, so BOTH boundary ticks were missed.
      // Their nets cancel, so the fetched list sums to exactly zero and the
      // old `netSum === 0` test would have waved this through -- reporting a
      // confident, UNDER-estimated impact computed on liquidity that the SDK
      // silently extrapolated past the end of the tick list.
      const state = cancellingPairInNarrowWindow();
      // The fetched list is genuinely net-zero and genuinely inside the
      // window, so NEITHER the old zero-net test nor the snapshot-consistency
      // checks can catch this. Only the walk-containment invariant can.
      expect(state.ticks.reduce((s, t) => s + t.liquidityNet, 0n)).toBe(0n);
      expect(state.ticks.every((t) => t.index >= NARROW.lowerTick && t.index <= NARROW.upperTick)).toBe(true);

      const result = await estimateExitPriceImpact(key, state, TOKEN, USDG, BIG_EXIT);

      expect(result.ok).toBe(false);
      if (!result.ok) {
        expect(result.reason).toMatch(/could not be proven complete/);
        expect(result.reason).toMatch(/UNDER-reports/);
      }
    });

    it('boundary: tickCurrent sitting EXACTLY on a window edge is accepted -- containment is inclusive', async () => {
      // The edge tick itself was read from the bitmap, so a walk that starts
      // (and stays) on it used only data we actually have. What is unknown
      // begins one tick BEYOND the edge. Window ends at 0 so the fixture's
      // sqrtPriceX96 (tick 0) stays consistent with tickCurrent.
      const EDGE = { lowerTick: -600, upperTick: 0 };
      const deep = 10n ** 30n;
      const result = await estimateExitPriceImpact(
        key,
        snapshot({
          liquidity: deep,
          ticks: [
            { index: -540, liquidityNet: deep, liquidityGross: deep },
            { index: -60, liquidityNet: -deep, liquidityGross: deep },
          ],
          tickWindow: EDGE,
        }),
        TOKEN,
        USDG,
        POSITION_SIZE_USDG_RAW / 1000n,
      );
      expect(result.ok).toBe(true);
    });

    it('boundary: starting on the edge but walking PAST it is still rejected', async () => {
      // Same edge placement, but a swap large enough to push the price below
      // the lower edge -- the first tick beyond it is exactly what was never
      // fetched, so the estimate cannot be proven complete.
      const EDGE = { lowerTick: -600, upperTick: 0 };
      const result = await estimateExitPriceImpact(
        key,
        snapshot({
          liquidity: 2n * SHALLOW,
          ticks: [
            { index: -540, liquidityNet: SHALLOW, liquidityGross: SHALLOW },
            { index: -60, liquidityNet: -SHALLOW, liquidityGross: SHALLOW },
          ],
          tickWindow: EDGE,
        }),
        TOKEN,
        USDG,
        BIG_EXIT,
      );
      expect(result.ok).toBe(false);
      if (!result.ok) expect(result.reason).toMatch(/could not be proven complete/);
    });

    it('boundary: a fetched tick outside the declared window is a malformed snapshot, rejected before simulating', async () => {
      const result = await estimateExitPriceImpact(
        key,
        snapshot({ ticks: [{ index: -6000, liquidityNet: 0n, liquidityGross: SHALLOW }], tickWindow: NARROW }),
        TOKEN,
        USDG,
        POSITION_SIZE_USDG_RAW,
      );
      expect(result.ok).toBe(false);
      if (!result.ok) expect(result.reason).toMatch(/malformed snapshot/);
    });

    it('boundary: the current tick outside the scanned window is rejected before simulating', async () => {
      const result = await estimateExitPriceImpact(
        key,
        snapshot({ tickCurrent: 5000, tickWindow: NARROW }),
        TOKEN,
        USDG,
        POSITION_SIZE_USDG_RAW,
      );
      expect(result.ok).toBe(false);
      if (!result.ok) expect(result.reason).toMatch(/outside the scanned window/);
    });

    it('boundary: an empty or inverted window proves nothing and is rejected', async () => {
      const result = await estimateExitPriceImpact(
        key,
        snapshot({ tickWindow: { lowerTick: 600, upperTick: -600 } }),
        TOKEN,
        USDG,
        POSITION_SIZE_USDG_RAW,
      );
      expect(result.ok).toBe(false);
      if (!result.ok) expect(result.reason).toMatch(/empty or inverted/);
    });
  });

  it('C8 regression: a dynamic-fee-sentinel pool (fee=0x800000, with a hook) produces a NEGATIVE simulated impact and is rejected as ok:false -- never treated as a pass', async () => {
    // A dynamic-fee pool requires a non-zero hooks address (verified: the
    // SDK's own Pool constructor throws "Dynamic fee pool requires a
    // hook" otherwise) -- reproduces the exact scenario found in the
    // audit: fee=0x800000 with any hook produces ~-639% simulated impact.
    const dynamicFeeKey: V4PoolKey = { ...key, fee: 0x800000, hooks: '0x0000000000000000000000000000000000001000' };
    const result = await estimateExitPriceImpact(dynamicFeeKey, stateWithLiquidity(10n ** 30n), TOKEN, USDG, POSITION_SIZE_USDG_RAW);
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.reason).toMatch(/negative/);
  });
});
