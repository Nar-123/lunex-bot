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
  };
}

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
      };
      const result = await estimateExitPriceImpact(key, completeState, TOKEN, USDG, POSITION_SIZE_USDG_RAW);
      expect(result.ok).toBe(true);
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
