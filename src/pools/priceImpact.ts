import { Token, CurrencyAmount, Percent, computePriceImpact } from '@uniswap/sdk-core';
import JSBI from 'jsbi';
import { v4Sdk } from '../blockchain/uniswapSdk';
import { config } from '../config';
import type { V4PoolKey, V4PoolStateSnapshot, V4TickWindow, PriceImpactEstimate } from './types';

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
 * ## Tick-window completeness — why zero-net is NOT proof
 *
 * Two earlier versions of this comment were wrong in opposite directions,
 * so the mechanism is spelled out here against the installed SDK.
 *
 * The first claimed a too-narrow window "fails safe toward 100% impact"
 * because unfetched regions read as zero liquidity. Wrong.
 *
 * The second claimed a truncated window "generally breaks the SDK's
 * `ZERO_NET` invariant and throws". Also wrong, and more dangerous,
 * because it was used to justify treating `sum(liquidityNet) === 0` as
 * PROOF that the window is complete. It is not. Zero-net is a NECESSARY
 * condition, never a sufficient one: a window that drops a `+L` tick and
 * a `-L` tick still sums to zero, constructs a `Pool` without complaint,
 * and simulates happily.
 *
 * What actually happens past the edge of the supplied tick list is worse
 * than a throw. `@uniswap/v3-sdk`'s `TickList.nextInitializedTickWithinOneWord`
 * (used by v4-sdk's `Pool`) returns `[wordBoundary, false]` rather than
 * throwing — `tickList.js:88-89` for a downward walk, `:98-99` for an
 * upward one. "Not initialized" makes the swap loop carry the CURRENT
 * liquidity onward as if it never changed again, so a truncated pool
 * simulates as DEEPER than it really is and the reported impact is
 * UNDER-estimated. That is the money-losing direction, and it is silent.
 *
 * So completeness is proven positively instead, from the window the
 * provider actually scanned (`state.tickWindow`, see `types.ts`):
 *
 *   1. every fetched tick must lie inside that window (a snapshot whose
 *      own tick list escapes its stated coverage is malformed);
 *   2. the current tick must lie inside it;
 *   3. zero-net must still hold — kept as the cheap necessary check, with
 *      an honest reason string;
 *   4. and, after simulating, the price walk from `tickCurrent` to the
 *      post-swap tick must stay STRICTLY inside the window. Touching a
 *      boundary is rejected too: at the boundary the next tick beyond is
 *      exactly what was never read.
 *
 * Only (4) can catch the cancelling-pair case, because only (4) asks the
 * question that actually matters — did this simulation depend on data we
 * never fetched?
 *
 * On window sizing: `poolStateProvider.ts`'s `TICK_BITMAP_WORD_RANGE`
 * (±10 words) already scales with `tickSpacing` for free -- each bitmap
 * word covers `256 * tickSpacing` raw ticks, so a coarser-tickSpacing pool
 * (which also has coarser, more widely-spaced real positions) gets a
 * proportionally wider absolute tick range fetched for the same word
 * count. A pool whose exit swap genuinely walks outside that window is
 * now REJECTED with a self-describing reason rather than simulated on
 * data that does not exist, so widening the window is a
 * thoroughness/cost trade-off, not a correctness requirement.
 */
function tickNetSum(ticks: V4PoolStateSnapshot['ticks']): bigint {
  return ticks.reduce((sum, t) => sum + t.liquidityNet, 0n);
}

/**
 * True when the whole walked span `[low, high]` is covered by the scanned
 * window. Containment is INCLUSIVE: the boundary ticks themselves were
 * read from the bitmap, so a walk that ends exactly on `lowerTick` or
 * `upperTick` still used only data we actually have. What is unknown
 * begins one tick BEYOND each edge, which is why a swap that ends past an
 * edge — the case where the SDK has silently extrapolated — is the one
 * that must be rejected.
 */
function spanProvenInsideWindow(low: number, high: number, window: V4TickWindow): boolean {
  return low >= window.lowerTick && high <= window.upperTick;
}
export async function estimateExitPriceImpact(
  key: V4PoolKey,
  state: V4PoolStateSnapshot,
  token: Token,
  usdg: Token,
  positionSizeUsdgRaw: bigint,
): Promise<PriceImpactEstimate> {
  try {
    const window = state.tickWindow;
    if (window.lowerTick >= window.upperTick) {
      return { ok: false, reason: `tick window is empty or inverted (lowerTick ${window.lowerTick} >= upperTick ${window.upperTick}) -- nothing can be proven complete` };
    }

    // (1) The snapshot must be internally consistent: a tick outside the
    // range the provider says it scanned means the window is not describing
    // the data, and every completeness claim below would be built on it.
    const escaped = state.ticks.find((t) => t.index < window.lowerTick || t.index > window.upperTick);
    if (escaped) {
      return { ok: false, reason: `malformed snapshot -- fetched tick ${escaped.index} lies outside the scanned window [${window.lowerTick}, ${window.upperTick}]` };
    }

    // (2) The simulation starts at the current tick; if that is already
    // outside the scanned range there is no trustworthy ground to start on.
    if (state.tickCurrent < window.lowerTick || state.tickCurrent > window.upperTick) {
      return { ok: false, reason: `current tick ${state.tickCurrent} lies outside the scanned window [${window.lowerTick}, ${window.upperTick}] -- cannot simulate on unfetched data` };
    }

    // (3) Zero-net: a NECESSARY condition only. Non-zero proves truncation
    // cheaply and with a clear message (and pre-empts the SDK's cryptic
    // `ZERO_NET` construction invariant); zero proves nothing on its own --
    // see the cancelling-pair case in this module's doc comment, which only
    // check (4) can catch.
    const netSum = tickNetSum(state.ticks);
    if (state.ticks.length > 0 && netSum !== 0n) {
      return {
        ok: false,
        reason: `fetched tick window is truncated -- liquidityNet across the ${state.ticks.length} fetched ticks sums to ${netSum} instead of 0, meaning some initialized ticks fall outside the fetched range. Cannot safely simulate; widen the tick-fetch window (see poolStateProvider.ts's TICK_BITMAP_WORD_RANGE).`,
      };
    }

    const pool = buildPool(key, state, token, usdg);
    const midPrice = pool.priceOf(token); // USDG per TOKEN
    const usdgAmount = CurrencyAmount.fromRawAmount(usdg, JSBI.BigInt(positionSizeUsdgRaw.toString()));
    const tokenAmountIn = midPrice.invert().quote(usdgAmount);

    const [outputAmount, poolAfter] = await pool.getOutputAmount(tokenAmountIn);

    // (4) The real completeness invariant. The SDK does not throw when the
    // swap walks off the end of the tick list -- it silently carries the
    // current liquidity onward, under-reporting impact. So require the
    // whole walk to have stayed strictly inside the region actually read
    // from the bitmap; anything else was simulated partly on data that was
    // never fetched, and is rejected rather than estimated.
    const walkedLow = Math.min(state.tickCurrent, poolAfter.tickCurrent);
    const walkedHigh = Math.max(state.tickCurrent, poolAfter.tickCurrent);
    if (!spanProvenInsideWindow(walkedLow, walkedHigh, window)) {
      return {
        ok: false,
        reason: `exit simulation could not be proven complete -- the swap walked ticks [${walkedLow}, ${walkedHigh}], leaving the scanned window [${window.lowerTick}, ${window.upperTick}]. Beyond that window the SDK assumes liquidity never changes again, which UNDER-reports impact, so the result is rejected instead of estimated; widen the tick-fetch window (see poolStateProvider.ts's TICK_BITMAP_WORD_RANGE).`,
      };
    }

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
