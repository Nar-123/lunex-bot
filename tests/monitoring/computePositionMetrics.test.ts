import { describe, expect, it } from 'vitest';
import { Token } from '@uniswap/sdk-core';
import { computePositionMetrics } from '../../src/monitoring/computePositionMetrics';
import { v3TickMathUtils, v4Sdk } from '../../src/blockchain/uniswapSdk';
import type { PositionRecord } from '../../src/positions/types';
import type { LivePositionState, PoolPriceState } from '../../src/monitoring/types';
import { config } from '../../src/config';

const { TickMath } = v3TickMathUtils;
const CHAIN_ID = 4663;
// Matches tests/setup.ts's fixture USDG address.
const USDG_ADDR = '0x2222222222222222222222222222222222222222';
const TOKEN_LOW = '0x0000000000000000000000000000000000000002'; // sorts before USDG -> currency0=TOKEN
const TOKEN_HIGH = '0xffffffffffffffffffffffffffffffffffffffff'; // sorts after USDG -> currency1=TOKEN

function sqrtAt(tick: number): bigint {
  return BigInt(TickMath.getSqrtRatioAtTick(tick).toString());
}

const ENTRY_TICK = 0;
const ENTRY_USDG_RAW = 1_000n * 10n ** 18n;

/**
 * Mirrors strategies/computeLpRange.ts's Case A / Case B exactly: when
 * USDG=currency1, a single-sided-USDG range sits BELOW the entry tick
 * ([-6960, -60]); when USDG=currency0, the raw ratio is inverted, so the
 * equivalent range sits ABOVE the entry tick ([60, 6960]). Reusing the
 * SAME range for both orientations (an earlier version of this test did
 * that) is wrong -- it silently makes the "USDG=currency0" fixture 100%
 * TOKEN at entry instead of 100% USDG, which produced nonsensical
 * (~1e56) results. Caught by actually deriving liquidity via the SDK's
 * own `fromAmount0`/`fromAmount1` and checking it against the entry
 * value, rather than a placeholder liquidity number.
 */
function rangeFor(usdgIsCurrency0: boolean): { tickLower: number; tickUpper: number } {
  return usdgIsCurrency0 ? { tickLower: 60, tickUpper: 6960 } : { tickLower: -6960, tickUpper: -60 };
}

/** The scenario ticks below mirror sign depending on orientation, for the same reason. */
function scenarioTicks(usdgIsCurrency0: boolean) {
  // Case A (USDG=currency1): range sits BELOW zero (tickLower=-6960), and
  // the USDG side is tick >= tickUpper -- i.e. the POSITIVE direction.
  // Case B (USDG=currency0): range sits ABOVE zero (tickLower=60), and
  // the USDG side is tick < tickLower -- the NEGATIVE direction.
  // So `aboveEntry` (moving further away on the USDG side) and
  // `intoRange`/`belowLower*` (moving into/through the range, the
  // opposite direction) deliberately use OPPOSITE signs -- conflating
  // them into one "sign" variable is exactly the bug an earlier version
  // of this helper had.
  const rangeSign = usdgIsCurrency0 ? 1 : -1;
  return {
    aboveEntry: -rangeSign * 6000,
    intoRange: rangeSign * 3000,
    belowLower: rangeSign * 7000,
    belowLowerFurther: rangeSign * 8000,
  };
}

function deriveEntryLiquidity(usdgIsCurrency0: boolean): bigint {
  const { tickLower, tickUpper } = rangeFor(usdgIsCurrency0);
  const usdgToken = new Token(CHAIN_ID, USDG_ADDR, 18, 'USDG');
  const otherToken = new Token(CHAIN_ID, usdgIsCurrency0 ? TOKEN_HIGH : TOKEN_LOW, 18, 'TOKEN');
  const currency0 = usdgIsCurrency0 ? usdgToken : otherToken;
  const currency1 = usdgIsCurrency0 ? otherToken : usdgToken;
  const poolAtEntry = new v4Sdk.Pool(
    currency0,
    currency1,
    30000,
    60,
    '0x0000000000000000000000000000000000000000',
    sqrtAt(ENTRY_TICK).toString(),
    '0',
    ENTRY_TICK,
  );
  const derived = usdgIsCurrency0
    ? v4Sdk.Position.fromAmount0({ pool: poolAtEntry, tickLower, tickUpper, amount0: ENTRY_USDG_RAW.toString(), useFullPrecision: true })
    : v4Sdk.Position.fromAmount1({ pool: poolAtEntry, tickLower, tickUpper, amount1: ENTRY_USDG_RAW.toString() });
  return BigInt(derived.liquidity.toString());
}

function makePosition(usdgIsCurrency0: boolean, overrides: Partial<PositionRecord> = {}): PositionRecord {
  const { tickLower, tickUpper } = rangeFor(usdgIsCurrency0);
  return {
    id: 'pos-1',
    tokenAddress: (usdgIsCurrency0 ? TOKEN_HIGH : TOKEN_LOW) as `0x${string}`,
    tokenSymbol: 'MEME',
    tokenDecimals: 18,
    pool: {
      poolId: '0xaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa',
      currency0: (usdgIsCurrency0 ? USDG_ADDR : TOKEN_LOW) as `0x${string}`,
      currency1: (usdgIsCurrency0 ? TOKEN_HIGH : USDG_ADDR) as `0x${string}`,
      fee: 30000,
      tickSpacing: 60,
      hooks: '0x0000000000000000000000000000000000000000',
    },
    tickLower,
    tickUpper,
    positionTokenId: '1',
    entryUsdgRaw: ENTRY_USDG_RAW,
    entrySqrtPriceX96: sqrtAt(ENTRY_TICK),
    entryTick: ENTRY_TICK,
    status: 'ACTIVE',
    openIdempotencyKey: 'k',
    closeIdempotencyKey: null,
    openedAt: new Date(),
    closedAt: null,
    closeReason: null,
    realizedUsdgRaw: null,
    ...overrides,
  };
}

const NO_FEES: LivePositionState = { liquidity: 0n, tokensOwed0: 0n, tokensOwed1: 0n };

describe.each([
  { label: 'USDG = currency1', usdgIsCurrency0: false },
  { label: 'USDG = currency0', usdgIsCurrency0: true },
])('computePositionMetrics -- $label', ({ usdgIsCurrency0 }) => {
  const liquidity = deriveEntryLiquidity(usdgIsCurrency0);
  const position = makePosition(usdgIsCurrency0);
  const ticks = scenarioTicks(usdgIsCurrency0);

  it('at the unchanged entry price, value exactly matches entry and pnlPct is 0', () => {
    const poolPrice: PoolPriceState = { sqrtPriceX96: sqrtAt(ENTRY_TICK), tickCurrent: ENTRY_TICK };
    const result = computePositionMetrics(position, { ...NO_FEES, liquidity }, poolPrice);
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.pnlPct).toBe(0);
      // Within rounding of the derived liquidity -- not bit-exact.
      expect(Number(result.currentValueUsdgRaw)).toBeCloseTo(Number(ENTRY_USDG_RAW), -12);
      expect(result.inRange).toBe(false); // range sits strictly on the far side of entry price, by design (Module 4)
    }
  });

  it('is still 100% USDG-side (pnlPct 0) further from the range, on the USDG side', () => {
    const poolPrice: PoolPriceState = { sqrtPriceX96: sqrtAt(ticks.aboveEntry), tickCurrent: ticks.aboveEntry };
    const result = computePositionMetrics(position, { ...NO_FEES, liquidity }, poolPrice);
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.pnlPct).toBe(0);
      expect(result.inRange).toBe(false);
    }
  });

  it('reports inRange:true and a bounded loss once price moves into the range', () => {
    const poolPrice: PoolPriceState = { sqrtPriceX96: sqrtAt(ticks.intoRange), tickCurrent: ticks.intoRange };
    const result = computePositionMetrics(position, { ...NO_FEES, liquidity }, poolPrice);
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.inRange).toBe(true);
      // Loss must be strictly between 0% and the full raw price-move
      // percentage -- impermanent-loss-like behavior, never worse than
      // holding 100% token through the same move.
      expect(result.pnlPct).toBeLessThan(0);
      expect(result.pnlPct).toBeGreaterThan(-0.26); // raw price moved ~26%
    }
  });

  it('past the far side of the range, the position is 100% token and its raw token amount stops changing further', () => {
    const poolPrice1: PoolPriceState = { sqrtPriceX96: sqrtAt(ticks.belowLower), tickCurrent: ticks.belowLower };
    const poolPrice2: PoolPriceState = { sqrtPriceX96: sqrtAt(ticks.belowLowerFurther), tickCurrent: ticks.belowLowerFurther };
    const r1 = computePositionMetrics(position, { ...NO_FEES, liquidity }, poolPrice1);
    const r2 = computePositionMetrics(position, { ...NO_FEES, liquidity }, poolPrice2);
    expect(r1.ok).toBe(true);
    expect(r2.ok).toBe(true);
    if (r1.ok && r2.ok) {
      expect(r1.inRange).toBe(false);
      expect(r2.inRange).toBe(false);
      // Price moved further away with a fixed token amount past the range
      // -> value must be strictly lower, and pnlPct more negative.
      expect(r2.currentValueUsdgRaw).toBeLessThan(r1.currentValueUsdgRaw);
      expect(r2.pnlPct).toBeLessThan(r1.pnlPct);
    }
  });

  it('converts uncollected fees on both sides into a single USDG-denominated feesEarnedUsdgRaw', () => {
    const poolPrice: PoolPriceState = { sqrtPriceX96: sqrtAt(ENTRY_TICK), tickCurrent: ENTRY_TICK };
    const live: LivePositionState = usdgIsCurrency0
      ? { liquidity, tokensOwed0: 5n * 10n ** 18n, tokensOwed1: 0n } // owed directly in USDG
      : { liquidity, tokensOwed0: 0n, tokensOwed1: 5n * 10n ** 18n };
    const result = computePositionMetrics(position, live, poolPrice);
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.feesEarnedUsdgRaw).toBe(5n * 10n ** 18n); // at entry price 1:1, no conversion needed
      expect(result.yieldPct).toBeCloseTo(0.005, 5); // 5 / 1000
    }
  });

  it('rejects a pool where neither currency matches the configured USDG address', () => {
    const badPosition = makePosition(usdgIsCurrency0, {
      pool: { ...position.pool, currency0: TOKEN_LOW as `0x${string}`, currency1: TOKEN_HIGH as `0x${string}` },
    });
    const poolPrice: PoolPriceState = { sqrtPriceX96: sqrtAt(ENTRY_TICK), tickCurrent: ENTRY_TICK };
    const result = computePositionMetrics(badPosition, { ...NO_FEES, liquidity }, poolPrice);
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.positionId).toBe('pos-1');
  });
});

describe('computePositionMetrics -- both orientations agree on the same real-world scenario', () => {
  it('produce the same human-readable prices and pnlPct for a mirrored setup', () => {
    const liqA = deriveEntryLiquidity(false);
    const liqB = deriveEntryLiquidity(true);
    const posA = makePosition(false);
    const posB = makePosition(true);
    const tickA = scenarioTicks(false).intoRange;
    const tickB = scenarioTicks(true).intoRange;

    const resultA = computePositionMetrics(posA, { ...NO_FEES, liquidity: liqA }, { sqrtPriceX96: sqrtAt(tickA), tickCurrent: tickA });
    const resultB = computePositionMetrics(posB, { ...NO_FEES, liquidity: liqB }, { sqrtPriceX96: sqrtAt(tickB), tickCurrent: tickB });

    expect(resultA.ok).toBe(true);
    expect(resultB.ok).toBe(true);
    if (resultA.ok && resultB.ok) {
      expect(resultA.currentPriceUsdgPerToken).toBe(resultB.currentPriceUsdgPerToken);
      expect(resultA.pnlPct).toBeCloseTo(resultB.pnlPct, 6);
    }
  });
});

describe('computePositionMetrics -- Phase 12G: display-price fields genuinely track config.quoteAsset.DECIMALS (6), not a stale 18', () => {
  /**
   * `currentPriceUsdgPerToken`/`entryPriceUsdgPerToken` are the ONE part of
   * this function's output actually affected by the USDG decimals bug (see
   * Phase 12F/12G's finding): `pnlPct`/`currentValueUsdgRaw`/`feesEarnedUsdgRaw`
   * are all raw-bigint/`.quote()`-derived and proven decimals-agnostic
   * (`@uniswap/sdk-core`'s `CurrencyAmount.add/subtract/multiply/divide`
   * never touch `decimalScale` -- only `.toSignificant()`/`.toFixed()`/
   * `.toExact()` do), but `.toSignificant()` on a `Price` DOES apply
   * `baseCurrency.decimals`/`quoteCurrency.decimals` via its `scalar`
   * getter (`@uniswap/sdk-core`'s `price.js`) -- exactly what
   * `computePositionMetrics.ts` calls for these two fields. This
   * independently re-derives the SAME price via the SDK's own
   * `tickToPrice`, once at the REAL config decimals (6) and once at the
   * old wrong default (18), to prove the production function's output
   * matches the correct one and would have been ~10^12x off under the old
   * default -- not a tautological re-statement of the production code.
   */
  it('matches an independently-computed decimals=6 price, and would differ from a decimals=18 computation by ~10^12x', () => {
    expect(config.quoteAsset.DECIMALS).toBe(6);
    const usdgIsCurrency0 = false;
    const liquidity = deriveEntryLiquidity(usdgIsCurrency0);
    const position = makePosition(usdgIsCurrency0);
    const poolPrice: PoolPriceState = { sqrtPriceX96: sqrtAt(ENTRY_TICK), tickCurrent: ENTRY_TICK };

    const result = computePositionMetrics(position, { ...NO_FEES, liquidity }, poolPrice);
    expect(result.ok).toBe(true);
    if (!result.ok) return;

    const otherToken = new Token(CHAIN_ID, TOKEN_LOW, position.tokenDecimals, 'TOKEN');
    const usdgTokenCorrect = new Token(CHAIN_ID, USDG_ADDR, 6, 'USDG');
    const usdgTokenWrong = new Token(CHAIN_ID, USDG_ADDR, 18, 'USDG');
    const priceCorrect = v4Sdk.tickToPrice(otherToken, usdgTokenCorrect, ENTRY_TICK).toSignificant(6);
    const priceWrong = v4Sdk.tickToPrice(otherToken, usdgTokenWrong, ENTRY_TICK).toSignificant(6);

    // The production function (reading the REAL, now-fixed config.quoteAsset.DECIMALS=6) must match the independently-computed decimals=6 price exactly.
    expect(result.currentPriceUsdgPerToken).toBe(priceCorrect);

    // And that correct price must differ from what an 18-decimals build
    // would have shown by ~10^12x -- proving this field genuinely was (and
    // without the fix, would still be) broken by the exact magnitude found
    // in Phase 12F, not a cosmetic rounding difference. Direction: USDG is
    // the QUOTE currency here (`Price.scalar = 10^base.decimals /
    // 10^quote.decimals`), so a too-HIGH configured quote decimals (18 vs
    // the real 6) makes the wrong price SMALLER, not larger.
    const ratio = Number(priceCorrect) / Number(priceWrong);
    expect(ratio).toBeGreaterThan(1e11);
    expect(ratio).toBeLessThan(1e13);
  });
});
