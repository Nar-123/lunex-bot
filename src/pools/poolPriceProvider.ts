import type { PoolPriceProvider, PoolPriceState } from '../monitoring/types';
import type { PositionPoolContext } from '../positions/types';
import type { PoolStateProviderPort, V4PoolRef } from './types';
import { StateViewPoolStateProvider } from './poolStateProvider';

/**
 * Adapter: `monitoring/types.ts`'s `PoolPriceProvider` port (consumed by
 * `monitoring/`, `exits/`, and `positions/openPosition.ts`) has no real
 * implementation anywhere in the codebase -- confirmed by a full-repo
 * search before writing this, not assumed. `pools/`'s real, already-built
 * `StateViewPoolStateProvider` (Module 3) does the actual on-chain read,
 * but speaks a different shape on both ends: it takes a `V4PoolRef`
 * (`{poolId, key: {...}}`, nested) where `PoolPriceProvider` callers only
 * have a `PositionPoolContext` (`{poolId, currency0, currency1, fee,
 * tickSpacing, hooks}`, flat -- what's actually persisted on a
 * `PositionRecord`), and it returns a full `V4PoolStateSnapshot`
 * (including `liquidity`/`ticks`, needed for swap simulation) where
 * `PoolPriceProvider` only wants `{sqrtPriceX96, tickCurrent}`. This
 * class is purely a reshape on both sides -- no new on-chain logic, all
 * real reads still go through the same `StateViewPoolStateProvider`
 * every other real-infrastructure consumer in this project uses.
 */
export class StateViewPoolPriceProvider implements PoolPriceProvider {
  constructor(private readonly state: PoolStateProviderPort = new StateViewPoolStateProvider()) {}

  async getPriceState(pool: PositionPoolContext): Promise<PoolPriceState> {
    const ref: V4PoolRef = {
      poolId: pool.poolId,
      key: {
        currency0: pool.currency0,
        currency1: pool.currency1,
        fee: pool.fee,
        tickSpacing: pool.tickSpacing,
        hooks: pool.hooks,
      },
    };
    const snapshot = await this.state.getState(ref);
    return { sqrtPriceX96: snapshot.sqrtPriceX96, tickCurrent: snapshot.tickCurrent };
  }
}
