import type { CandidateToken } from '../discovery/types';
import type { FilterCheckResult, ScreeningDeps, ScreeningResult } from './types';
import { checkMarketCap } from './rules/marketCap';
import { checkTokenAge } from './rules/tokenAge';
import { checkVolume } from './rules/volume';
import { checkTotalFee } from './rules/totalFee';
import { checkHolderConcentration } from './rules/holderConcentration';
import { checkAssetType } from './rules/assetType';
import { checkDuplicatePosition } from './rules/duplicatePosition';
import { checkCooldown } from './rules/cooldown';

/**
 * Runs every hard filter, in the same order as the spec's screening table,
 * and ALWAYS evaluates all of them (never short-circuits) so a rejected
 * candidate's full breakdown is available for logs/reporting. `passed` is
 * true only if every check passed.
 */
export async function screenCandidate(
  token: CandidateToken,
  deps: ScreeningDeps,
  now: number = Date.now(),
): Promise<ScreeningResult> {
  const checks: FilterCheckResult[] = [
    checkMarketCap(token),
    checkTokenAge(token, now),
    checkVolume(token),
    checkTotalFee(token),
    checkHolderConcentration(token),
    checkAssetType(token),
    await checkDuplicatePosition(token, deps.activePositionChecker),
    await checkCooldown(token, deps.cooldownChecker),
  ];

  const firstFailed = checks.find((c) => !c.passed);

  return {
    tokenAddress: token.address,
    symbol: token.symbol,
    passed: firstFailed === undefined,
    checks,
    failedRule: firstFailed?.rule,
    evaluatedAt: now,
  };
}

export async function screenCandidates(
  tokens: CandidateToken[],
  deps: ScreeningDeps,
  now: number = Date.now(),
): Promise<ScreeningResult[]> {
  const results: ScreeningResult[] = [];
  for (const token of tokens) {
    results.push(await screenCandidate(token, deps, now));
  }
  return results;
}

/** Candidates that passed every filter, preserving their original (ranked) order. */
export function getPassingCandidates(
  tokens: CandidateToken[],
  results: ScreeningResult[],
): CandidateToken[] {
  const passedAddresses = new Set(results.filter((r) => r.passed).map((r) => r.tokenAddress));
  return tokens.filter((t) => passedAddresses.has(t.address));
}
