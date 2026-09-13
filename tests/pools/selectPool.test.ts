import { describe, expect, it, vi } from 'vitest';
import { Token } from '@uniswap/sdk-core';
import { selectPool } from '../../src/pools/selectPool';
import { DYNAMIC_FEE_FLAG } from '../../src/pools/types';
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

function pool(fee: number, poolId: string, hooks = '0x0000000000000000000000000000000000000000'): V4PoolRef {
  return {
    poolId: poolId as `0x${string}`,
    key: {
      currency0: USDG.address as `0x${string}`,
      currency1: TOKEN.address as `0x${string}`,
      fee,
      tickSpacing: 60,
      hooks: hooks as `0x${string}`,
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

  describe('C8 regression: dynamic-fee sentinel rejection', () => {
    it.each([100, 500, 3000])('normal static fee %i still gets simulated and passes with deep liquidity', async (fee) => {
      const p = pool(fee, `0xfee${fee}`);
      const deps = mockDeps({
        pools: [p],
        statesByPoolId: { [`0xfee${fee}`]: stateWithLiquidity(10n ** 30n) },
        volumesByPoolId: { [`0xfee${fee}`]: 1000 },
      });
      const result = await selectPool(TOKEN, USDG, POSITION_SIZE, deps);
      expect(result.selected).toBe(true);
      expect(deps.state.getState).toHaveBeenCalledTimes(1);
    });

    it('TIER 3: a static fee 5000 pool is still SIMULATED (not short-circuited like the sentinel) -- it simply fails the tightened 0.5% budget, because a 0.5% swap fee consumes the entire budget on its own', async () => {
      // Kept deliberately as its own case rather than dropped from the
      // parameterised list above: the C8 property under test is "a static
      // fee reaches the simulator at all", and that still holds here --
      // what changed in TIER 3 is the VERDICT, now that MAX_EXIT_IMPACT is
      // 0.5% (Meridian) instead of the old 1%.
      const p = pool(5000, '0xfee5000');
      const deps = mockDeps({
        pools: [p],
        statesByPoolId: { '0xfee5000': stateWithLiquidity(10n ** 30n) },
        volumesByPoolId: { '0xfee5000': 1000 },
      });
      const result = await selectPool(TOKEN, USDG, POSITION_SIZE, deps);
      expect(deps.state.getState).toHaveBeenCalledTimes(1); // genuinely simulated, unlike the sentinel below
      expect(result.selected).toBe(false);
      if (!result.selected) expect(result.evaluations[0]?.rejectReason).toMatch(/exit price impact/);
    });

    it('rejects the dynamic-fee sentinel (0x800000) outright, WITHOUT ever attempting to simulate it -- reproduces the confirmed filter bypass', async () => {
      const dynamicPool = pool(DYNAMIC_FEE_FLAG, '0xdynamic');
      const deps = mockDeps({ pools: [dynamicPool] });
      const result = await selectPool(TOKEN, USDG, POSITION_SIZE, deps);
      expect(result.selected).toBe(false);
      if (!result.selected) {
        expect(result.evaluations[0]?.rejectReason).toMatch(/dynamic-fee/);
      }
      expect(deps.state.getState).not.toHaveBeenCalled();
    });

    it('boundary: fee values immediately adjacent to the sentinel are NOT treated as dynamic-fee -- only the exact value is special-cased', async () => {
      const justBelow = pool(DYNAMIC_FEE_FLAG - 1, '0xbelow');
      const justAbove = pool(DYNAMIC_FEE_FLAG + 1, '0xabove');
      const deps = mockDeps({
        pools: [justBelow, justAbove],
        statesByPoolId: { '0xbelow': stateWithLiquidity(10n ** 30n), '0xabove': stateWithLiquidity(10n ** 30n) },
        volumesByPoolId: { '0xbelow': 100, '0xabove': 100 },
      });
      await selectPool(TOKEN, USDG, POSITION_SIZE, deps);
      expect(deps.state.getState).toHaveBeenCalledTimes(2); // both actually simulated, neither short-circuited
    });
  });

  describe('H6 regression: untrusted hook rejection (prefer hooks == address(0) unless proven safe)', () => {
    it('no hook (address(0)) -- PASSES through to simulation normally', async () => {
      const p = pool(3000, '0xnohook'); // default hooks: zero address
      const deps = mockDeps({ pools: [p], statesByPoolId: { '0xnohook': stateWithLiquidity(10n ** 30n) }, volumesByPoolId: { '0xnohook': 100 } });
      const result = await selectPool(TOKEN, USDG, POSITION_SIZE, deps);
      expect(result.selected).toBe(true);
    });

    it('a hook WITHOUT liquidity permissions (only a swap permission bit set) is still REJECTED -- this project rejects any non-zero hook outright, not just liquidity-permissioned ones', async () => {
      // Bit 7 (0x80) = BeforeSwap -- a swap permission, NOT a liquidity one.
      const swapOnlyHook = ('0x' + '00'.repeat(19) + '80') as `0x${string}`;
      const p = pool(3000, '0xswaponly', swapOnlyHook);
      const deps = mockDeps({ pools: [p] });
      const result = await selectPool(TOKEN, USDG, POSITION_SIZE, deps);
      expect(result.selected).toBe(false);
      if (!result.selected) expect(result.evaluations[0]?.rejectReason).toMatch(/hooks/);
      expect(deps.state.getState).not.toHaveBeenCalled(); // rejected before ever attempting simulation
    });

    it('a hook WITH liquidity permissions (BeforeRemoveLiquidity) is REJECTED', async () => {
      // Bit 9 (0x200) = BeforeRemoveLiquidity.
      const liquidityHook = ('0x' + '00'.repeat(18) + '0200') as `0x${string}`;
      const p = pool(3000, '0xliquidityhook', liquidityHook);
      const deps = mockDeps({ pools: [p] });
      const result = await selectPool(TOKEN, USDG, POSITION_SIZE, deps);
      expect(result.selected).toBe(false);
      if (!result.selected) expect(result.evaluations[0]?.rejectReason).toMatch(/hooks/);
    });

    it('a malicious/arbitrary non-zero hook address is REJECTED, regardless of which bits happen to be set', async () => {
      const maliciousHook = '0xffffffffffffffffffffffffffffffffffffffff' as `0x${string}`;
      const p = pool(3000, '0xmalicious', maliciousHook);
      const deps = mockDeps({ pools: [p] });
      const result = await selectPool(TOKEN, USDG, POSITION_SIZE, deps);
      expect(result.selected).toBe(false);
      if (!result.selected) expect(result.evaluations[0]?.rejectReason).toMatch(/hooks/);
    });

    it('the C8 dynamic-fee rejection still fires correctly for a zero-hooks dynamic-fee pool (the two checks do not interfere)', async () => {
      const dynamicPool = pool(DYNAMIC_FEE_FLAG, '0xdynamic'); // default zero hooks
      const deps = mockDeps({ pools: [dynamicPool] });
      const result = await selectPool(TOKEN, USDG, POSITION_SIZE, deps);
      expect(result.selected).toBe(false);
      if (!result.selected) expect(result.evaluations[0]?.rejectReason).toMatch(/dynamic-fee/);
    });
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
