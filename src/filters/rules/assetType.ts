import { config } from '../../config';
import type { CandidateToken } from '../../discovery/types';
import type { FilterCheckResult } from '../types';

/**
 * ALLOW_LIST mode -- Draft V1 §3's original rule, preserved verbatim:
 * only `ALLOWED_ASSET_TYPES` ('Meme'/'Project') passes, everything else
 * (including 'Unknown') is rejected. Kept as a named function so
 * `STOCK_ONLY_REJECTED` reasons/behavior can never accidentally drift
 * into this one, and so a future rollback to `ALLOW_LIST` mode needs no
 * code change beyond the `ASSET_TYPE_MODE` constant.
 */
function checkAllowList(token: CandidateToken): FilterCheckResult {
  const allowed: readonly string[] = config.rules.filters.ALLOWED_ASSET_TYPES;
  const passed = allowed.includes(token.assetType);
  return {
    rule: 'ASSET_TYPE',
    passed,
    reason: passed
      ? `asset type "${token.assetType}" is allowed`
      : `asset type "${token.assetType}" is rejected (allowed: ${allowed.join(', ')})`,
    meta: { mode: 'ALLOW_LIST', assetType: token.assetType, allowed },
  };
}

/**
 * STOCK_ONLY mode (Phase 12, operator-approved default): reject ONLY a
 * confirmed Robinhood Stock Token; allow everything else, including a
 * candidate whose `assetType` reads `'Unknown'`.
 *
 * Deliberately reads `token.stockClassification` (the on-chain
 * classifier's own three-value result: `ROBINHOOD_OFFICIAL_STOCK` /
 * `NON_STOCK` / `UNKNOWN`) rather than the flattened `assetType` string.
 * This is the fail-safe requirement Phase 12 was explicit about: a
 * classifier that could not resolve (RPC failure, malformed beacon read
 * -- `stockClassification: 'UNKNOWN'`) must NEVER be silently treated as
 * "confirmed not a stock, therefore safe to continue" just because
 * `assetType` also happens to read `'Unknown'` in that case. Only an
 * EXPLICIT, successful `'NON_STOCK'` result passes. A candidate that was
 * never run through `classifyCandidates` at all (`stockClassification`
 * `undefined` -- should not happen on the real production path, since
 * `screeningCycle.ts` always classifies before screening, but reachable
 * from a malformed caller or a test fixture) is treated the same as
 * `'UNKNOWN'` -- fail-safe reject, never assumed safe by omission.
 */
function checkStockOnly(token: CandidateToken): FilterCheckResult {
  const classification = token.stockClassification;
  const passed = classification === 'NON_STOCK';
  const reason =
    classification === 'ROBINHOOD_OFFICIAL_STOCK'
      ? 'confirmed Robinhood Stock Token, rejected (STOCK_ONLY mode)'
      : classification === 'NON_STOCK'
        ? 'confirmed not a Stock Token (STOCK_ONLY mode) -- allowed to continue'
        : `Stock classification unresolved (${classification ?? 'never classified'}) -- rejected fail-safe, never assumed non-Stock by omission (STOCK_ONLY mode)`;
  return {
    rule: 'ASSET_TYPE',
    passed,
    reason,
    meta: { mode: 'STOCK_ONLY', assetType: token.assetType, stockClassification: classification },
  };
}

export function checkAssetType(token: CandidateToken): FilterCheckResult {
  const mode: 'STOCK_ONLY' | 'ALLOW_LIST' = config.rules.filters.ASSET_TYPE_MODE;
  return mode === 'STOCK_ONLY' ? checkStockOnly(token) : checkAllowList(token);
}
