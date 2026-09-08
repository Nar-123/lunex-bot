import { describe, expect, it } from 'vitest';
import { checkTotalFee } from '../../src/filters/rules/totalFee';
import { makeCandidateToken } from '../fixtures/candidateToken';

describe('checkTotalFee', () => {
  it('passes at exactly 0.5 ETH', () => {
    expect(checkTotalFee(makeCandidateToken({ totalFeeEth: 0.5 })).passed).toBe(true);
  });

  it('passes above 0.5 ETH', () => {
    expect(checkTotalFee(makeCandidateToken({ totalFeeEth: 10 })).passed).toBe(true);
  });

  it('fails just below 0.5 ETH', () => {
    expect(checkTotalFee(makeCandidateToken({ totalFeeEth: 0.499 })).passed).toBe(false);
  });

  it('fails at zero', () => {
    expect(checkTotalFee(makeCandidateToken({ totalFeeEth: 0 })).passed).toBe(false);
  });
});
