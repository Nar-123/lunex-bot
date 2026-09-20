import { getAddress, parseUnits } from 'viem';
import { Token } from '@uniswap/sdk-core';
import { config } from '../config';
import { classifyCandidates } from '../discovery/robinhoodStockClassifier';
import { screenCandidates, getPassingCandidates } from '../filters/screenCandidate';
import { selectPool } from '../pools/selectPool';
import { computeLpRange } from '../strategies/computeLpRange';
import { decideCapitalAllocation } from '../capital/decideCapitalAllocation';
import type { CapitalRules } from '../capital/types';
import { exceedsHardCeilings } from '../capital/hardCeilings';
import { applyCanaryPositionCap, canaryAllowsNewEntry } from '../capital/canary';
import type { CanaryRules } from '../capital/canary';
import { openPosition } from '../positions/openPosition';
import type { PositionPoolContext } from '../positions/types';
import type { AppDeps } from './types';
import type { EntryState } from '../settings/types';
import { toEntryState } from '../settings/types';

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
  if (settings.paused || settings.aiEntryPaused) {
    logEntryBlockedByAi(deps, toEntryState(settings), 'cycle-start');
    deps.logger.info('screening_cycle', { paused: true, candidatesEvaluated: 0, passed: 0, failed: 0, deployed: 0 });
    return { candidatesEvaluated: 0, passed: 0, failed: 0, deployed: 0, skipped: [], paused: true };
  }

  // Phase 10A: canary mode's own rules, read fresh every cycle from frozen
  // `config.rules.canary` (never settings-derived -- unlike positionSizePct
  // above, this is not a UI-exposed live toggle). `MAX_USDG` is converted
  // from its human-readable config form to raw USDG units exactly once
  // here, not re-parsed per candidate.
  const canaryRules: CanaryRules = {
    enabled: config.rules.canary.ENABLED,
    maxPositionPct: config.rules.canary.MAX_POSITION_PCT,
    maxUsdgRaw: config.rules.canary.MAX_USDG === null ? null : parseUnits(String(config.rules.canary.MAX_USDG), config.quoteAsset.DECIMALS),
    maxPositions: config.rules.canary.MAX_POSITIONS,
    stopAfterSuccess: config.rules.canary.STOP_AFTER_SUCCESS,
  };
  // No effect at all while canary is disabled (the default) --
  // `canaryAllowsNewEntry` returns `true` unconditionally in that case, so
  // this can never skip a cycle for a production run.
  if (!canaryAllowsNewEntry(canaryRules, deps.canaryGuard.succeededCount())) {
    deps.logger.info('screening_cycle', { canaryBlocked: true, candidatesEvaluated: 0, passed: 0, failed: 0, deployed: 0 });
    return { candidatesEvaluated: 0, passed: 0, failed: 0, deployed: 0, skipped: [], paused: false };
  }

  const capitalRules: CapitalRules = {
    ...config.rules.capital,
    MAX_ACTIVE_POSITIONS: settings.maxActivePositions,
    POSITION_SIZE_PCT_OF_FREE_BALANCE: settings.positionSizePct,
  };
  // P0-2: `PATCH /settings` rejects an above-ceiling value at the API
  // layer (api/routes/settingsSchema.ts), so this should be unreachable in
  // normal operation -- but a legacy DB row from before that fix, or a
  // direct DB edit, is still possible. `decideCapitalAllocation` itself
  // independently clamps (see `capital/hardCeilings.ts`), so a stale
  // over-ceiling value here can never actually size an over-limit
  // position -- this is purely a loud, one-time-per-cycle warning so the
  // condition is visible in logs/observability, never silent.
  if (exceedsHardCeilings(capitalRules)) {
    deps.logger.warn('settings_exceed_hard_ceiling', {
      positionSizePct: capitalRules.POSITION_SIZE_PCT_OF_FREE_BALANCE,
      maxActivePositions: capitalRules.MAX_ACTIVE_POSITIONS,
      message: 'live settings exceed the strategy hard ceiling -- decideCapitalAllocation will clamp, but the stored settings row should be corrected',
    });
  }

  // ASSET_TYPE (see `config/constants.ts`'s `FILTERS.ASSET_TYPE` doc
  // comment) is back to fail-closed (`ENABLED: true`) now that
  // `discovery/robinhoodStockClassifier.ts` can confirm the highest-risk
  // case -- an official Robinhood Stock Token -- with an on-chain,
  // non-heuristic check. This warning stays wired for the (currently
  // dormant) case where ENABLED is deliberately flipped back off; read
  // through a `boolean`-typed local for the same `no-unnecessary-condition`
  // reasoning as `tryNextCandidateOnFailure` below.
  const assetTypeFilterPolicy: { ENABLED: boolean } = config.rules.filters.ASSET_TYPE;
  if (!assetTypeFilterPolicy.ENABLED) {
    deps.logger.warn('asset_type_filter_disabled', {
      reason: 'GMGN supplies no authoritative asset-classification field -- temporary Draft V1 deviation',
      risk: 'equity/ETF/RWA/tokenized-stock-like tokens are not guaranteed to be excluded from deployment',
    });
  }

  const discovered = await deps.discoveryService.discoverTopCandidates();
  // Enriches `assetType` for any candidate that is a CONFIRMED official
  // Robinhood Stock Token (on-chain EIP-1967 beacon check) -- never
  // rewrites anything else. See `robinhoodStockClassifier.ts`'s doc
  // comment: a `NON_STOCK`/`UNKNOWN` result is never treated as proof of
  // Meme/Project, so it never changes `assetType`.
  const candidates = await classifyCandidates(discovered, deps.stockClassifier);
  const screeningResults = await screenCandidates(candidates, {
    activePositionChecker: deps.activePositionChecker,
    cooldownChecker: deps.cooldown,
  });

  // Phase 12D: diagnostic-only logging, closing the observability gap
  // Phase 12C found -- `screeningResults` (full per-candidate `checks[]`)
  // was previously computed here and then discarded, with only the
  // aggregate `summary` below ever logged, leaving no trace of WHICH rule
  // stopped a rejected candidate or WHY. This loop iterates the
  // ALREADY-COMPUTED `screeningResults` read-only -- it re-evaluates
  // nothing, calls no filter/check again, and runs entirely BEFORE
  // `getPassingCandidates` below, so it cannot influence `passing`,
  // `summary`, or which candidates proceed. A logging failure for one
  // candidate (or all of them) is swallowed and can never affect the real
  // screening result -- see `tests/composition/screeningCycle.test.ts`'s
  // "logging failure cannot change screening result" test.
  for (let i = 0; i < screeningResults.length; i++) {
    const result = screeningResults[i];
    if (!result || result.passed) continue;
    try {
      const failedCheck = result.checks.find((c) => c.rule === result.failedRule);
      deps.logger.info('screening_rejection', {
        address: result.tokenAddress,
        symbol: result.symbol,
        name: candidates[i]?.name,
        failedRule: result.failedRule,
        reason: failedCheck?.reason,
        passedCheckCount: result.checks.filter((c) => c.passed).length,
      });
    } catch {
      // Never let diagnostic logging affect the real screening pipeline.
    }
  }

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
  // Extracted through a `boolean`-typed interface so the guards below are
  // genuinely conditional: `config.rules.cycle.TRY_NEXT_CANDIDATE_ON_FAILURE`
  // is a frozen `true` literal, and a directly-typed local would make every
  // `if (!flag)` guard type-level dead code (no-unnecessary-condition is
  // right about THAT). The flag is a documented policy toggle -- `false`
  // must keep working the moment the constant flips -- so the guards stay.
  const cyclePolicy: { TRY_NEXT_CANDIDATE_ON_FAILURE: boolean } = config.rules.cycle;
  const tryNextCandidateOnFailure = cyclePolicy.TRY_NEXT_CANDIDATE_ON_FAILURE;

  for (const candidate of passing) {
    if (summary.deployed >= config.rules.cycle.MAX_SUCCESSFUL_DEPLOYMENTS_PER_CYCLE) break;

    // Entry control: a pause (operator or AI) that becomes effective while
    // this cycle is iterating candidates stops it before the NEXT deployment
    // -- not only at the start of the next cycle. (The reservation itself
    // re-checks under CapitalLock too; see createIfCapitalAllows.)
    const entry = await deps.settings.getEntryState();
    if (entry.entryPaused) {
      logEntryBlockedByAi(deps, entry, 'before-candidate', candidate.symbol);
      summary.skipped.push({ symbol: candidate.symbol, stage: 'entry', reason: `entry paused (${entry.operatorPaused ? 'operator' : 'AI supervisor'}) -- cycle stopped before deployment` });
      break;
    }

    const snapshot = await deps.capitalSnapshot.getSnapshot();
    const capitalDecision = decideCapitalAllocation(snapshot, capitalRules);
    if (!capitalDecision.ok) {
      summary.skipped.push({ symbol: candidate.symbol, stage: 'capital', reason: capitalDecision.reason });
      if (!tryNextCandidateOnFailure) break;
      continue;
    }
    // Phase 10A: only ever NARROWS the already-approved size above -- an
    // identity function while canary is disabled, so production sizing is
    // completely unaffected. See `capital/canary.ts`'s doc comment.
    const positionSizeUsdgRaw = applyCanaryPositionCap(capitalDecision.positionSizeUsdgRaw, snapshot.freeUsdgBalance, canaryRules);

    const tokenAddress = getAddress(candidate.address);
    const tokenDecimals = await deps.readTokenDecimals(tokenAddress);
    const tokenSdk = new Token(config.chain.chainId, tokenAddress, tokenDecimals, candidate.symbol);
    const usdgSdk = new Token(config.chain.chainId, usdgAddress, config.quoteAsset.DECIMALS, 'USDG');

    const poolResult = await selectPool(tokenSdk, usdgSdk, positionSizeUsdgRaw, {
      discovery: deps.poolDiscovery,
      state: deps.poolState,
      volume: deps.poolVolume,
    });
    if (!poolResult.selected) {
      summary.skipped.push({ symbol: candidate.symbol, stage: 'pool', reason: poolResult.reason });
      if (!tryNextCandidateOnFailure) break;
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
      if (!tryNextCandidateOnFailure) break;
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
        entryUsdgRaw: positionSizeUsdgRaw,
        entryTick: priceState.tickCurrent,
        entrySqrtPriceX96: priceState.sqrtPriceX96,
        // P1-1 fix: the RAW balance READER (never `snapshot.freeUsdgBalance`,
        // which is already net of the OPENING rows that existed when this
        // iteration sized the candidate) -- openPosition ->
        // createIfCapitalAllows re-derives free/deployed/count from one
        // consistent fresh state under CapitalLock.
        readOnChainUsdgBalance: () => deps.capitalSnapshot.readOnChainUsdgBalance(),
        capitalRules,
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
        permit2Preflight: deps.permit2Preflight,
        onPermit2Warning: (r) => {
          deps.logger.warn('permit2_grant_expiring_soon', { expiresAt: new Date(r.grantExpiration * 1000).toISOString(), secondsUntilExpiry: r.secondsUntilExpiry, grantNonce: r.grantNonce });
        },
      },
    );

    if (openOutcome.outcome === 'ACTIVE' || openOutcome.outcome === 'PENDING') {
      summary.deployed++;
      // Phase 10A: records the deployment against canary's own cross-cycle
      // latch -- no-op semantically while canary is disabled (the guard's
      // count is simply never checked in that case, see `canaryAllowsNewEntry`
      // above), so this line has zero effect on production behavior.
      if (canaryRules.enabled) deps.canaryGuard.recordSuccess();
    } else if (openOutcome.blockedByPermit2) {
      // Permit2 pre-flight refused the entry BEFORE any reservation. The
      // condition is wallet-level (same grant/allowance for every candidate),
      // so trying the next candidate would only repeat the same refusal.
      deps.logger.warn('entry_blocked_permit2', { symbol: candidate.symbol, status: openOutcome.blockedByPermit2.status, reason: openOutcome.reason });
      summary.skipped.push({ symbol: candidate.symbol, stage: 'permit2', reason: openOutcome.reason });
      break;
    } else if (openOutcome.entryPausedBy) {
      // Refused by the entry gate under CapitalLock: nothing was reserved.
      // Stop the cycle (never "try the next candidate" past a pause).
      if (openOutcome.entryPausedBy === 'AI') logEntryBlockedByAi(deps, await deps.settings.getEntryState(), 'reservation', candidate.symbol);
      summary.skipped.push({ symbol: candidate.symbol, stage: 'entry', reason: openOutcome.reason });
      break;
    } else {
      summary.skipped.push({ symbol: candidate.symbol, stage: 'open', reason: openOutcome.reason });
      if (!tryNextCandidateOnFailure) break;
      continue;
    }
  }

  deps.logger.info('screening_cycle', { ...summary });
  return summary;
}

/**
 * AI Supervisor audit event: a screening cycle was stopped by the AI entry
 * pause. Logged only when the AI flag is (part of) the reason -- an operator
 * pause keeps its existing `screening_cycle { paused: true }` line. No
 * secrets: the state flags and the correlation id of the pausing request.
 */
function logEntryBlockedByAi(deps: Pick<AppDeps, 'logger'>, entry: EntryState, stage: 'cycle-start' | 'before-candidate' | 'reservation', symbol?: string): void {
  if (!entry.aiEntryPaused) return;
  const state = { entryPaused: entry.entryPaused, aiEntryPaused: entry.aiEntryPaused, operatorPaused: entry.operatorPaused };
  deps.logger.warn('AI_ENTRY_BLOCKED_BY_PAUSE', {
    timestamp: new Date().toISOString(),
    action: 'block-entry',
    actor: 'ai-supervisor',
    previousState: state,
    newState: state,
    requestId: entry.aiEntryRequestId,
    stage,
    ...(symbol !== undefined && { symbol }),
  });
}
