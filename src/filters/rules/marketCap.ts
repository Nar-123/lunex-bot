import { config } from '../../config';
import type { CandidateToken } from '../../discovery/types';
import type { FilterCheckResult } from '../types';

export function checkMarketCap(token: CandidateToken): FilterCheckResult {
  const min = config.rules.filters.MIN_MARKET_CAP_USD;
  const passed = token.marketCapUsd >= min;
  return {
    rule: 'MARKET_CAP',
    passed,
    reason: passed
      ? `market cap $${token.marketCapUsd.toLocaleString()} >= required $${min.toLocaleString()}`
      : `market cap $${token.marketCapUsd.toLocaleString()} < required $${min.toLocaleString()}`,
    meta: { marketCapUsd: token.marketCapUsd, minRequired: min },
  };
}
