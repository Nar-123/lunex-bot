import { Token, CurrencyAmount, Percent, computePriceImpact } from '@uniswap/sdk-core';
import JSBI from 'jsbi';
import { v4Sdk } from '../blockchain/uniswapSdk';
import { config } from '../config';
import type { V4PoolKey, V4PoolStateSnapshot, PriceImpactEstimate } from './types';

function buildPool(
  key: V4PoolKey,
  state: V4PoolStateSnapshot,
  currencyA: Token,
  currencyB: Token,
): InstanceType<typeof v4Sdk.Pool> {
  const ticks = state.ticks.map((t) => ({
    index: t.index,
    liquidityGross: t.liquidityGross.toString(),
    liquidityNet: t.liquidityNet.toString(),
  }));
  return new v4Sdk.Pool(
    currencyA,
    currencyB,
    key.fee,
    key.tickSpacing,
    key.hooks,
    state.sqrtPriceX96.toString(),
    state.liquidity.toString(),
    state.tickCurrent,
    ticks,
  );
}

/** Converts the single shared 0..1 fraction threshold into a comparable `Percent`. */
function thresholdPercent(fraction: number): Percent {
  const denominator = 1_000_000;
  return new Percent(Math.round(fraction * denominator), denominator);
}

/**
 * Estimates the price impact of exiting a hypothetical position sized
 * `positionSizeUsdgRaw` (USDG, raw/wei-equivalent units) via a REAL
 * simulated swap against the pool's actual liquidity distribution
 * (`Pool.getOutputAmount`, which walks real ticks using the official
 * Uniswap swap math) — never a TVL ratio, per spec.
 *
 * Direction simulated is TOKEN -> USDG (an exit swap), sized to be worth
 * `positionSizeUsdgRaw` at the pool's CURRENT mid price: "if this whole
 * position had to be exited right now, at this pool, how much price
 * impact would that cost." Uses `@uniswap/sdk-core`'s own
 * `computePriceImpact` (the same formula Uniswap's own frontend uses:
 * percent difference between the no-slippage mid-price quote and the
 * actually-simulated output) rather than hand-rolled math.
 *
 * Returns `{ ok: false, reason }` — never a guessed number — when the pool
 * has a hook with swap-affecting permissions: v4-sdk's
 * `Pool.getOutputAmount` throws `'Unsupported hook'` for these (verified
 * against the installed SDK), and there is no local way to simulate such
 * a hook's effect. Callers must treat `ok: false` as a rejection, never a
 * pass.
 *
 * If `state.ticks` doesn't cover the full range the swap needs to walk
 * (the caller fetched too narrow a window), this does NOT throw or need
 * special-casing: verified empirically that the swap math treats any
 * region beyond the supplied ticks as having zero liquidity, which drives
 * the computed impact toward 100% (fails the threshold) rather than
 * toward 0% (would wrongly pass) — the failure mode is safe by
 * construction. `PoolStateProviderPort` implementations only need to
 * fetch a "reasonably wide" tick window around the current price, not a
 * provably complete one.
 */
export async function estimateExitPriceImpact(
  key: V4PoolKey,
  state: V4PoolStateSnapshot,
  token: Token,
  usdg: Token,
  positionSizeUsdgRaw: bigint,
): Promise<PriceImpactEstimate> {
  try {
    const pool = buildPool(key, state, token, usdg);
    const midPrice = pool.priceOf(token); // USDG per TOKEN
    const usdgAmount = CurrencyAmount.fromRawAmount(usdg, JSBI.BigInt(positionSizeUsdgRaw.toString()));
    const tokenAmountIn = midPrice.invert().quote(usdgAmount);

    const [outputAmount] = await pool.getOutputAmount(tokenAmountIn);
    const impact = computePriceImpact(midPrice, tokenAmountIn, outputAmount);
    const threshold = thresholdPercent(config.rules.priceImpact.MAX_EXIT_IMPACT_PCT);

    return {
      ok: true,
      priceImpactPct: Number(impact.toFixed(10)) / 100,
      passesThreshold: !impact.greaterThan(threshold),
    };
  } catch (err) {
    return { ok: false, reason: err instanceof Error ? err.message : String(err) };
  }
}
