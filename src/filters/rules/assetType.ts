import { config } from '../../config';
import type { CandidateToken } from '../../discovery/types';
import type { FilterCheckResult } from '../types';

export function checkAssetType(token: CandidateToken): FilterCheckResult {
  const allowed: readonly string[] = config.rules.filters.ALLOWED_ASSET_TYPES;
  const passed = allowed.includes(token.assetType);
  return {
    rule: 'ASSET_TYPE',
    passed,
    reason: passed
      ? `asset type "${token.assetType}" is allowed`
      : `asset type "${token.assetType}" is rejected (allowed: ${allowed.join(', ')})`,
    meta: { assetType: token.assetType, allowed },
  };
}
