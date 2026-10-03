import type { Address } from 'viem';

export interface V4PoolKey {
  currency0: Address;
  currency1: Address;
  fee: number;
  tickSpacing: number;
  hooks: Address;
}

/**
 * Uniswap v4's dynamic-fee sentinel (`LPFeeLibrary.DYNAMIC_FEE_FLAG` in
 * the core contracts, `0x800000`). A `PoolKey.fee` of exactly this value
 * means the pool's actual per-swap fee is decided live by a hook, not a
 * static number baked into the key. C8 fix: the v4 SDK's local swap
 * simulation (`priceImpact.ts`'s `estimateExitPriceImpact`) assumes a
 * static fee strictly less than 1,000,000 and silently produces
 * nonsensical (negative) simulated output for this sentinel -- verified
 * by direct reproduction: a dynamic-fee pool passed the exit-impact filter
 * with a simulated impact of roughly -639%. Since it's `> 0`, it was not
 * caught by the pre-existing `fee <= MIN_FEE` guard. `selectPool.ts`
 * rejects any pool with this exact fee outright (it cannot be locally
 * simulated at all); `priceImpact.ts` additionally rejects any negative
 * computed impact as a second, independent layer of defense.
 */
export const DYNAMIC_FEE_FLAG = 0x800000;

export interface V4PoolRef {
  poolId: `0x${string}`;
  key: V4PoolKey;
}

/**
 * The inclusive raw-tick range the provider actually scanned when building
 * a snapshot. This is the ONLY region where `ticks` is known to be
 * complete: every initialized tick inside it was read from the pool's tick
 * bitmap, so a gap inside the window is genuinely uninitialized liquidity.
 * Outside it nothing is known at all.
 *
 * This distinction is load-bearing, not bookkeeping. `@uniswap/v3-sdk`'s
 * `TickList.nextInitializedTickWithinOneWord` (which v4-sdk's `Pool` uses)
 * does NOT throw when a swap walks past the end of the supplied tick list:
 * `tickList.js:88-89` and `:98-99` return `[wordBoundary, false]`, i.e.
 * "no initialized tick here". The swap loop therefore continues as if
 * liquidity never changed again out there — which makes a truncated pool
 * look DEEPER than it is and UNDER-reports price impact, the
 * money-losing direction. `priceImpact.ts` fails closed instead, by
 * proving the simulated price walk never leaves this window.
 */
export interface V4TickWindow {
  /** Lowest raw tick index whose initialization state is known. */
  lowerTick: number;
  /** Highest raw tick index whose initialization state is known. */
  upperTick: number;
}

/** Real on-chain state needed to construct a v4-sdk `Pool` for simulation. */
export interface V4PoolStateSnapshot {
  sqrtPriceX96: bigint;
  liquidity: bigint;
  tickCurrent: number;
  /**
   * Real, on-chain tick liquidity data covering the window this snapshot
   * was fetched for — NOT the whole pool. If a swap simulation needs to
   * cross beyond this window, it fails loudly (see `priceImpact.ts`)
   * rather than silently under/over-estimating impact.
   */
  ticks: Array<{ index: number; liquidityNet: bigint; liquidityGross: bigint }>;
  /**
   * The scanned range `ticks` is complete for. Required, so that a provider
   * physically cannot hand the simulator a tick list without saying how far
   * its knowledge extends — the completeness check in `priceImpact.ts` has
   * no safe default to fall back on.
   */
  tickWindow: V4TickWindow;
}

export type PriceImpactEstimate =
  | { ok: true; priceImpactPct: number; passesThreshold: boolean }
  | { ok: false; reason: string };

export interface PoolEvaluation {
  pool: V4PoolRef;
  /** 0 / not fetched when the pool already failed the fee or impact filter (no point spending an RPC call). */
  volume6hUsd: number;
  /** Absent when the pool was rejected before a simulation was attempted (e.g. fee === 0). */
  priceImpact?: PriceImpactEstimate;
  /** True only if fee > 0 AND priceImpact.ok AND priceImpact.passesThreshold. */
  passed: boolean;
  rejectReason?: string;
}

export type PoolSelectionResult =
  | {
      selected: true;
      pool: V4PoolRef;
      volume6hUsd: number;
      priceImpactPct: number;
      evaluations: PoolEvaluation[];
    }
  | {
      selected: false;
      reason: 'NO_POOLS_FOUND' | 'ALL_POOLS_REJECTED';
      evaluations: PoolEvaluation[];
    };

/** Port: enumerate every v4 pool that exists for a given currency pair. */
export interface PoolDiscoveryPort {
  findPoolsForPair(currencyA: Address, currencyB: Address): Promise<V4PoolRef[]>;
}

/** Port: read a pool's current on-chain state for simulation. */
export interface PoolStateProviderPort {
  getState(pool: V4PoolRef): Promise<V4PoolStateSnapshot>;
}

/** Port: 6H swap volume for a specific pool, in USD. */
export interface PoolVolumeProviderPort {
  get6hVolumeUsd(pool: V4PoolRef): Promise<number>;
}

export interface PoolSelectionDeps {
  discovery: PoolDiscoveryPort;
  state: PoolStateProviderPort;
  volume: PoolVolumeProviderPort;
}
