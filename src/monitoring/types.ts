import type { PositionRecord } from '../positions/types';

/** Live, on-chain-read state of a position's NFT -- everything `computePositionMetrics` needs beyond what's already stored on the `PositionRecord`. */
export interface LivePositionState {
  /** Current liquidity of this specific position (not the whole pool's). */
  liquidity: bigint;
  /** Uncollected fees owed, in currency0/currency1 raw units. */
  tokensOwed0: bigint;
  tokensOwed1: bigint;
}

export interface PoolPriceState {
  sqrtPriceX96: bigint;
  tickCurrent: number;
}

export type PositionMetricsResult =
  | {
      ok: true;
      positionId: string;
      currentPriceUsdgPerToken: string;
      entryPriceUsdgPerToken: string;
      /** (currentValue - entryValue) / entryValue. Position value only -- does NOT include uncollected fees (reported separately, per spec listing them as distinct metrics). */
      pnlPct: number;
      currentValueUsdgRaw: bigint;
      feesEarnedUsdgRaw: bigint;
      /** feesEarnedUsdgRaw / entryUsdgRaw. Not annualized -- a simple cumulative-yield-to-date ratio. */
      yieldPct: number;
      inRange: boolean;
    }
  | { ok: false; positionId: string; reason: string };

/**
 * Port: reads a position's live liquidity/owed-fees from the
 * PositionManager contract. Takes the full `PositionRecord` (not just
 * `pool`) -- an earlier version of this interface passed `pool` alone,
 * which is missing `tickLower`/`tickUpper`; both `getPositionInfo` and
 * `getFeeGrowthInside` need the position's own tick range, not just the
 * pool's identity, so that version couldn't actually be implemented.
 */
export interface LivePositionStateProvider {
  getLiveState(position: PositionRecord): Promise<LivePositionState>;
}

/** Port: reads a pool's current price state. Compatible with (and expected to be backed by) `pools/`'s `PoolStateProviderPort`. */
export interface PoolPriceProvider {
  getPriceState(pool: PositionRecord['pool']): Promise<PoolPriceState>;
}
