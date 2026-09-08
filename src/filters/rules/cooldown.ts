import type { CandidateToken } from '../../discovery/types';
import type { CooldownChecker, FilterCheckResult } from '../types';

/** Per-token cooldown (2h post-exit) — never a global cooldown. */
export async function checkCooldown(token: CandidateToken, checker: CooldownChecker): Promise<FilterCheckResult> {
  const status = await checker.getCooldownStatus(token.address);
  const passed = !status.inCooldown;
  const remainingMin = Math.ceil(status.remainingMs / 60_000);
  return {
    rule: 'COOLDOWN',
    passed,
    reason: passed
      ? `${token.symbol} is not in cooldown`
      : `${token.symbol} is still in its post-exit cooldown (${remainingMin}m remaining)`,
    meta: { inCooldown: status.inCooldown, remainingMs: status.remainingMs, cooldownEndsAt: status.cooldownEndsAt },
  };
}
