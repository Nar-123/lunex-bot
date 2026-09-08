import { describe, expect, it } from 'vitest';
import { checkCooldown } from '../../src/filters/rules/cooldown';
import { makeCandidateToken } from '../fixtures/candidateToken';
import type { CooldownChecker, CooldownStatus } from '../../src/filters/types';

function mockChecker(status: CooldownStatus): CooldownChecker {
  return { getCooldownStatus: async () => status };
}

describe('checkCooldown', () => {
  it('passes when the token is not in cooldown', async () => {
    const result = await checkCooldown(makeCandidateToken(), mockChecker({ inCooldown: false, remainingMs: 0 }));
    expect(result.passed).toBe(true);
  });

  it('fails when the token is still in its post-exit cooldown and reports remaining time', async () => {
    const now = Date.now();
    const status: CooldownStatus = {
      inCooldown: true,
      remainingMs: 45 * 60 * 1000,
      cooldownEndsAt: now + 45 * 60 * 1000,
    };
    const result = await checkCooldown(makeCandidateToken(), mockChecker(status));
    expect(result.passed).toBe(false);
    expect(result.meta?.remainingMs).toBe(45 * 60 * 1000);
    expect(result.reason).toContain('45m remaining');
  });
});
