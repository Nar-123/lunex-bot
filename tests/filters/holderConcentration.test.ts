import { describe, expect, it } from 'vitest';
import { checkHolderConcentration } from '../../src/filters/rules/holderConcentration';
import { makeCandidateToken } from '../fixtures/candidateToken';

describe('checkHolderConcentration', () => {
  it('passes well below 40%', () => {
    expect(checkHolderConcentration(makeCandidateToken({ top10HolderConcentrationPct: 0.1 })).passed).toBe(true);
  });

  it('passes just below 40%', () => {
    expect(checkHolderConcentration(makeCandidateToken({ top10HolderConcentrationPct: 0.3999 })).passed).toBe(true);
  });

  it('fails at exactly 40% (must be strictly < 40%)', () => {
    expect(checkHolderConcentration(makeCandidateToken({ top10HolderConcentrationPct: 0.4 })).passed).toBe(false);
  });

  it('fails above 40%', () => {
    expect(checkHolderConcentration(makeCandidateToken({ top10HolderConcentrationPct: 0.6 })).passed).toBe(false);
  });
});
