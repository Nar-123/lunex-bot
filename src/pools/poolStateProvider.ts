import type { Address } from 'viem';
import { getAddress } from 'viem';
import { getPublicClient } from '../blockchain/viemClient';
import { config } from '../config';
import { V4_STATE_VIEW_ABI } from '../blockchain/abis/v4StateView';
import type { PoolStateProviderPort, V4PoolRef, V4PoolStateSnapshot } from './types';

/**
 * Bitmap words scanned on each side of the current tick when fetching
 * tick data (each word covers 256 tick-spacing steps). A wider window
 * costs more RPC calls but lets the price-impact simulation
 * (`priceImpact.ts`) walk further before running out of data — and per
 * the VERIFIED finding there, running out of data fails safe (rejects
 * the pool) rather than silently under-reporting impact, so this is a
 * cost/thoroughness tuning knob, not a correctness cliff.
 * BEST EFFORT: tune based on real observed liquidity distributions.
 */
const TICK_BITMAP_WORD_RANGE = 10;
const BITS_PER_WORD = 256;

function compress(tick: number, tickSpacing: number): number {
  // JS `Math.floor` already rounds toward negative infinity, matching the
  // compressed-tick semantics Uniswap's Solidity code gets by explicitly
  // adjusting after a toward-zero integer division — no extra adjustment
  // needed (verified: an earlier version of this function subtracted 1
  // again on top of `Math.floor` for negative non-exact ticks, which
  // double-applied the floor and was off by one — caught by
  // `poolStateProvider.test.ts`).
  return Math.floor(tick / tickSpacing);
}

function wordPosition(compressedTick: number): number {
  return Math.floor(compressedTick / BITS_PER_WORD);
}

function bitPosition(compressedTick: number): number {
  const pos = compressedTick % BITS_PER_WORD;
  return pos < 0 ? pos + BITS_PER_WORD : pos;
}

function setBitsToCompressedTicks(word: number, bitmap: bigint): number[] {
  const ticks: number[] = [];
  for (let bit = 0; bit < BITS_PER_WORD; bit++) {
    if ((bitmap >> BigInt(bit)) & 1n) {
      ticks.push(word * BITS_PER_WORD + bit);
    }
  }
  return ticks;
}

/**
 * Throws if the configured `StateView` contract isn't actually bound to
 * the configured `PoolManager` (via `StateView.poolManager()`). Catches a
 * copy/paste mismatch between `UNISWAP_V4_STATE_VIEW_ADDRESS` and
 * `UNISWAP_V4_POOL_MANAGER_ADDRESS` at the first real read, before it can
 * silently return state for the wrong PoolManager. Extracted as a pure
 * function so the comparison logic is unit-testable without an RPC call.
 */
export function checkStateViewBinding(boundPoolManager: Address, expectedPoolManager: Address): void {
  if (getAddress(boundPoolManager) !== getAddress(expectedPoolManager)) {
    throw new Error(
      `Config mismatch: StateView contract is bound to PoolManager ${boundPoolManager}, but ` +
        `config.uniswap.v4.poolManager is ${expectedPoolManager}. Check UNISWAP_V4_STATE_VIEW_ADDRESS / ` +
        `UNISWAP_V4_POOL_MANAGER_ADDRESS in .env.`,
    );
  }
}

let bindingCheck: Promise<void> | undefined;

/** Runs `checkStateViewBinding` against the live contract exactly once per process. */
function ensureStateViewBinding(): Promise<void> {
  if (!bindingCheck) {
    bindingCheck = (async () => {
      const client = getPublicClient();
      const stateView = config.uniswap.v4.stateView as Address;
      const boundPoolManager = await client.readContract({
        address: stateView,
        abi: V4_STATE_VIEW_ABI,
        functionName: 'poolManager',
      });
      checkStateViewBinding(boundPoolManager, config.uniswap.v4.poolManager as Address);
    })();
  }
  return bindingCheck;
}

/**
 * Reads a v4 pool's current state (slot0 + liquidity) and a bounded
 * window of real initialized-tick data around the current price via the
 * periphery `StateView` contract.
 *
 * BEST EFFORT / flagged for verification: relies on the `StateView` ABI
 * in `blockchain/abis/v4StateView.ts` (unconfirmed against Robinhood
 * Chain's actual deployment) and on a bounded tick-bitmap scan rather
 * than a fully lazy on-demand fetch. Isolated behind
 * `PoolStateProviderPort` so either can be corrected/replaced without
 * touching `priceImpact.ts` or `selectPool.ts`.
 */
export class StateViewPoolStateProvider implements PoolStateProviderPort {
  async getState(pool: V4PoolRef): Promise<V4PoolStateSnapshot> {
    await ensureStateViewBinding();

    const client = getPublicClient();
    const stateView = config.uniswap.v4.stateView as Address;
    const { poolId, key } = pool;

    const [slot0, liquidity] = await Promise.all([
      client.readContract({
        address: stateView,
        abi: V4_STATE_VIEW_ABI,
        functionName: 'getSlot0',
        args: [poolId],
      }),
      client.readContract({
        address: stateView,
        abi: V4_STATE_VIEW_ABI,
        functionName: 'getLiquidity',
        args: [poolId],
      }),
    ]);
    const [sqrtPriceX96, tickCurrent] = slot0;

    const compressedCurrent = compress(tickCurrent, key.tickSpacing);
    const centerWord = wordPosition(compressedCurrent);

    const wordReads = await Promise.all(
      Array.from({ length: TICK_BITMAP_WORD_RANGE * 2 + 1 }, (_, i) => centerWord - TICK_BITMAP_WORD_RANGE + i).map(
        async (word) => {
          const bitmap = await client.readContract({
            address: stateView,
            abi: V4_STATE_VIEW_ABI,
            functionName: 'getTickBitmap',
            args: [poolId, word],
          });
          return { word, bitmap };
        },
      ),
    );

    const compressedTicks = wordReads.flatMap(({ word, bitmap }) => setBitsToCompressedTicks(word, bitmap));

    const ticks = await Promise.all(
      compressedTicks.map(async (compressedTick) => {
        const tickIndex = compressedTick * key.tickSpacing;
        const [liquidityGross, liquidityNet] = await client.readContract({
          address: stateView,
          abi: V4_STATE_VIEW_ABI,
          functionName: 'getTickInfo',
          args: [poolId, tickIndex],
        });
        return { index: tickIndex, liquidityGross, liquidityNet };
      }),
    );

    return {
      sqrtPriceX96,
      liquidity,
      tickCurrent,
      ticks,
    };
  }
}

/** Exported for unit testing the bitmap math without a live RPC connection. */
export const __internal = { compress, wordPosition, bitPosition, setBitsToCompressedTicks };
