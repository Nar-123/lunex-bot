import { config } from '../../config';
import type { CandidateToken } from '../../discovery/types';
import type { FilterCheckResult } from '../types';

/**
 * Spec requires the combined top-10 non-LP/non-burn holder share to be
 * strictly < 40%. The figure is taken as-is from GMGN (`CandidateToken`) —
 * this rule never issues a separate on-chain query.
 */
export function checkHolderConcentration(token: CandidateToken): FilterCheckResult {
  const max = config.rules.filters.MAX_TOP10_HOLDER_CONCENTRATION;
  const passed = token.top10HolderConcentrationPct < max;
  const pctStr = (token.top10HolderConcentrationPct * 100).toFixed(2);
  const maxStr = (max * 100).toFixed(2);
  return {
    rule: 'HOLDER_CONCENTRATION',
    passed,
    reason: passed
      ? `top10 holder concentration ${pctStr}% < ${maxStr}%`
      : `top10 holder concentration ${pctStr}% is not < ${maxStr}%`,
    meta: { top10HolderConcentrationPct: token.top10HolderConcentrationPct, max },
  };
}
