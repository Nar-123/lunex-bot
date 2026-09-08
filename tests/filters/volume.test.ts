import { describe, expect, it } from 'vitest';
import { checkVolume } from '../../src/filters/rules/volume';
import { makeCandidateToken } from '../fixtures/candidateToken';

describe('checkVolume', () => {
  it('passes for any volume > 0', () => {
    expect(checkVolume(makeCandidateToken({ volumeUsd: 1 })).passed).toBe(true);
    expect(checkVolume(makeCandidateToken({ volumeUsd: 100_000 })).passed).toBe(true);
  });

  it('fails at exactly 0 (must be strictly > 0)', () => {
    expect(checkVolume(makeCandidateToken({ volumeUsd: 0 })).passed).toBe(false);
  });

  it('fails for negative volume', () => {
    expect(checkVolume(makeCandidateToken({ volumeUsd: -1 })).passed).toBe(false);
  });
});
