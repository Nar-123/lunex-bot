import { describe, expect, it } from 'vitest';
import { checkTokenAge } from '../../src/filters/rules/tokenAge';
import { makeCandidateToken } from '../fixtures/candidateToken';

const DAY_MS = 24 * 60 * 60 * 1000;

describe('checkTokenAge', () => {
  it('passes at exactly 1 day old', () => {
    const now = Date.now();
    const result = checkTokenAge(makeCandidateToken({ createdAt: now - DAY_MS }), now);
    expect(result.passed).toBe(true);
  });

  it('passes when older than 1 day', () => {
    const now = Date.now();
    const result = checkTokenAge(makeCandidateToken({ createdAt: now - 10 * DAY_MS }), now);
    expect(result.passed).toBe(true);
  });

  it('fails when younger than 1 day', () => {
    const now = Date.now();
    const result = checkTokenAge(makeCandidateToken({ createdAt: now - DAY_MS + 1000 }), now);
    expect(result.passed).toBe(false);
  });

  it('fails for a token created this instant', () => {
    const now = Date.now();
    const result = checkTokenAge(makeCandidateToken({ createdAt: now }), now);
    expect(result.passed).toBe(false);
  });
});
