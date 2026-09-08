import { describe, expect, it } from 'vitest';
import { checkMarketCap } from '../../src/filters/rules/marketCap';
import { makeCandidateToken } from '../fixtures/candidateToken';

describe('checkMarketCap', () => {
  it('passes at exactly the $1,000,000 minimum', () => {
    const result = checkMarketCap(makeCandidateToken({ marketCapUsd: 1_000_000 }));
    expect(result.passed).toBe(true);
  });

  it('passes above the minimum', () => {
    const result = checkMarketCap(makeCandidateToken({ marketCapUsd: 5_000_000 }));
    expect(result.passed).toBe(true);
  });

  it('fails just below the minimum', () => {
    const result = checkMarketCap(makeCandidateToken({ marketCapUsd: 999_999 }));
    expect(result.passed).toBe(false);
  });

  it('fails at zero', () => {
    const result = checkMarketCap(makeCandidateToken({ marketCapUsd: 0 }));
    expect(result.passed).toBe(false);
  });
});
