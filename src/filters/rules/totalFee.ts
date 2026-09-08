import { config } from '../../config';
import type { CandidateToken } from '../../discovery/types';
import type { FilterCheckResult } from '../types';

export function checkTotalFee(token: CandidateToken): FilterCheckResult {
  const min = config.rules.filters.MIN_TOTAL_FEE_ETH;
  const passed = token.totalFeeEth >= min;
  return {
    rule: 'TOTAL_FEE',
    passed,
    reason: passed
      ? `all-time fee ${token.totalFeeEth} ETH >= required ${min} ETH`
      : `all-time fee ${token.totalFeeEth} ETH < required ${min} ETH`,
    meta: { totalFeeEth: token.totalFeeEth, minRequired: min },
  };
}
