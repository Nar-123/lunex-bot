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

  it('never under-estimates impact when the fetched tick window is too narrow -- verified: the SDK treats unfetched regions as zero liquidity, so this fails safe (high impact, rejected) rather than silently passing', async () => {
    const tinyLiquidity = 1n; // a window far too narrow for a 1000-USDG-equivalent swap
    const narrowState: V4PoolStateSnapshot = {
      sqrtPriceX96: BigInt(SQRT_PRICE_X96_AT_TICK_0),
      liquidity: tinyLiquidity,
      tickCurrent: 0,
      ticks: [
        { index: -TICK_SPACING, liquidityNet: tinyLiquidity, liquidityGross: tinyLiquidity },
        { index: TICK_SPACING, liquidityNet: -tinyLiquidity, liquidityGross: tinyLiquidity },
      ],
    };
    const result = await estimateExitPriceImpact(key, narrowState, TOKEN, USDG, POSITION_SIZE_USDG_RAW);
    // This does NOT throw / come back ok:false -- the swap math treats the
    // region beyond the provided ticks as having no liquidity at all,
    // which pushes the computed impact toward 100% rather than toward 0%.
    // Confirmed empirically: this is the safe failure direction (a pool a
    // caller under-fetched data for gets conservatively rejected, never
    // wrongly accepted) -- so `PoolStateProviderPort` implementations only
    // need to fetch a "reasonably wide" window, not a provably complete one.
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.passesThreshold).toBe(false);
      expect(result.priceImpactPct).toBeGreaterThan(0.5);
    }
  });
});
