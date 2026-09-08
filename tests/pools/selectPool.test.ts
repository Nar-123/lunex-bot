import { describe, expect, it, vi } from 'vitest';
import { Token } from '@uniswap/sdk-core';
import { selectPool } from '../../src/pools/selectPool';
import type {
  PoolDiscoveryPort,
  PoolStateProviderPort,
  PoolVolumeProviderPort,
  V4PoolRef,
  V4PoolStateSnapshot,
} from '../../src/pools/types';

const CHAIN_ID = 4663;
const USDG = new Token(CHAIN_ID, '0x1111111111111111111111111111111111111111', 18, 'USDG', 'USDG');
const TOKEN = new Token(CHAIN_ID, '0xffffffffffffffffffffffffffffffffffffffff', 18, 'TOKEN', 'Test Token');
const POSITION_SIZE = 1_000n * 10n ** 18n;

function pool(fee: number, poolId: string): V4PoolRef {
  return {
    poolId: poolId as `0x${string}`,
    key: {
      currency0: USDG.address as `0x${string}`,
      currency1: TOKEN.address as `0x${string}`,
      fee,
      tickSpacing: 60,
      hooks: '0x0000000000000000000000000000000000000000',
    },
  };
}

const SQRT_PRICE_AT_TICK_0 = 2n ** 96n;
const FULL_RANGE_LOWER = -887220;
const FULL_RANGE_UPPER = 887220;

function stateWithLiquidity(liquidity: bigint): V4PoolStateSnapshot {
  return {
    sqrtPriceX96: SQRT_PRICE_AT_TICK_0,
    liquidity,
    tickCurrent: 0,
    ticks: [
      { index: FULL_RANGE_LOWER, liquidityNet: liquidity, liquidityGross: liquidity },
      { index: FULL_RANGE_UPPER, liquidityNet: -liquidity, liquidityGross: liquidity },
    ],
  };
}

function mockDeps(overrides: {
  pools?: V4PoolRef[];
  statesByPoolId?: Record<string, V4PoolStateSnapshot>;
  volumesByPoolId?: Record<string, number>;
}): { discovery: PoolDiscoveryPort; state: PoolStateProviderPort; volume: PoolVolumeProviderPort } {
  return {
    discovery: { findPoolsForPair: vi.fn(async () => overrides.pools ?? []) },
    state: {
      getState: vi.fn(async (p: V4PoolRef) => overrides.statesByPoolId?.[p.poolId] ?? stateWithLiquidity(10n ** 30n)),
    },
    volume: {
      get6hVolumeUsd: vi.fn(async (p: V4PoolRef) => overrides.volumesByPoolId?.[p.poolId] ?? 0),
    },
  };
}

describe('selectPool', () => {
  it('rejects the candidate outright when no v4 pool exists at all', async () => {
    const deps = mockDeps({ pools: [] });
    const result = await selectPool(TOKEN, USDG, POSITION_SIZE, deps);
    expect(result.selected).toBe(false);
    if (!result.selected) expect(result.reason).toBe('NO_POOLS_FOUND');
  });

  it('excludes a pool with fee === 0 without ever simulating price impact', async () => {
    const zeroFeePool = pool(0, '0xaaa');
    const deps = mockDeps({ pools: [zeroFeePool] });
    const result = await selectPool(TOKEN, USDG, POSITION_SIZE, deps);
    expect(result.selected).toBe(false);
    if (!result.selected) {
      expect(result.reason).toBe('ALL_POOLS_REJECTED');
      expect(result.evaluations[0]?.rejectReason).toBe('fee is 0');
    }
    expect(deps.state.getState).not.toHaveBeenCalled();
  });

  it('excludes a pool whose exit price impact exceeds the shared 1% threshold', async () => {
    const shallowPool = pool(3000, '0xbbb');
    const deps = mockDeps({
      pools: [shallowPool],
      statesByPoolId: { '0xbbb': stateWithLiquidity(10n ** 20n) }, // shallow relative to POSITION_SIZE
    });
    const result = await selectPool(TOKEN, USDG, POSITION_SIZE, deps);
    expect(result.selected).toBe(false);
    if (!result.selected) expect(result.reason).toBe('ALL_POOLS_REJECTED');
  });

  it('picks the highest-6H-volume pool among survivors', async () => {
    const poolLowVol = pool(3000, '0xlow');
    const poolHighVol = pool(3000, '0xhigh');
    const deps = mockDeps({
      pools: [poolLowVol, poolHighVol],
      statesByPoolId: {
        '0xlow': stateWithLiquidity(10n ** 30n),
        '0xhigh': stateWithLiquidity(10n ** 30n),
      },
      volumesByPoolId: { '0xlow': 10_000, '0xhigh': 250_000 },
    });
    const result = await selectPool(TOKEN, USDG, POSITION_SIZE, deps);
    expect(result.selected).toBe(true);
    if (result.selected) {
      expect(result.pool.poolId).toBe('0xhigh');
      expect(result.volume6hUsd).toBe(250_000);
    }
  });

  it('never fetches volume for a pool that already failed the fee/impact filter', async () => {
    const zeroFeePool = pool(0, '0xaaa');
    const goodPool = pool(3000, '0xgood');
    const deps = mockDeps({
      pools: [zeroFeePool, goodPool],
      statesByPoolId: { '0xgood': stateWithLiquidity(10n ** 30n) },
      volumesByPoolId: { '0xgood': 500 },
    });
    const result = await selectPool(TOKEN, USDG, POSITION_SIZE, deps);
    expect(result.selected).toBe(true);
    expect(deps.volume.get6hVolumeUsd).toHaveBeenCalledTimes(1);
    expect(deps.volume.get6hVolumeUsd).toHaveBeenCalledWith(expect.objectContaining({ poolId: '0xgood' }));
  });

  it('rejects the candidate when every discovered pool fails filters (mixed reasons)', async () => {
    const zeroFeePool = pool(0, '0xaaa');
    const shallowPool = pool(3000, '0xbbb');
    const deps = mockDeps({
      pools: [zeroFeePool, shallowPool],
      statesByPoolId: { '0xbbb': stateWithLiquidity(10n ** 20n) },
    });
    const result = await selectPool(TOKEN, USDG, POSITION_SIZE, deps);
    expect(result.selected).toBe(false);
    if (!result.selected) {
      expect(result.reason).toBe('ALL_POOLS_REJECTED');
      expect(result.evaluations).toHaveLength(2);
    }
  });
});
