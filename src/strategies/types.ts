import type { Address } from 'viem';

export interface LpRangeInput {
  /** Real, current sqrt price from the pool's slot0 -- the source of truth for "entry price". */
  sqrtPriceX96: bigint;
  /** Real, current tick from the pool's slot0. Must be consistent with `sqrtPriceX96`. */
  tickCurrent: number;
  /** MUST come from the selected pool's `PoolKey.tickSpacing` -- never assumed/hardcoded. */
  tickSpacing: number;
  currency0: Address;
  currency1: Address;
  /** Real decimals of currency0, as already resolved in Module 3 -- never assumed to be 18. */
  decimals0: number;
  /** Real decimals of currency1. */
  decimals1: number;
  chainId: number;
}

export interface LpRangeDiagnostics {
  usdgIsCurrency0: boolean;
  /** Human-readable, decimal-aware. For logs/reporting only -- never fed back into tick math. */
  entryPriceUsdgPerToken: string;
  lowerPriceUsdgPerToken: string;
  upperPriceUsdgPerToken: string;
}

export type LpRangeResult =
  | { ok: true; tickLower: number; tickUpper: number; diagnostics: LpRangeDiagnostics }
  | { ok: false; reason: string };
