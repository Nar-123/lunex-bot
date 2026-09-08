import type { Address } from 'viem';

export interface V4PoolKey {
  currency0: Address;
  currency1: Address;
  fee: number;
  tickSpacing: number;
  hooks: Address;
}

export interface V4PoolRef {
  poolId: `0x${string}`;
  key: V4PoolKey;
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
