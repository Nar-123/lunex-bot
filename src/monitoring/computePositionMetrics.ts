import { getAddress } from 'viem';
import { Token, CurrencyAmount } from '@uniswap/sdk-core';
import { v4Sdk } from '../blockchain/uniswapSdk';
import { config } from '../config';
import type { PositionRecord } from '../positions/types';
import type { LivePositionState, PoolPriceState, PositionMetricsResult } from './types';

const RATIO_PRECISION = 1_000_000n;

/** `(a - b) / b` as a plain JS ratio, computed via exact bigint division first -- avoids converting large raw (e.g. 18-decimal) amounts straight to `Number`, which can exceed `Number.MAX_SAFE_INTEGER`. */
function ratio(numerator: bigint, denominator: bigint): number {
  if (denominator === 0n) return 0;
  const scaled = (numerator * RATIO_PRECISION) / denominator;
  return Number(scaled) / Number(RATIO_PRECISION);
}

/**
 * Pure function (no I/O): computes a position's current price, PNL,
 * uncollected fees (converted to USDG terms), yield-to-date, and range
 * status -- given the position's stored entry data, its current live
 * on-chain state (liquidity + owed fees), and the pool's current price.
 *
 * Reuses the exact same orientation handling as `strategies/computeLpRange.ts`
 * (a v4 tick is the raw ratio currency1/currency0, independent of which
 * one is USDG) and the same "compute in raw/SDK terms, only touch
 * decimals for the human-readable display fields" discipline.
 *
 * Uses `@uniswap/v4-sdk`'s `Position` class (`.amount0`/`.amount1`) for
 * the actual token-composition math -- verified by reading its source:
 * these getters depend only on `pool.tickCurrent`/`pool.sqrtRatioX96`
 * (scalars, no tick-array/tickDataProvider needed) and never call
 * `Pool.swap()`, so -- unlike `pools/priceImpact.ts`'s simulation --
 * this works the same for hooked pools too; no special-casing needed.
 */
export function computePositionMetrics(
  position: PositionRecord,
  live: LivePositionState,
  poolPrice: PoolPriceState,
): PositionMetricsResult {
  try {
    const usdgAddress = getAddress(config.quoteAsset.ADDRESS);
    const currency0 = getAddress(position.pool.currency0);
    const currency1 = getAddress(position.pool.currency1);

    let usdgIsCurrency0: boolean;
    if (currency0 === usdgAddress) usdgIsCurrency0 = true;
    else if (currency1 === usdgAddress) usdgIsCurrency0 = false;
    else return { ok: false, positionId: position.id, reason: `neither currency0 nor currency1 matches the configured USDG address` };

    const usdgToken = new Token(
      config.chain.chainId,
      usdgIsCurrency0 ? currency0 : currency1,
      config.quoteAsset.DECIMALS,
      'USDG',
    );
    const otherToken = new Token(
      config.chain.chainId,
      usdgIsCurrency0 ? currency1 : currency0,
      position.tokenDecimals,
      position.tokenSymbol,
    );
    const currency0Token = usdgIsCurrency0 ? usdgToken : otherToken;
    const currency1Token = usdgIsCurrency0 ? otherToken : usdgToken;

    // Pool-wide liquidity is irrelevant to Position.amount0/1 (verified --
    // those getters only use tickCurrent/sqrtRatioX96), so any placeholder
    // satisfies the constructor without misrepresenting anything real.
    const pool = new v4Sdk.Pool(
      currency0Token,
      currency1Token,
      position.pool.fee,
      position.pool.tickSpacing,
      position.pool.hooks,
      poolPrice.sqrtPriceX96.toString(),
      '0',
      poolPrice.tickCurrent,
    );

    const sdkPosition = new v4Sdk.Position({
      pool,
      liquidity: live.liquidity.toString(),
      tickLower: position.tickLower,
      tickUpper: position.tickUpper,
    });

    const amount0 = sdkPosition.amount0;
    const amount1 = sdkPosition.amount1;
    const usdgAmountRaw = BigInt((usdgIsCurrency0 ? amount0 : amount1).quotient.toString());
    const tokenAmountRaw = BigInt((usdgIsCurrency0 ? amount1 : amount0).quotient.toString());

    const currentPrice = v4Sdk.tickToPrice(otherToken, usdgToken, poolPrice.tickCurrent);
    const entryPrice = v4Sdk.tickToPrice(otherToken, usdgToken, position.entryTick);

    const tokenAmountAsCurrency = CurrencyAmount.fromRawAmount(otherToken, tokenAmountRaw.toString());
    const tokenValueInUsdg = BigInt(currentPrice.quote(tokenAmountAsCurrency).quotient.toString());
    const currentValueUsdgRaw = usdgAmountRaw + tokenValueInUsdg;

    const owedUsdgSide = usdgIsCurrency0 ? live.tokensOwed0 : live.tokensOwed1;
    const owedTokenSide = usdgIsCurrency0 ? live.tokensOwed1 : live.tokensOwed0;
    const owedTokenAsCurrency = CurrencyAmount.fromRawAmount(otherToken, owedTokenSide.toString());
    const owedTokenValueInUsdg = BigInt(currentPrice.quote(owedTokenAsCurrency).quotient.toString());
    const feesEarnedUsdgRaw = owedUsdgSide + owedTokenValueInUsdg;

    const pnlPct = ratio(currentValueUsdgRaw - position.entryUsdgRaw, position.entryUsdgRaw);
    const yieldPct = ratio(feesEarnedUsdgRaw, position.entryUsdgRaw);
    const inRange = poolPrice.tickCurrent >= position.tickLower && poolPrice.tickCurrent < position.tickUpper;

    return {
      ok: true,
      positionId: position.id,
      currentPriceUsdgPerToken: currentPrice.toSignificant(6),
      entryPriceUsdgPerToken: entryPrice.toSignificant(6),
      pnlPct,
      currentValueUsdgRaw,
      feesEarnedUsdgRaw,
      yieldPct,
      inRange,
    };
  } catch (err) {
    return { ok: false, positionId: position.id, reason: err instanceof Error ? err.message : String(err) };
  }
}
