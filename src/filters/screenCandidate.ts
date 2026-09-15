import { config } from '../config';
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
 *
 * `assetTypeEnabled` defaults to `config.rules.filters.ASSET_TYPE.ENABLED`
 * (currently `true` -- fail-closed per Draft V1 Section 3: only `Meme`/
 * `Project` are allowed, `Unknown` and every other type are rejected; see
 * that constant's doc comment for the full history, including the earlier
 * temporary deviation this restored from). It is an explicit parameter, not
 * just an inline config read, purely so tests can exercise both the enabled
 * (Draft V1 original, current default) and disabled (historical temporary
 * deviation) behavior deterministically -- no production call site passes
 * it, so production always gets the real config value. `checkAssetType` is
 * ALWAYS computed and ALWAYS included in
 * `checks`, enabled or not -- disabling only removes it from the set of
 * checks that can fail the candidate (`token.assetType` itself is never
 * rewritten, and no substitute heuristic is introduced).
 */
export async function screenCandidate(
  token: CandidateToken,
  deps: ScreeningDeps,
  now: number = Date.now(),
  assetTypeEnabled: boolean = config.rules.filters.ASSET_TYPE.ENABLED,
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

  const blockingChecks = assetTypeEnabled ? checks : checks.filter((c) => c.rule !== 'ASSET_TYPE');
  const firstFailed = blockingChecks.find((c) => !c.passed);

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
