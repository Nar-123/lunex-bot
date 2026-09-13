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
 * ## H7 fix — corrected tick-window-truncation documentation
 *
 * An EARLIER version of this comment claimed a too-narrow fetched window
 * "fails safe toward 100% impact" because the swap math supposedly treats
 * unfetched regions as zero liquidity. That claim was FACTUALLY WRONG,
 * verified directly against the installed SDK: `@uniswap/v4-sdk`'s
 * `Pool`/`TickListDataProvider` enforces a `ZERO_NET` invariant at
 * CONSTRUCTION time (liquidityNet across the supplied tick list must sum
 * to exactly zero, since every position's addition at tickLower has a
 * matching subtraction at tickUpper) — a genuinely truncated window
 * (missing ticks at either edge) generally breaks this and throws a
 * cryptic `"Invariant failed: ZERO_NET"` error, not a smoothly-degrading
 * high-impact number. The MONEY-SAFETY outcome is still fine either way
 * (a throw is caught below and returns `ok: false`, same as a genuine
 * high-impact rejection) — but the mechanism and the diagnostic message
 * were both wrong, which made a real truncation bug hard to distinguish
 * from other failures. `estimateExitPriceImpact` now checks the SAME
 * zero-net invariant itself, BEFORE constructing the `Pool`, so a
 * truncated window produces a clear, self-describing reason instead of
 * the SDK's internal invariant message.
 *
 * On window sizing: `poolStateProvider.ts`'s `TICK_BITMAP_WORD_RANGE`
 * (±10 words) already scales with `tickSpacing` for free -- each bitmap
 * word covers `256 * tickSpacing` raw ticks, so a coarser-tickSpacing pool
 * (which also has coarser, more widely-spaced real positions) gets a
 * proportionally wider absolute tick range fetched for the same word
 * count. Ten words either side of the current tick is wide enough to
 * contain both boundaries of the ~50%-below-entry one-sided range this
 * strategy itself creates (see `strategies/computeLpRange.ts`) for any
 * `tickSpacing` this project's pool selection accepts. A pool with
 * genuinely unusual liquidity concentration far outside that window still
 * fails SAFE (rejected, self-describing reason) rather than silently
 * passing, so widening the window further is a thoroughness/cost
 * trade-off, not a correctness requirement.
 */
function tickNetSum(ticks: V4PoolStateSnapshot['ticks']): bigint {
  return ticks.reduce((sum, t) => sum + t.liquidityNet, 0n);
}
export async function estimateExitPriceImpact(
  key: V4PoolKey,
  state: V4PoolStateSnapshot,
  token: Token,
  usdg: Token,
  positionSizeUsdgRaw: bigint,
): Promise<PriceImpactEstimate> {
  try {
    // H7 fix: pre-check the SAME zero-net invariant the SDK enforces
    // internally, so a truncated fetch window produces a clear,
    // self-describing reason instead of the SDK's own cryptic invariant
    // message. Skipped for an empty tick list (sum trivially 0, and an
    // empty pool is its own separate, already-safe rejection path via
    // whatever `Pool`/`getOutputAmount` does with zero liquidity).
    const netSum = tickNetSum(state.ticks);
    if (state.ticks.length > 0 && netSum !== 0n) {
      return {
        ok: false,
        reason: `fetched tick window appears truncated -- liquidityNet across the ${state.ticks.length} fetched ticks sums to ${netSum} instead of 0, meaning some initialized ticks fall outside the fetched range. Cannot safely simulate; widen the tick-fetch window (see poolStateProvider.ts's TICK_BITMAP_WORD_RANGE).`,
      };
    }

    const pool = buildPool(key, state, token, usdg);
    const midPrice = pool.priceOf(token); // USDG per TOKEN
    const usdgAmount = CurrencyAmount.fromRawAmount(usdg, JSBI.BigInt(positionSizeUsdgRaw.toString()));
    const tokenAmountIn = midPrice.invert().quote(usdgAmount);

    const [outputAmount] = await pool.getOutputAmount(tokenAmountIn);
    const impact = computePriceImpact(midPrice, tokenAmountIn, outputAmount);
    const threshold = thresholdPercent(config.rules.priceImpact.MAX_EXIT_IMPACT_PCT);
    const priceImpactPct = Number(impact.toFixed(10)) / 100;

    // C8 fix: a genuine, correctly-simulated exit swap can never produce a
    // NEGATIVE price impact (the simulated output can never legitimately
    // exceed the no-slippage mid-price quote). A negative value here means
    // the local swap math could not correctly model this pool's real fee
    // behavior (e.g. a dynamic-fee pool -- see DYNAMIC_FEE_FLAG in
    // types.ts, reproduced directly: ~-639% simulated impact), NOT a
    // favorable trade. Treated as "could not verify," never as a pass --
    // `passesThreshold` must never be computed from a number that can't be
    // trusted in the first place.
    if (priceImpactPct < 0) {
      return {
        ok: false,
        reason: `computed price impact is negative (${(priceImpactPct * 100).toFixed(4)}%) -- the pool's fee/liquidity behavior could not be correctly simulated (e.g. a dynamic-fee pool), not a genuinely favorable trade`,
      };
    }

    return {
      ok: true,
      priceImpactPct,
      passesThreshold: !impact.greaterThan(threshold),
    };
  } catch (err) {
    return { ok: false, reason: err instanceof Error ? err.message : String(err) };
  }
}
