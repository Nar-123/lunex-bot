import { describe, expect, it, vi } from 'vitest';
import { runMonitoringCycle } from '../../src/monitoring/monitorPositions';
import type { LivePositionStateProvider, PoolPriceProvider } from '../../src/monitoring/types';
import { InMemoryPositionRepository } from '../positions/inMemoryPositionRepository';
import { makeCreateInput } from '../positions/fixtures';

function makeDeps(overrides: {
  livePositionState?: LivePositionStateProvider;
  poolPrice?: PoolPriceProvider;
} = {}) {
  const livePositionState: LivePositionStateProvider = overrides.livePositionState ?? {
    getLiveState: vi.fn(async () => ({ liquidity: 1n, tokensOwed0: 0n, tokensOwed1: 0n })),
  };
  const poolPrice: PoolPriceProvider = overrides.poolPrice ?? {
    getPriceState: vi.fn(async () => ({ sqrtPriceX96: 2n ** 96n, tickCurrent: 0 })),
  };
  return { livePositionState, poolPrice };
}

describe('runMonitoringCycle', () => {
  it('monitors every confirmed ACTIVE position, skipping non-ACTIVE ones', async () => {
    const positions = new InMemoryPositionRepository();
    const active = await positions.create(makeCreateInput({ tokenAddress: '0x0000000000000000000000000000000000000002' }));
    await positions.markActive(active.id, '1', new Date());
    await positions.create(makeCreateInput({ tokenAddress: '0x0000000000000000000000000000000000000003' })); // stays OPENING

    const deps = makeDeps();
    const onMetrics = vi.fn();
    const results = await runMonitoringCycle({ positions, ...deps, onMetrics });

    expect(results).toHaveLength(1);
    expect(results[0]?.positionId).toBe(active.id);
    expect(onMetrics).toHaveBeenCalledTimes(1);
    expect(onMetrics).toHaveBeenCalledWith(results);
  });

  it('one position failing to read live state does not abort the whole cycle', async () => {
    const positions = new InMemoryPositionRepository();
    const good = await positions.create(makeCreateInput({ tokenAddress: '0x0000000000000000000000000000000000000002' }));
    await positions.markActive(good.id, '1', new Date());
    const bad = await positions.create(makeCreateInput({ tokenAddress: '0x0000000000000000000000000000000000000003' }));
    await positions.markActive(bad.id, '2', new Date());

    const livePositionState: LivePositionStateProvider = {
      getLiveState: vi.fn(async (position) => {
        if (position.positionTokenId === '2') throw new Error('RPC timeout');
        return { liquidity: 1n, tokensOwed0: 0n, tokensOwed1: 0n };
      }),
    };

    const results = await runMonitoringCycle({ positions, ...makeDeps({ livePositionState }), onMetrics: vi.fn() });

    expect(results).toHaveLength(2);
    const goodResult = results.find((r) => r.positionId === good.id);
    const badResult = results.find((r) => r.positionId === bad.id);
    expect(goodResult?.ok).toBe(true);
    expect(badResult?.ok).toBe(false);
    if (badResult && !badResult.ok) expect(badResult.reason).toMatch(/RPC timeout/);
  });

  it('flags a data inconsistency (ACTIVE with no positionTokenId) without crashing the cycle', async () => {
    const positions = new InMemoryPositionRepository();
    const inconsistent = await positions.create(makeCreateInput({ tokenAddress: '0x0000000000000000000000000000000000000002' }));
    // Force ACTIVE without going through markActive's positionTokenId assignment, simulating bad data.
    await positions.markActive(inconsistent.id, '', new Date());

    const results = await runMonitoringCycle({ positions, ...makeDeps(), onMetrics: vi.fn() });
    expect(results).toHaveLength(1);
    expect(results[0]?.ok).toBe(false);
    if (!results[0]?.ok) expect(results[0]?.reason).toMatch(/positionTokenId/);
  });

  it('returns an empty result set (and still calls onMetrics) when there are no active positions', async () => {
    const positions = new InMemoryPositionRepository();
    const onMetrics = vi.fn();
    const results = await runMonitoringCycle({ positions, ...makeDeps(), onMetrics });
    expect(results).toEqual([]);
    expect(onMetrics).toHaveBeenCalledWith([]);
  });
});
