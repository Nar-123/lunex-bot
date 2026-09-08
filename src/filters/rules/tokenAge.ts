import { config } from '../../config';
import type { CandidateToken } from '../../discovery/types';
import type { FilterCheckResult } from '../types';

export function checkTokenAge(token: CandidateToken, now: number = Date.now()): FilterCheckResult {
  const minAgeMs = config.rules.filters.MIN_TOKEN_AGE_MS;
  const ageMs = now - token.createdAt;
  const passed = ageMs >= minAgeMs;
  const ageDays = (ageMs / (24 * 60 * 60 * 1000)).toFixed(2);
  const minDays = (minAgeMs / (24 * 60 * 60 * 1000)).toFixed(2);
  return {
    rule: 'TOKEN_AGE',
    passed,
    reason: passed
      ? `token age ${ageDays}d >= required ${minDays}d`
      : `token age ${ageDays}d < required ${minDays}d`,
    meta: { ageMs, minAgeMs },
  };
}
