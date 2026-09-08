import type { CandidateToken } from '../../discovery/types';
import type { ActivePositionChecker, FilterCheckResult } from '../types';

export async function checkDuplicatePosition(
  token: CandidateToken,
  checker: ActivePositionChecker,
): Promise<FilterCheckResult> {
  const hasActivePosition = await checker.hasActivePosition(token.address);
  const passed = !hasActivePosition;
  return {
    rule: 'DUPLICATE_POSITION',
    passed,
    reason: passed
      ? `no active position for ${token.symbol}`
      : `${token.symbol} already has an active position (1 coin = 1 position)`,
    meta: { hasActivePosition },
  };
}
