import { describe, expect, it } from 'vitest';
import { computeLpRange } from '../../src/strategies/computeLpRange';
import { v3TickMathUtils } from '../../src/blockchain/uniswapSdk';
import type { LpRangeInput } from '../../src/strategies/types';

const { TickMath } = v3TickMathUtils;

const CHAIN_ID = 4663;
// USDG address used consistently with tests/setup.ts's fixture env.
const USDG = '0x2222222222222222222222222222222222222222' as const;
// Sorts AFTER USDG (higher address) -> when used as currency1, USDG is currency0.
const TOKEN_HIGH = '0xffffffffffffffffffffffffffffffffffffffff' as const;
// Sorts BEFORE USDG (lower address) -> when used as currency0, USDG is currency1.
const TOKEN_LOW = '0x0000000000000000000000000000000000000002' as const;

function sqrtAt(tick: number): bigint {
  // getSqrtRatioAtTick takes a plain number (unlike getTickAtSqrtRatio,
  // which takes JSBI) -- easy to mix up, exactly the kind of tick-math
  // slip this whole module is guarding against.
  return BigInt(TickMath.getSqrtRatioAtTick(tick).toString());
}

function baseInput(overrides: Partial<LpRangeInput> = {}): LpRangeInput {
  const tickCurrent = overrides.tickCurrent ?? 0;
  return {
    sqrtPriceX96: overrides.sqrtPriceX96 ?? sqrtAt(tickCurrent),
    tickCurrent,
    tickSpacing: 60,
    currency0: TOKEN_LOW,
    currency1: USDG,
    decimals0: 18,
    decimals1: 18,
    chainId: CHAIN_ID,
    ...overrides,
  };
}

describe('computeLpRange -- orientation (the critical, explicitly-requested check)', () => {
  it('USDG as currency1: range sits at/below current tick, tickUpper strictly < tickCurrent', () => {
    const result = computeLpRange(baseInput({ currency0: TOKEN_LOW, currency1: USDG, tickCurrent: 0 }));
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.tickLower).toBeLessThan(result.tickUpper);
      expect(result.tickUpper).toBeLessThan(0);
      expect(result.diagnostics.usdgIsCurrency0).toBe(false);
    }
  });

  it('USDG as currency0: range sits at/above current tick, tickLower strictly > tickCurrent', () => {
    const result = computeLpRange(baseInput({ currency0: USDG, currency1: TOKEN_HIGH, tickCurrent: 0 }));
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.tickLower).toBeLessThan(result.tickUpper);
      expect(result.tickLower).toBeGreaterThan(0);
      expect(result.diagnostics.usdgIsCurrency0).toBe(true);
    }
  });

  it('both orientations of the SAME real-world price produce identical human-readable prices', () => {
    // tick 0 (price ratio 1:1) is its own inverse -- the one point where
    // using the identical tickCurrent for both orientations genuinely
    // represents the same real-world price in both cases (for any other
    // tick T, "USDG=currency1 at tick T" and "USDG=currency0 at tick T"
    // are actual INVERSES of each other, not the same price, so comparing
    // them directly would be comparing two different scenarios). This
    // still fully exercises the orientation branch: any asymmetry in the
    // Case A vs Case B logic would still surface as a mismatch here.
    const tickCurrent = 0;
    const asCurrency1 = computeLpRange(
      baseInput({ currency0: TOKEN_LOW, currency1: USDG, tickCurrent, sqrtPriceX96: sqrtAt(tickCurrent) }),
    );
    const asCurrency0 = computeLpRange(
      baseInput({ currency0: USDG, currency1: TOKEN_HIGH, tickCurrent, sqrtPriceX96: sqrtAt(tickCurrent) }),
    );
    expect(asCurrency1.ok).toBe(true);
    expect(asCurrency0.ok).toBe(true);
    if (asCurrency1.ok && asCurrency0.ok) {
      expect(asCurrency1.diagnostics.entryPriceUsdgPerToken).toBe(asCurrency0.diagnostics.entryPriceUsdgPerToken);
      expect(asCurrency1.diagnostics.lowerPriceUsdgPerToken).toBe(asCurrency0.diagnostics.lowerPriceUsdgPerToken);
      expect(asCurrency1.diagnostics.upperPriceUsdgPerToken).toBe(asCurrency0.diagnostics.upperPriceUsdgPerToken);
    }
  });

  it('rejects a pool where neither currency matches the configured USDG address', () => {
    const result = computeLpRange(
      baseInput({ currency0: TOKEN_LOW, currency1: TOKEN_HIGH, tickCurrent: 0 }),
    );
    expect(result.ok).toBe(false);
  });
});

describe('computeLpRange -- lower price ~= 0.5x entry, upper price ~= entry, for both orientations', () => {
  it.each([
    { label: 'USDG=currency1', currency0: TOKEN_LOW, currency1: USDG },
    { label: 'USDG=currency0', currency0: USDG, currency1: TOKEN_HIGH },
  ])('$label', ({ currency0, currency1 }) => {
    const result = computeLpRange(baseInput({ currency0, currency1, tickCurrent: 0, tickSpacing: 10 }));
    expect(result.ok).toBe(true);
    if (result.ok) {
      const entry = Number(result.diagnostics.entryPriceUsdgPerToken);
      const lower = Number(result.diagnostics.lowerPriceUsdgPerToken);
      const upper = Number(result.diagnostics.upperPriceUsdgPerToken);
      expect(lower).toBeLessThan(upper);
      // H18/M1 fix: tightened from toBeCloseTo(0.5, 1) (accepts anything in
      // [0.45, 0.55] -- loose enough to have passed even the PROVEN bug of
      // 0.548828x at coarse tickSpacing) to a real, meaningful bound: the
      // strategy's actual guarantee is "AT LEAST 50% below entry" (more
      // downside room is fine, less is not), so lower/entry must be <= 0.5
      // (never above -- that would be the bug) and, at this fine
      // tickSpacing=10, close enough to 0.5 that rounding error is negligible.
      expect(lower / entry).toBeLessThanOrEqual(0.5);
      expect(lower / entry).toBeGreaterThan(0.49);
      expect(upper / entry).toBeLessThan(1); // strictly below entry, per spec
      expect(upper / entry).toBeGreaterThan(0.95); // but close to it (fine spacing here)
    }
  });
});

describe('computeLpRange -- H18/M1 regression: the 50%-below-entry guarantee holds even at COARSE tickSpacing', () => {
  it.each([
    { label: 'USDG=currency1', currency0: TOKEN_LOW, currency1: USDG },
    { label: 'USDG=currency0', currency0: USDG, currency1: TOKEN_HIGH },
  ])('$label: lower/entry is NEVER above 0.5, even at tickSpacing=2000 where nearestUsableTick used to overshoot to ~0.548828', ({ currency0, currency1 }) => {
    const result = computeLpRange(baseInput({ currency0, currency1, tickCurrent: 0, tickSpacing: 2000 }));
    expect(result.ok).toBe(true);
    if (result.ok) {
      const entry = Number(result.diagnostics.entryPriceUsdgPerToken);
      const lower = Number(result.diagnostics.lowerPriceUsdgPerToken);
      // The real, proven bug: nearestUsableTick rounded to 0.548828x here
      // (MORE than 50%, i.e. LESS downside room than promised). The fix
      // must never exceed 0.5 -- it may be conservatively below it
      // (more room is safe), but never above.
      expect(lower / entry).toBeLessThanOrEqual(0.5);
    }
  });
});

describe('computeLpRange -- tick spacing coverage', () => {
  it.each([1, 10, 60, 200, 644, 137])('produces a valid, tickSpacing-aligned range for spacing=%i', (tickSpacing) => {
    const result = computeLpRange(baseInput({ tickCurrent: 0, tickSpacing }));
    expect(result.ok).toBe(true);
    if (result.ok) {
      // `=== 0` rather than `.toBe(0)`: JS's `%` can return `-0` for an
      // exact negative multiple, and `toBe` uses `Object.is`, which treats
      // -0 !== 0 -- a test-harness quirk, not a bug in the alignment check.
      expect(result.tickLower % tickSpacing === 0).toBe(true);
      expect(result.tickUpper % tickSpacing === 0).toBe(true);
      expect(result.tickLower).toBeLessThan(result.tickUpper);
    }
  });

  it('rejects (ok: false, not a throw) when tickSpacing is too large relative to the 50% range', () => {
    const result = computeLpRange(baseInput({ tickCurrent: 0, tickSpacing: TickMath.MAX_TICK }));
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.reason).toMatch(/degenerate|tickSpacing/i);
    }
  });
});

describe('computeLpRange -- negative current tick (guards the class of bug found in Module 3)', () => {
  it.each([
    { label: 'USDG=currency1', currency0: TOKEN_LOW, currency1: USDG },
    { label: 'USDG=currency0', currency0: USDG, currency1: TOKEN_HIGH },
  ])('handles a deeply negative current tick correctly for $label', ({ currency0, currency1 }) => {
    const tickCurrent = -123456;
    const result = computeLpRange(
      baseInput({ currency0, currency1, tickCurrent, tickSpacing: 644, sqrtPriceX96: sqrtAt(tickCurrent) }),
    );
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.tickLower % 644 === 0).toBe(true);
      expect(result.tickUpper % 644 === 0).toBe(true);
      expect(result.tickLower).toBeLessThan(result.tickUpper);
      expect(result.tickLower).toBeGreaterThanOrEqual(TickMath.MIN_TICK);
      expect(result.tickUpper).toBeLessThanOrEqual(TickMath.MAX_TICK);
    }
  });

  it('still enforces the strict-direction rule near a negative current tick', () => {
    const currency1IsUsdg = computeLpRange(
      baseInput({ currency0: TOKEN_LOW, currency1: USDG, tickCurrent: -60, tickSpacing: 60, sqrtPriceX96: sqrtAt(-60) }),
    );
    expect(currency1IsUsdg.ok).toBe(true);
    if (currency1IsUsdg.ok) expect(currency1IsUsdg.tickUpper).toBeLessThan(-60);

    const currency0IsUsdg = computeLpRange(
      baseInput({ currency0: USDG, currency1: TOKEN_HIGH, tickCurrent: -60, tickSpacing: 60, sqrtPriceX96: sqrtAt(-60) }),
    );
    expect(currency0IsUsdg.ok).toBe(true);
    if (currency0IsUsdg.ok) expect(currency0IsUsdg.tickLower).toBeGreaterThan(-60);
  });
});

describe('computeLpRange -- decimals', () => {
  it('produces a sane human-readable price for a 9-decimal token paired with 18-decimal USDG', () => {
    const tickCurrent = 200000;
    const result = computeLpRange(
      baseInput({ tickCurrent, sqrtPriceX96: sqrtAt(tickCurrent), decimals0: 9, decimals1: 18, tickSpacing: 200 }),
    );
    expect(result.ok).toBe(true);
    if (result.ok) {
      const entry = Number(result.diagnostics.entryPriceUsdgPerToken);
      // Sanity bound: with mismatched decimals handled correctly, price
      // should be a normal-looking number, not off by a factor of 10^9.
      expect(entry).toBeGreaterThan(0.001);
      expect(entry).toBeLessThan(1000);
    }
  });

  it('never lets decimals affect tickLower/tickUpper themselves (decimal-agnostic core math)', () => {
    const tickCurrent = 50000;
    const with18 = computeLpRange(
      baseInput({ tickCurrent, sqrtPriceX96: sqrtAt(tickCurrent), decimals0: 18, decimals1: 18 }),
    );
    const with9 = computeLpRange(
      baseInput({ tickCurrent, sqrtPriceX96: sqrtAt(tickCurrent), decimals0: 9, decimals1: 18 }),
    );
    expect(with18.ok).toBe(true);
    expect(with9.ok).toBe(true);
    if (with18.ok && with9.ok) {
      expect(with18.tickLower).toBe(with9.tickLower);
      expect(with18.tickUpper).toBe(with9.tickUpper);
    }
  });

  it('rejects invalid decimals rather than silently assuming 18', () => {
    const result = computeLpRange(baseInput({ decimals0: -1 }));
    expect(result.ok).toBe(false);
  });
});

describe('computeLpRange -- explicit validation, never trusts rounding blindly', () => {
  it('rejects an out-of-bounds tickCurrent', () => {
    // sqrtPriceX96 explicitly supplied (rather than derived from the
    // deliberately out-of-range tickCurrent) since deriving it would
    // itself throw in the test fixture, before ever reaching the
    // function's own validation this test is targeting.
    const result = computeLpRange(baseInput({ tickCurrent: TickMath.MAX_TICK + 1, sqrtPriceX96: sqrtAt(0) }));
    expect(result.ok).toBe(false);
  });

  it('rejects a non-integer tickSpacing', () => {
    const result = computeLpRange(baseInput({ tickSpacing: 1.5 }));
    expect(result.ok).toBe(false);
  });

  it('rejects a zero or negative tickSpacing', () => {
    expect(computeLpRange(baseInput({ tickSpacing: 0 })).ok).toBe(false);
    expect(computeLpRange(baseInput({ tickSpacing: -60 })).ok).toBe(false);
  });

  it('rejects a non-positive sqrtPriceX96', () => {
    expect(computeLpRange(baseInput({ sqrtPriceX96: 0n })).ok).toBe(false);
  });

  it('never throws for extreme current ticks near MIN/MAX bounds -- returns ok:false instead', () => {
    const nearMax = TickMath.MAX_TICK - 5;
    expect(() =>
      computeLpRange(baseInput({ tickCurrent: nearMax, sqrtPriceX96: sqrtAt(nearMax), tickSpacing: 60 })),
    ).not.toThrow();

    const nearMin = TickMath.MIN_TICK + 5;
    expect(() =>
      computeLpRange(baseInput({ tickCurrent: nearMin, sqrtPriceX96: sqrtAt(nearMin), tickSpacing: 60 })),
    ).not.toThrow();
  });
});
