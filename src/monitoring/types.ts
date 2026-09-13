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

export interface PoolPriceSample {
  /** USDG per TOKEN at `observedAt`, as a plain number (6 significant figures is ample for a 20-period SMA). */
  price: number;
  observedAt: Date;
}

/**
 * TIER 3 — Port: the rolling pool-price history Bollinger %B is computed
 * from (`monitoring/bollinger.ts`). Persistent, not in-memory: a restart
 * must not reset the window to empty, or the OVEREXTENDED exit would go
 * blind for 100 minutes after every deploy.
 *
 * Deliberately keyed by POOL, not by position -- several positions can
 * share a pool, and the price series is a property of the pool.
 */
export interface PriceHistoryProvider {
  /** Appends one observation. Called once per pool per monitoring tick, only when the price read genuinely succeeded. */
  recordSample(poolId: string, price: number, observedAt?: Date): Promise<void>;
  /** Most recent samples for a pool, oldest-first, covering at most `windowMs` back from now. */
  recentSamples(poolId: string, windowMs: number, now?: Date): Promise<PoolPriceSample[]>;
  /** Drops samples older than `retentionMs`, so the table stays bounded. Best-effort: a failure here must never break a monitoring tick. */
  pruneOlderThan(retentionMs: number, now?: Date): Promise<void>;
}
