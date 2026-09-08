import { describe, expect, it } from 'vitest';
import { feesFromGrowth } from '../../src/monitoring/feesFromGrowth';

const Q128 = 1n << 128n;
const UINT256_MAX = (1n << 256n) - 1n;

describe('feesFromGrowth', () => {
  it('returns 0 when liquidity is 0, regardless of growth values', () => {
    expect(feesFromGrowth(1000n, 0n, 0n)).toBe(0n);
  });

  it('computes the normal (non-wrapped) case: liquidity * delta / Q128', () => {
    const liquidity = 1_000_000n;
    const feeGrowthInsideLastX128 = 10n * Q128;
    const feeGrowthInsideX128 = 13n * Q128; // delta = 3 * Q128
    const fees = feesFromGrowth(feeGrowthInsideX128, feeGrowthInsideLastX128, liquidity);
    expect(fees).toBe(liquidity * 3n); // 3 * Q128 / Q128 = 3, * liquidity
  });

  it('returns 0 when nothing has accrued since the last snapshot (delta = 0)', () => {
    const same = 42n * Q128;
    expect(feesFromGrowth(same, same, 1_000_000n)).toBe(0n);
  });

  it('handles uint256 wraparound: feeGrowthInside < feeGrowthInsideLast due to overflow', () => {
    // The pool's fee growth counter wrapped around past UINT256_MAX back
    // near 0 since this position's last snapshot. A naive JS subtraction
    // would go negative and produce garbage; the real (wrapped) delta is
    // small and positive once computed modulo 2^256.
    const feeGrowthInsideLastX128 = UINT256_MAX - 5n * Q128 + 1n; // near the top
    const feeGrowthInsideX128 = 3n * Q128; // wrapped around past 0
    const liquidity = 1_000_000n;

    const fees = feesFromGrowth(feeGrowthInsideX128, feeGrowthInsideLastX128, liquidity);

    // Expected wrapped delta: (feeGrowthInsideX128 - feeGrowthInsideLastX128 + 2^256) mod 2^256
    const expectedDelta = (feeGrowthInsideX128 - feeGrowthInsideLastX128 + (1n << 256n)) % (1n << 256n);
    const expectedFees = (liquidity * expectedDelta) / Q128;

    expect(fees).toBe(expectedFees);
    expect(fees).toBeGreaterThan(0n); // must NOT be negative/garbage from a naive subtraction
  });

  it('a full-range wraparound (last = UINT256_MAX, current = 0) yields exactly a delta of 1', () => {
    const liquidity = 1_000_000n;
    const fees = feesFromGrowth(0n, UINT256_MAX, liquidity);
    // delta = (0 - UINT256_MAX + 2^256) mod 2^256 = 1
    expect(fees).toBe((liquidity * 1n) / Q128); // effectively 0 for any liquidity < Q128, but exercises the exact boundary
  });

  it('never produces a negative result, even for adversarial wrapped inputs', () => {
    const liquidity = 123_456_789n;
    for (const [current, last] of [
      [0n, UINT256_MAX],
      [1n, UINT256_MAX],
      [Q128, UINT256_MAX - Q128 + 1n],
    ] as const) {
      expect(feesFromGrowth(current, last, liquidity)).toBeGreaterThanOrEqual(0n);
    }
  });
});
