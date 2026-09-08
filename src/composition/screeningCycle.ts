import { getAddress } from 'viem';
import type { Address } from 'viem';
import { Token } from '@uniswap/sdk-core';
import { config } from '../config';
import { screenCandidates, getPassingCandidates } from '../filters/screenCandidate';
import { selectPool } from '../pools/selectPool';
import { computeLpRange } from '../strategies/computeLpRange';
import { decideCapitalAllocation } from '../capital/decideCapitalAllocation';
import type { CapitalRules } from '../capital/types';
import { openPosition } from '../positions/openPosition';
import type { PositionPoolContext } from '../positions/types';
import type { AppDeps } from './types';

export interface ScreeningCycleSummary {
  candidatesEvaluated: number;
  passed: number;
  failed: number;
  deployed: number;
  skipped: Array<{ symbol: string; stage: string; reason: string }>;
  /** True when this call skipped entirely because the bot is paused -- distinguishes "paused" from "ran, found zero candidates" in logs/GET /status. Every other field is left at its zero value when this is true. */
  paused: boolean;
}

/**
 * The 30-minute screening cycle: discovery -> filter -> (per passing
 * candidate, until one deployment succeeds/is in flight) capital check ->
 * pool selection -> range calc -> open. Matches the exact ordering already
 * locked across Modules 2-5 and 9A -- this file wires them together, it
 * does not re-decide any of their individual logic.
 *
 * `decideCapitalAllocation` runs BEFORE `selectPool` for each candidate,
 * per `selectPool`'s own doc comment ("`positionSizeUsdgRaw` MUST be the
 * real position size... computed by capital/ at the moment this candidate
 * is evaluated") -- pool selection's price-impact simulation needs the
 * REAL amount about to be deployed, not a placeholder.
 *
 * `TRY_NEXT_CANDIDATE_ON_FAILURE` (spec, `config.rules.cycle`) governs
 * every skip below uniformly: a candidate failing capital/pool/range/open
 * moves on to the next PASSING candidate rather than aborting the whole
 * cycle, stopping only once `MAX_SUCCESSFUL_DEPLOYMENTS_PER_CYCLE` is hit
 * or candidates run out.
 *
 * Both `ACTIVE` and `PENDING` open-position outcomes count toward the
 * per-cycle deployment limit -- deliberately, not just `ACTIVE`: the
 * moment a `Position` row reaches OPENING, its `entryUsdgRaw` is already
 * reserved out of `freeUsdgBalance` (Revision 6), so starting a SECOND
 * deployment attempt in the same tick while the first is still ambiguous
 * risks the capital snapshot the second attempt reads being stale the
 * instant the first one resolves. Only a definitive `FAILED` (capital
 * fully released, per Revision 7) does not count, and correctly allows
 * trying the next candidate.
 *
 * ## Pause (Module 10)
 *
 * Checked as the VERY FIRST thing this function does -- if the bot is
 * paused, the ENTIRE cycle body is skipped, including
 * `discoveryService.discoverTopCandidates()` (so a paused bot makes no
 * GMGN CLI calls at all). This is deliberately a check inside THIS
 * function, not a guard around the scheduler that starts it in
 * `composition/app.ts` -- pausing must never stop monitoring or exit
 * (`runMonitoringLoggingCycle`/`runExitAndOpenResumeCycle` have no pause
 * check anywhere, proven by a dedicated test), only screening.
 *
 * `settings` is read once here and reused for both the pause check and
 * building `capitalRules` below -- one read per cycle, not two.
 */
export async function runScreeningCycle(deps: AppDeps): Promise<ScreeningCycleSummary> {
  const settings = await deps.settings.get();
  if (settings.paused) {
    deps.logger.info('screening_cycle', { paused: true, candidatesEvaluated: 0, passed: 0, failed: 0, deployed: 0 });
    return { candidatesEvaluated: 0, passed: 0, failed: 0, deployed: 0, skipped: [], paused: true };
  }

  const capitalRules: CapitalRules = {
    ...config.rules.capital,
    MAX_ACTIVE_POSITIONS: settings.maxActivePositions,
    POSITION_SIZE_PCT_OF_FREE_BALANCE: settings.positionSizePct,
  };

  const candidates = await deps.discoveryService.discoverTopCandidates();
  const screeningResults = await screenCandidates(candidates, {
    activePositionChecker: deps.activePositionChecker,
    cooldownChecker: deps.cooldown,
  });
  const passing = getPassingCandidates(candidates, screeningResults);

  const summary: ScreeningCycleSummary = {
    candidatesEvaluated: candidates.length,
    passed: passing.length,
    failed: candidates.length - passing.length,
    deployed: 0,
    skipped: [],
    paused: false,
  };

  const usdgAddress = getAddress(config.quoteAsset.ADDRESS);

  for (const candidate of passing) {
    if (summary.deployed >= config.rules.cycle.MAX_SUCCESSFUL_DEPLOYMENTS_PER_CYCLE) break;

    const snapshot = await deps.capitalSnapshot.getSnapshot();
    const capitalDecision = decideCapitalAllocation(snapshot, capitalRules);
    if (!capitalDecision.ok) {
      summary.skipped.push({ symbol: candidate.symbol, stage: 'capital', reason: capitalDecision.reason });
      if (!config.rules.cycle.TRY_NEXT_CANDIDATE_ON_FAILURE) break;
      continue;
    }

    const tokenAddress = getAddress(candidate.address) as Address;
    const tokenDecimals = await deps.readTokenDecimals(tokenAddress);
    const tokenSdk = new Token(config.chain.chainId, tokenAddress, tokenDecimals, candidate.symbol);
    const usdgSdk = new Token(config.chain.chainId, usdgAddress, config.quoteAsset.DECIMALS, 'USDG');

    const poolResult = await selectPool(tokenSdk, usdgSdk, capitalDecision.positionSizeUsdgRaw, {
      discovery: deps.poolDiscovery,
      state: deps.poolState,
      volume: deps.poolVolume,
    });
    if (!poolResult.selected) {
      summary.skipped.push({ symbol: candidate.symbol, stage: 'pool', reason: poolResult.reason });
      if (!config.rules.cycle.TRY_NEXT_CANDIDATE_ON_FAILURE) break;
      continue;
    }

    const priceState = await deps.poolState.getState(poolResult.pool);
    const usdgIsCurrency0 = getAddress(poolResult.pool.key.currency0) === usdgAddress;
    const rangeResult = computeLpRange({
      sqrtPriceX96: priceState.sqrtPriceX96,
      tickCurrent: priceState.tickCurrent,
      tickSpacing: poolResult.pool.key.tickSpacing,
      currency0: poolResult.pool.key.currency0,
      currency1: poolResult.pool.key.currency1,
      decimals0: usdgIsCurrency0 ? config.quoteAsset.DECIMALS : tokenDecimals,
      decimals1: usdgIsCurrency0 ? tokenDecimals : config.quoteAsset.DECIMALS,
      chainId: config.chain.chainId,
    });
    if (!rangeResult.ok) {
      summary.skipped.push({ symbol: candidate.symbol, stage: 'range', reason: rangeResult.reason });
      if (!config.rules.cycle.TRY_NEXT_CANDIDATE_ON_FAILURE) break;
      continue;
    }

    const pool: PositionPoolContext = { poolId: poolResult.pool.poolId, ...poolResult.pool.key };
    const openOutcome = await openPosition(
      {
        tokenAddress,
        tokenSymbol: candidate.symbol,
        tokenDecimals,
        pool,
        tickLower: rangeResult.tickLower,
        tickUpper: rangeResult.tickUpper,
        entryUsdgRaw: capitalDecision.positionSizeUsdgRaw,
        entryTick: priceState.tickCurrent,
        entrySqrtPriceX96: priceState.sqrtPriceX96,
      },
      {
        positions: deps.positions,
        txAttempts: deps.txAttempts,
        livePositionState: deps.livePositionState,
        poolPrice: deps.poolPrice,
        buildApproveDeps: deps.buildApproveDepsForOpen,
        buildMintDeps: deps.buildMintDeps,
        readAllowance: deps.readAllowance,
        walletAddress: deps.walletAddress,
      },
    );

    if (openOutcome.outcome === 'ACTIVE' || openOutcome.outcome === 'PENDING') {
      summary.deployed++;
    } else {
      summary.skipped.push({ symbol: candidate.symbol, stage: 'open', reason: openOutcome.reason });
      if (!config.rules.cycle.TRY_NEXT_CANDIDATE_ON_FAILURE) break;
      continue;
    }
  }

  deps.logger.info('screening_cycle', { ...summary });
  return summary;
}
