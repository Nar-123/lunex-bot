import { getAddress } from 'viem';
import { Token } from '@uniswap/sdk-core';
import JSBI from 'jsbi';
import { v4Sdk, v3TickMathUtils } from '../blockchain/uniswapSdk';
import { config } from '../config';
import type { LpRangeDiagnostics, LpRangeInput, LpRangeResult } from './types';

const { TickMath, nearestUsableTick, encodeSqrtRatioX96 } = v3TickMathUtils;

const Q192 = 1n << 192n;

/**
 * Pure function (no I/O/RPC) implementing the LP strategy's range math:
 * lower = 0.5x entry price, upper = entry price (0% offset, rounded
 * STRICTLY below the current tick so the position is genuinely
 * single-sided USDG at deposit time).
 *
 * ---- 1. Orientation ----
 * Uniswap v4 always sorts `currency0`/`currency1` by address, independent
 * of which one is USDG -- so "higher tick" does not universally mean
 * "TOKEN more expensive." A v4 tick is defined as the raw ratio
 * currency1/currency0 (see `Pool` constructor docs: "sqrtRatioX96 the
 * sqrt of the current ratio of amounts of currency1 to currency0" and
 * `encodeSqrtRatioX96`'s own doc: "ratio of amount1 and amount0"). This
 * function explicitly determines whether USDG is currency0 or currency1
 * FIRST, and the tick assignment logic branches on it:
 *
 *  - USDG = currency1: raw ratio IS "USDG per TOKEN" directly. Being
 *    single-sided USDG (per Uniswap's own range mechanics: a position
 *    holds 100% currency1 when the current price is AT OR ABOVE the
 *    range) means the range must sit AT OR BELOW the current tick.
 *    tickLower = tick at half the raw ratio; tickUpper = current tick,
 *    rounded DOWN to a tick STRICTLY below current.
 *
 *  - USDG = currency0: raw ratio is "TOKEN per USDG" -- the INVERSE of
 *    the business "USDG per TOKEN" price. Halving the USDG-per-TOKEN
 *    price means the raw ratio DOUBLES (not halves). Being single-sided
 *    USDG now means the range must sit AT OR ABOVE the current tick (a
 *    position holds 100% currency0 when price is BELOW the range).
 *    tickLower = current tick, rounded UP to a tick STRICTLY above
 *    current; tickUpper = tick at DOUBLE the raw ratio.
 *
 * Getting this branch wrong produces a position that is immediately
 * partially (or entirely) TOKEN at deposit time -- exactly the failure
 * mode the whole strategy exists to avoid. Both orientations have
 * dedicated test coverage.
 *
 * ---- 2. Decimals ----
 * The 0.5x/1.0x price scaling itself is computed entirely in the raw
 * sqrtPriceX96/tick domain (via exact integer arithmetic -- see below),
 * which is decimal-agnostic by construction: scaling a raw ratio by a
 * pure number (0.5 or 2) commutes with the fixed per-token decimal
 * scalar, so it produces the correct result regardless of decimals
 * without ever touching them. `decimals0`/`decimals1` are still required
 * inputs and ARE used -- for the `diagnostics` block's human-readable
 * prices (via `@uniswap/sdk-core`'s `Token`/`Price`, which need real
 * decimals to not be wildly wrong) -- but never for `tickLower`/
 * `tickUpper` themselves. This is a deliberate, verified design choice,
 * not an oversight: it means a wrong decimals value can only ever
 * corrupt the diagnostic strings, never the actual on-chain range.
 *
 * ---- 3/4. Tick derivation and rounding ----
 * The 0.5x/2x raw-ratio sqrtPriceX96 values are computed via
 * `encodeSqrtRatioX96` (v3-sdk's exact, integer-square-root-based
 * ratio encoder -- see `blockchain/uniswapSdk.ts` for why this v3-sdk
 * import is fine) fed with exact BigInt ratios, then converted to ticks
 * via `TickMath.getTickAtSqrtRatio` -- no floating point anywhere in
 * this path. Tick-spacing alignment uses `nearestUsableTick` throughout;
 * the "strictly below/above current tick" requirement is enforced with a
 * single, provably-sufficient one-step adjustment on top of that (see
 * inline comments), never a hand-rolled rounding algorithm.
 *
 * ---- 5. tickSpacing ----
 * Always taken from `input.tickSpacing` (the selected pool's real
 * `PoolKey.tickSpacing`) -- never a standard/assumed value. Confirmed
 * pools on Robinhood Chain can use non-standard spacing (e.g. 644).
 *
 * ---- 6. Validation ----
 * Every invariant (`tickLower < tickUpper`, both within
 * `[MIN_TICK, MAX_TICK]`, both exact multiples of `tickSpacing`) is
 * explicitly asserted before returning `ok: true` -- never assumed from
 * the rounding functions' behavior.
 */
export function computeLpRange(input: LpRangeInput): LpRangeResult {
  const { sqrtPriceX96, tickCurrent, tickSpacing, decimals0, decimals1, chainId } = input;

  if (!Number.isInteger(tickSpacing) || tickSpacing <= 0) {
    return { ok: false, reason: `invalid tickSpacing: ${tickSpacing}` };
  }
  if (!Number.isInteger(tickCurrent) || tickCurrent < TickMath.MIN_TICK || tickCurrent > TickMath.MAX_TICK) {
    return { ok: false, reason: `tickCurrent out of Uniswap tick bounds: ${tickCurrent}` };
  }
  if (sqrtPriceX96 <= 0n) {
    return { ok: false, reason: `invalid sqrtPriceX96: ${sqrtPriceX96}` };
  }
  if (!Number.isInteger(decimals0) || decimals0 < 0 || !Number.isInteger(decimals1) || decimals1 < 0) {
    return { ok: false, reason: `invalid decimals: decimals0=${decimals0}, decimals1=${decimals1}` };
  }

  let currency0: `0x${string}`;
  let currency1: `0x${string}`;
  let usdgAddress: `0x${string}`;
  try {
    currency0 = getAddress(input.currency0);
    currency1 = getAddress(input.currency1);
    usdgAddress = getAddress(config.quoteAsset.ADDRESS);
  } catch (err) {
    return { ok: false, reason: `invalid currency address: ${err instanceof Error ? err.message : String(err)}` };
  }

  // ---- 1. orientation ----
  let usdgIsCurrency0: boolean;
  if (currency0 === usdgAddress) {
    usdgIsCurrency0 = true;
  } else if (currency1 === usdgAddress) {
    usdgIsCurrency0 = false;
  } else {
    return {
      ok: false,
      reason: `neither currency0 (${currency0}) nor currency1 (${currency1}) matches the configured USDG address (${usdgAddress})`,
    };
  }

  try {
    // ---- exact half/double raw-ratio sqrtPriceX96, integer-only (no floats) ----
    const sSquared = sqrtPriceX96 * sqrtPriceX96;
    const halfSqrtPriceX96 = BigInt(encodeSqrtRatioX96(sSquared.toString(), (Q192 * 2n).toString()).toString());
    const doubleSqrtPriceX96 = BigInt(encodeSqrtRatioX96((sSquared * 2n).toString(), Q192.toString()).toString());

    const tickHalf = TickMath.getTickAtSqrtRatio(JSBI.BigInt(halfSqrtPriceX96.toString()));
    const tickDouble = TickMath.getTickAtSqrtRatio(JSBI.BigInt(doubleSqrtPriceX96.toString()));

    // ---- 3/4. orientation-dependent assignment + strict-direction rounding ----
    let tickLower: number;
    let tickUpper: number;
    if (usdgIsCurrency0) {
      // Case B: raw ratio = TOKEN/USDG. Single-sided-USDG range sits AT/ABOVE current tick.
      let lower = nearestUsableTick(tickCurrent, tickSpacing);
      // nearestUsableTick rounds to the NEAREST multiple, which could land
      // at-or-below tickCurrent -- force strictly ABOVE. One adjustment is
      // always sufficient: nearestUsableTick's result is within
      // tickSpacing/2 of tickCurrent, so adding a full tickSpacing when it
      // isn't already strictly greater guarantees strictly-greater.
      if (lower <= tickCurrent) lower += tickSpacing;
      tickLower = lower;
      tickUpper = nearestUsableTick(tickDouble, tickSpacing);
    } else {
      // Case A: raw ratio = USDG/TOKEN directly. Range sits AT/BELOW current tick.
      tickLower = nearestUsableTick(tickHalf, tickSpacing);
      let upper = nearestUsableTick(tickCurrent, tickSpacing);
      if (upper >= tickCurrent) upper -= tickSpacing; // symmetric one-step guarantee, strictly BELOW
      tickUpper = upper;
    }

    // ---- 6. explicit validation, never trust the rounding helpers blindly ----
    if (!(tickLower < tickUpper)) {
      return {
        ok: false,
        reason: `computed range is degenerate after rounding (tickLower=${tickLower}, tickUpper=${tickUpper}) -- tickSpacing (${tickSpacing}) is too large relative to the 50% range`,
      };
    }
    if (tickLower < TickMath.MIN_TICK || tickUpper > TickMath.MAX_TICK) {
      return {
        ok: false,
        reason: `computed range [${tickLower}, ${tickUpper}] exceeds Uniswap tick bounds [${TickMath.MIN_TICK}, ${TickMath.MAX_TICK}]`,
      };
    }
    if (tickLower % tickSpacing !== 0 || tickUpper % tickSpacing !== 0) {
      return {
        ok: false,
        reason: `computed ticks are not aligned to tickSpacing ${tickSpacing} (tickLower=${tickLower}, tickUpper=${tickUpper})`,
      };
    }

    return {
      ok: true,
      tickLower,
      tickUpper,
      diagnostics: buildDiagnostics({
        chainId,
        currency0,
        currency1,
        decimals0,
        decimals1,
        usdgIsCurrency0,
        tickCurrent,
        tickLower,
        tickUpper,
      }),
    };
  } catch (err) {
    return {
      ok: false,
      reason: `tick math failed (likely current price too close to MIN/MAX tick bound): ${err instanceof Error ? err.message : String(err)}`,
    };
  }
}

function buildDiagnostics(args: {
  chainId: number;
  currency0: `0x${string}`;
  currency1: `0x${string}`;
  decimals0: number;
  decimals1: number;
  usdgIsCurrency0: boolean;
  tickCurrent: number;
  tickLower: number;
  tickUpper: number;
}): LpRangeDiagnostics {
  const { chainId, currency0, currency1, decimals0, decimals1, usdgIsCurrency0, tickCurrent, tickLower, tickUpper } =
    args;

  const usdgToken = new Token(chainId, usdgIsCurrency0 ? currency0 : currency1, usdgIsCurrency0 ? decimals0 : decimals1, 'USDG');
  const otherToken = new Token(chainId, usdgIsCurrency0 ? currency1 : currency0, usdgIsCurrency0 ? decimals1 : decimals0, 'TOKEN');

  const priceAt = (tick: number): string => v4Sdk.tickToPrice(otherToken, usdgToken, tick).toSignificant(6);

  // Regardless of orientation, tickLower/tickUpper's roles in raw-tick
  // space differ (Case A: lower=0.5x, upper=entry; Case B: lower=entry,
  // upper=0.5x -- see the main function's doc comment) -- map back to the
  // business meaning (lower human price < upper human price) explicitly.
  const halfPriceTick = usdgIsCurrency0 ? tickUpper : tickLower;
  const nearEntryTick = usdgIsCurrency0 ? tickLower : tickUpper;

  return {
    usdgIsCurrency0,
    entryPriceUsdgPerToken: priceAt(tickCurrent),
    lowerPriceUsdgPerToken: priceAt(halfPriceTick),
    upperPriceUsdgPerToken: priceAt(nearEntryTick),
  };
}
