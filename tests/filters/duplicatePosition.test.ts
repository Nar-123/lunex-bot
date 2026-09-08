import { describe, expect, it } from 'vitest';
import { checkDuplicatePosition } from '../../src/filters/rules/duplicatePosition';
import { makeCandidateToken } from '../fixtures/candidateToken';
import type { ActivePositionChecker } from '../../src/filters/types';

function mockChecker(hasActive: boolean): ActivePositionChecker {
  return { hasActivePosition: async () => hasActive };
}

describe('checkDuplicatePosition', () => {
  it('passes when the token has no active position', async () => {
    const result = await checkDuplicatePosition(makeCandidateToken(), mockChecker(false));
    expect(result.passed).toBe(true);
  });

  it('fails when the token already has an active position', async () => {
    const result = await checkDuplicatePosition(makeCandidateToken(), mockChecker(true));
    expect(result.passed).toBe(false);
  });
});
