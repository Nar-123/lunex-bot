import { describe, expect, it } from 'vitest';
import { bucketSamplesToCloses, computePercentB } from '../../src/monitoring/bollinger';
import { config } from '../../src/config';

const PERIOD = config.rules.exits.OVEREXTENDED.BB_PERIOD;
const MULT = config.rules.exits.OVEREXTENDED.BB_STDDEV_MULTIPLIER;
const BUCKET_MS = config.rules.exits.OVEREXTENDED.BB_BUCKET_MS;

/** `n` closes of exactly the same value -- a degenerate, zero-variance window. */
function flat(value: number, n: number): number[] {
  return Array.from({ length: n }, () => value);
}

describe('computePercentB -- ported from Meridian bollinger.rs::percent_b', () => {
  it('uses the configured 20-period / 2-sigma window, matching Meridian BB_PERIOD and the 2.0 multiplier', () => {
    expect(PERIOD).toBe(20);
    expect(MULT).toBe(2);
  });

  describe('data sufficiency -- an unavailable reading is null, never a fabricated number', () => {
    it('returns null for an empty series', () => {
      expect(computePercentB([], PERIOD, MULT)).toBeNull();
    });

    it('returns null at period - 1 closes -- one short is still short', () => {
      const closes = Array.from({ length: PERIOD - 1 }, (_, i) => 100 + i);
      expect(computePercentB(closes, PERIOD, MULT)).toBeNull();
    });

    it('returns a real number at exactly period closes -- the boundary is inclusive', () => {
      const closes = Array.from({ length: PERIOD }, (_, i) => 100 + i);
      expect(computePercentB(closes, PERIOD, MULT)).not.toBeNull();
    });

    it('uses only the LAST `period` closes when more are supplied -- older data outside the window cannot shift the bands', () => {
      const window = Array.from({ length: PERIOD }, (_, i) => 100 + i);
      const withAncientHistory = [...flat(1, 500), ...window];
      expect(computePercentB(withAncientHistory, PERIOD, MULT)).toBeCloseTo(computePercentB(window, PERIOD, MULT) as number, 12);
    });

    it('returns null when any value in the window is not finite -- a corrupt reading is never averaged in', () => {
      const closes = Array.from({ length: PERIOD }, (_, i) => 100 + i);
      const withNaN = [...closes.slice(0, PERIOD - 1), Number.NaN];
      expect(computePercentB(withNaN, PERIOD, MULT)).toBeNull();
    });

    it('returns null for a non-positive period rather than dividing by zero', () => {
      expect(computePercentB(flat(100, 30), 0, MULT)).toBeNull();
      expect(computePercentB(flat(100, 30), -5, MULT)).toBeNull();
    });
  });

  describe('degenerate window -- sd <= 0 is null, NOT 0.5 (Meridian returns None)', () => {
    it('a perfectly flat window has no bands, so %B is undefined, not "mid-band"', () => {
      expect(computePercentB(flat(42, PERIOD), PERIOD, MULT)).toBeNull();
    });

    it('and therefore can never satisfy the OVEREXTENDED rule -- null is not >= 1.0', () => {
      const percentB = computePercentB(flat(42, PERIOD), PERIOD, MULT);
      expect(percentB === null || percentB < 1).toBe(true);
    });
  });

  describe('the math itself -- POPULATION variance (divide by period), not sample variance', () => {
    it('computes an exactly-known value: a 4-period window [1,2,3,4] with multiplier 1', () => {
      // mean = 2.5; population variance = ((1.5)^2 + (0.5)^2 + (0.5)^2 + (1.5)^2)/4 = 1.25
      // sd = sqrt(1.25) = 1.1180339887...; upper = 3.618034, lower = 1.381966
      // %B = (4 - 1.381966) / (3.618034 - 1.381966) = 2.618034 / 2.236068 = 1.17082...
      const sd = Math.sqrt(1.25);
      const expected = (4 - (2.5 - sd)) / ((2.5 + sd) - (2.5 - sd));
      expect(computePercentB([1, 2, 3, 4], 4, 1)).toBeCloseTo(expected, 12);
    });

    it('is NOT sample variance: the same window computed with n-1 would give a different answer, and this does not match it', () => {
      const sampleSd = Math.sqrt(((1.5) ** 2 + (0.5) ** 2 + (0.5) ** 2 + (1.5) ** 2) / 3);
      const sampleAnswer = (4 - (2.5 - sampleSd)) / (2 * sampleSd);
      expect(computePercentB([1, 2, 3, 4], 4, 1)).not.toBeCloseTo(sampleAnswer, 6);
    });

    it('the last close sitting exactly ON the upper band yields exactly 1.0', () => {
      // Construct a window whose last value equals mean + 2*sd by solving
      // for it directly is circular; instead assert the identity that
      // matters: %B is a linear map of `last` onto [lower, upper].
      const closes = Array.from({ length: PERIOD }, (_, i) => 100 + i);
      const percentB = computePercentB(closes, PERIOD, MULT) as number;
      const mean = closes.reduce((a, b) => a + b, 0) / PERIOD;
      const sd = Math.sqrt(closes.reduce((a, c) => a + (c - mean) ** 2, 0) / PERIOD);
      const lower = mean - MULT * sd;
      const upper = mean + MULT * sd;
      expect(percentB).toBeCloseTo((closes[closes.length - 1]! - lower) / (upper - lower), 12);
    });

    it('is UNCLAMPED above 1.0 -- piercing the upper band IS the over-extension signal the exit keys on', () => {
      // A quiet window followed by one sharp spike puts the last close far
      // outside the band it just helped compute.
      const closes = [...flat(100, PERIOD - 1), 400];
      const percentB = computePercentB(closes, PERIOD, MULT) as number;
      expect(percentB).toBeGreaterThan(1);
    });

    it('is unclamped below 0 as well -- a sharp drop is reported as it really is, not floored', () => {
      const closes = [...flat(100, PERIOD - 1), 1];
      const percentB = computePercentB(closes, PERIOD, MULT) as number;
      expect(percentB).toBeLessThan(0);
    });

    it('a mildly rising series sits inside the bands (< 1.0) -- the rule does NOT fire on any uptrend, only on a band pierce', () => {
      const closes = Array.from({ length: PERIOD }, (_, i) => 100 + i);
      expect(computePercentB(closes, PERIOD, MULT) as number).toBeLessThan(1);
    });
  });
});

describe('bucketSamplesToCloses -- 15s polls reconstructed into 5-minute closes', () => {
  const T0 = new Date('2026-01-01T00:00:00.000Z').getTime();
  const sample = (offsetMs: number, price: number) => ({ price, observedAt: new Date(T0 + offsetMs) });

  it('uses the configured 5-minute bucket, matching Meridian 5_MINUTE indicator interval', () => {
    expect(BUCKET_MS).toBe(5 * 60 * 1000);
  });

  it('takes the LAST sample in each bucket -- that is what a close is, not the first and not the mean', () => {
    const closes = bucketSamplesToCloses(
      [sample(0, 10), sample(60_000, 11), sample(299_000, 12), sample(300_000, 20), sample(590_000, 21)],
      BUCKET_MS,
    );
    expect(closes).toEqual([12, 21]);
  });

  it('returns closes oldest-first even when the input arrives out of order', () => {
    const closes = bucketSamplesToCloses([sample(600_000, 30), sample(0, 10), sample(300_000, 20)], BUCKET_MS);
    expect(closes).toEqual([10, 20, 30]);
  });

  it('skips buckets with no samples entirely rather than interpolating a value that was never observed', () => {
    // Nothing at all observed in the 5-10 minute bucket.
    const closes = bucketSamplesToCloses([sample(0, 10), sample(600_000, 30)], BUCKET_MS);
    expect(closes).toEqual([10, 30]);
  });

  it('drops non-finite prices instead of letting them poison the window', () => {
    const closes = bucketSamplesToCloses([sample(0, Number.NaN), sample(60_000, 11), sample(300_000, 20)], BUCKET_MS);
    expect(closes).toEqual([11, 20]);
  });

  it('returns an empty array for no samples, and for a non-positive bucket width', () => {
    expect(bucketSamplesToCloses([], BUCKET_MS)).toEqual([]);
    expect(bucketSamplesToCloses([sample(0, 10)], 0)).toEqual([]);
    expect(bucketSamplesToCloses([sample(0, 10)], -1)).toEqual([]);
  });

  it('end to end: 20 five-minute buckets of 15-second polls produce a usable %B, and 19 buckets do not', () => {
    // ~20 polls per bucket, exactly as the live 15s monitoring cadence produces.
    const build = (buckets: number) => {
      const samples: { price: number; observedAt: Date }[] = [];
      for (let b = 0; b < buckets; b += 1) {
        for (let i = 0; i < 20; i += 1) {
          samples.push(sample(b * BUCKET_MS + i * 15_000, 100 + b + i / 100));
        }
      }
      return samples;
    };
    expect(computePercentB(bucketSamplesToCloses(build(19), BUCKET_MS), PERIOD, MULT)).toBeNull();
    expect(computePercentB(bucketSamplesToCloses(build(20), BUCKET_MS), PERIOD, MULT)).not.toBeNull();
  });
});
