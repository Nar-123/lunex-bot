import { randomUUID } from 'node:crypto';
import { config } from '../config';
import { computePositionMetrics } from '../monitoring/computePositionMetrics';
import { bucketSamplesToCloses, computePercentB } from '../monitoring/bollinger';
import type { LivePositionStateProvider, PoolPriceProvider, PoolPriceState, PriceHistoryProvider } from '../monitoring/types';
import type { PositionRecord, PositionRepository } from '../positions/types';
import type { TransactionAttemptRepository } from '../execution/types';
import type { SwapExecutor } from '../swap/types';
import type { SettingsRepository } from '../settings/types';
import type { ExitMetricsSnapshot, ExitRules, ExitStateFields, ExitStateRepository } from './types';
import { resolveExitDecision } from './resolveExitDecision';
import { evaluateMetricsFailureSafetyExit, isMetricsFailureOutageCorrelated, isPoolPriceStructurallyInvalid } from './safetyExit';
import { executeExit } from './executeExit';
import type { ExecuteExitDeps, ExitExecutionOutcome } from './executeExit';

/** Extends `ExecuteExitDeps` (rather than duplicating its fields) so the same optional `buildRemoveLiquidityDeps`/`buildSwapDeps` test-injection points that make `executeExit` testable in isolation also flow through a full `runExitCycle` call -- see `executeExit.ts`'s doc comment on those fields for why. */
export interface RunExitCycleDeps extends ExecuteExitDeps {
  positions: PositionRepository;
  exitStates: ExitStateRepository;
  txAttempts: TransactionAttemptRepository;
  livePositionState: LivePositionStateProvider;
  poolPrice: PoolPriceProvider;
  swapExecutor: SwapExecutor;
  /** Module 10: live-editable HARD_STOP_LOSS_PCT/TRAILING_TP.TRIGGER_PEAK_PNL_PCT, read fresh once per call (see below), merged over frozen config for every other field -- most importantly SAFETY_EXIT, which is NEVER settings-derived. */
  /**
   * OPTIONAL on purpose (same pattern as `priceHistory`): absent in
   * production, where the frozen `config.rules.exits` is always used.
   * Lets tests pin orchestrator-level behaviour against an explicit
   * rules object -- e.g. the validation-phase LOW_YIELD tests, which must
   * prove the shipped DISABLED default never fires while the rule's logic
   * itself stays intact. Live settings still merge over whatever base is
   * provided, exactly as over the frozen config.
   */
  exitRulesOverride?: ExitRules;
  settings: SettingsRepository;
  /**
   * TIER 3: the persisted pool-price series Bollinger %B is computed from.
   * OPTIONAL on purpose -- when absent (unit tests that aren't exercising
   * the OVEREXTENDED rule), %B is simply reported as unavailable and that
   * rule cannot fire, which is exactly the required fail-safe behaviour
   * rather than a special case.
   */
  priceHistory?: PriceHistoryProvider;
}

/**
 * How much price history to keep. Two full Bollinger windows
 * (2 x 20 x 5min = 200 minutes) -- enough to always satisfy a 20-close
 * lookback with margin for gaps, while keeping the table bounded at
 * roughly `pools x 800` rows.
 */
const PRICE_HISTORY_RETENTION_MS = 2 * 20 * 5 * 60 * 1000;

/** Records one observation into the Bollinger window. Best-effort: never let a history write break an exit decision. */
async function recordPriceSample(deps: RunExitCycleDeps, position: PositionRecord, priceText: string, now: Date): Promise<void> {
  if (!deps.priceHistory) return;
  const price = Number(priceText);
  if (!Number.isFinite(price)) return;
  try {
    await deps.priceHistory.recordSample(position.pool.poolId, price, now);
  } catch {
    // Swallowed deliberately -- a missing sample degrades %B to
    // "unavailable" (no exit), which is safe; throwing here would instead
    // abort this position's whole exit evaluation.
  }
}

/**
 * Bollinger %B for a position's pool, from PERSISTED history. Returns null
 * -- never a fabricated value -- when the provider is absent, the read
 * fails, or fewer than `BB_PERIOD` five-minute closes exist yet.
 */
async function computeBbPercentB(deps: RunExitCycleDeps, position: PositionRecord, now: Date): Promise<number | null> {
  if (!deps.priceHistory) return null;
  const { BB_PERIOD, BB_BUCKET_MS, BB_STDDEV_MULTIPLIER } = config.rules.exits.OVEREXTENDED;
  try {
    // One extra bucket of lookback so a partially-elapsed current bucket
    // can never cost us the oldest close in the window.
    const samples = await deps.priceHistory.recentSamples(position.pool.poolId, (BB_PERIOD + 1) * BB_BUCKET_MS, now);
    const closes = bucketSamplesToCloses(samples, BB_BUCKET_MS);
    return computePercentB(closes, BB_PERIOD, BB_STDDEV_MULTIPLIER);
  } catch {
    return null; // unavailable, never "not over-extended"
  }
}

export interface ExitCycleResult {
  positionId: string;
  action: 'NONE' | 'CLOSE_STARTED' | 'RESUMED';
  outcome?: ExitExecutionOutcome;
}

/**
 * One 15-second monitoring tick's worth of exit handling, in two passes:
 *
 *  1. DECIDE -- every currently ACTIVE position gets fresh trigger
 *     evaluation via `resolveExitDecision`. If it decides to close, a NEW
 *     `closeIdempotencyKey` is generated and `markClosing` + the trigger
 *     reason are persisted BEFORE `executeExit` is ever called (so a crash
 *     between "decided to close" and "started executing" still has
 *     everything it needs to resume correctly).
 *  2. RESUME -- every position ALREADY at CLOSING (from a previous tick
 *     that didn't finish -- an ambiguous/resumable step, or a
 *     swap-retry-in-progress after remove-liquidity already succeeded)
 *     gets `executeExit` called again. No special-casing needed here:
 *     `executeCriticalTransaction`'s own idempotency handles "what to do
 *     next" for each leg.
 *
 * A single position's failure (thrown error, rejected metrics read) never
 * aborts the whole cycle -- same "runs independently per position"
 * philosophy as `monitoring/monitorPositions.ts`'s `runMonitoringCycle`.
 *
 * Live settings (Module 10) are read ONCE per call to this function (i.e.
 * once per exit-cycle tick, not once per position) and reused for every
 * position evaluated this tick -- same "read fresh every cycle, not
 * mutated in place, not read per-candidate" discipline `screeningCycle.ts`
 * uses for capital settings.
 */
export async function runExitCycle(deps: RunExitCycleDeps): Promise<ExitCycleResult[]> {
  const results: ExitCycleResult[] = [];
  const now = new Date();
  // H15 fix: every position the DECIDE pass below already called
  // executeExit for THIS tick (having just moved it ACTIVE -> CLOSING) is
  // recorded here, so the RESUME pass further down -- which queries
  // `findAllClosing()` fresh, and would otherwise find that SAME
  // just-closed-this-tick position again -- skips it. Before this fix,
  // one tick could call `executeExit` twice for the same position: once
  // from DECIDE (immediately after markClosing) and once from RESUME
  // (discovering the same now-CLOSING row moments later in the same
  // function call), doubling real gas spend on an actual swap and
  // inflating `swapAttemptCount`/`attemptCount` at roughly 2x the
  // intended rate.
  const handledThisTick = new Set<string>();

  const liveSettings = await deps.settings.get();
  const exitRules: ExitRules = {
    ...(deps.exitRulesOverride ?? config.rules.exits),
    HARD_STOP_LOSS_PCT: liveSettings.hardStopLossPct,
    TRAILING_TP: { ...config.rules.exits.TRAILING_TP, TRIGGER_PEAK_PNL_PCT: liveSettings.trailingTpTriggerPct },
    // Everything else -- SAFETY_EXIT, OVEREXTENDED, HARD_TAKE_PROFIT_PCT,
    // OOR_PROFIT, LOW_YIELD, OOR -- stays frozen config, never
    // settings-derived (Decision 3a/3b): only the two thresholds the UI
    // actually exposes are hot-swappable, and a value compared against an
    // already-running persisted timer never is.
  };

  // H4 fix: metrics are read for EVERY active position FIRST, in this
  // isolated collection pass, before deciding for ANY of them -- this is
  // what makes the outage-correlation check below possible (it needs to
  // know how many OTHER positions are ALSO failing this same tick).
  const active = await deps.positions.findAllActive();
  const snapshots: Array<{
    position: PositionRecord;
    rawExitState: ExitStateFields;
    metrics: ExitMetricsSnapshot;
    poolPriceState: PoolPriceState | null;
    metricsOk: boolean;
  }> = [];
  for (const position of active) {
    try {
      const rawExitState = await deps.exitStates.getOrCreate(position.id);
      let pnlPct: number | null = null;
      let inRange: boolean | null = null;
      let yieldPct: number | null = null;
      let poolPriceState: PoolPriceState | null = null;
      let metricsOk = false;
      try {
        const [live, price] = await Promise.all([deps.livePositionState.getLiveState(position), deps.poolPrice.getPriceState(position.pool)]);
        poolPriceState = price;
        const metrics = computePositionMetrics(position, live, price);
        if (metrics.ok) {
          pnlPct = metrics.pnlPct;
          inRange = metrics.inRange;
          yieldPct = metrics.yieldPct;
          metricsOk = true;
          // TIER 3: feed the Bollinger window from the price we just
          // read. Only on a genuinely successful read -- a failed or
          // structurally-invalid price must never enter the series that
          // the OVEREXTENDED exit is computed from.
          await recordPriceSample(deps, position, metrics.currentPriceUsdgPerToken, now);
        }
      } catch {
        metricsOk = false;
      }
      // TIER 3: %B is computed from PERSISTED history, so it survives a
      // restart; `null` whenever there aren't yet 20 five-minute closes,
      // which is the normal state for the first ~100 minutes of a pool's
      // observation and must never be confused with "not over-extended."
      const bbPercentB = await computeBbPercentB(deps, position, now);
      const positionAgeMs = position.openedAt === null ? null : now.getTime() - position.openedAt.getTime();

      snapshots.push({
        position,
        rawExitState,
        metrics: { pnlPct, inRange, yieldPct, bbPercentB, positionAgeMs },
        poolPriceState,
        metricsOk,
      });
    } catch (err) {
      results.push({ positionId: position.id, action: 'NONE', outcome: { outcome: 'PENDING', reason: err instanceof Error ? err.message : String(err) } });
    }
  }

  // TIER 3: keep the price-sample table bounded. Best-effort -- a failure
  // to prune must never break a monitoring tick or block an exit.
  if (deps.priceHistory) {
    try {
      await deps.priceHistory.pruneOlderThan(PRICE_HISTORY_RETENTION_MS, now);
    } catch {
      // deliberately swallowed -- see above
    }
  }

  // H4 fix: portfolio-wide correlation signal -- see
  // safetyExit.ts's isMetricsFailureOutageCorrelated doc comment for why
  // this is what prevents a single shared RPC outage from synchronously
  // liquidating every ACTIVE position at once.
  const failingCount = snapshots.filter((s) => !s.metricsOk).length;
  const outageCorrelated = isMetricsFailureOutageCorrelated(failingCount, snapshots.length);

  for (const snap of snapshots) {
    const { position, rawExitState, metrics, poolPriceState, metricsOk } = snap;
    try {
      // Computed FIRST and folded into the exit-state snapshot BEFORE
      // resolveExitDecision runs, specifically so its returned
      // `nextExitState` (which spreads the rest of the record through
      // unmodified) carries the CORRECT value -- persisting a
      // separately-computed value first and resolveExitDecision's stale
      // copy second would silently revert this field on every tick.
      const metricsFailureSince = metricsOk ? null : (rawExitState.metricsFailureSince ?? now);
      const currentExitState: ExitStateFields = { ...rawExitState, metricsFailureSince };

      // H4 fix: the metrics-failure INFRA Safety Exit condition is
      // suppressed when it's correlated with every other active position
      // failing this same tick (a shared outage, not a per-position
      // anomaly). The structurally-invalid-price condition is a per-read
      // data-shape fact, not an outage symptom, and stays unconditional.
      const metricsFailureSafety = evaluateMetricsFailureSafetyExit(metricsFailureSince, now) && !outageCorrelated;
      const priceInvalidSafety = poolPriceState !== null && isPoolPriceStructurallyInvalid(poolPriceState);
      const infraSafetyExitTriggered = metricsFailureSafety || priceInvalidSafety;

      if (!metricsOk && !infraSafetyExitTriggered) {
        // Can't evaluate any PnL-based trigger without metrics, and the
        // infra failure-streak threshold hasn't been crossed yet --
        // still persist the (possibly newly-started) failure streak.
        await deps.exitStates.update(position.id, { metricsFailureSince });
        results.push({ positionId: position.id, action: 'NONE' });
        continue;
      }

      // TIER 3: every metric is passed through as-is, nullable. There are
      // no `?? 0` / `?? true` placeholders any more -- a rule whose input
      // is unavailable simply cannot fire (see resolveExitDecision.ts).
      const { decision, nextExitState } = resolveExitDecision(
        {
          now,
          metrics,
          infraSafetyExitTriggered,
          exitState: currentExitState,
        },
        exitRules,
      );
      await deps.exitStates.update(position.id, nextExitState);

      if (!decision.shouldClose) {
        results.push({ positionId: position.id, action: 'NONE' });
        continue;
      }

      // C4 fix: `pendingCloseReason` is written FIRST, `markClosing`
      // SECOND -- deliberately the opposite of the original order. A
      // crash between these two writes now leaves, at worst, an ACTIVE
      // position with a stale `pendingCloseReason` sitting in `ExitState`
      // -- completely harmless: `resolveExitDecision`'s `nextExitState`
      // spread overwrites/re-derives every other field on the very next
      // tick regardless, and `pendingCloseReason` is never READ until
      // `markClosing` has actually happened. The original order could
      // instead leave a position at CLOSING with `pendingCloseReason:
      // null` -- a state `executeExit.ts`'s `finalizeClose` used to throw
      // on permanently (now additionally hardened with an UNKNOWN
      // fallback, see that file, as defense-in-depth for any OTHER path
      // that could theoretically produce this -- but the real fix is
      // simply never producing it in the first place).
      const closeIdempotencyKey = `exit:${position.id}:${randomUUID()}`;
      await deps.exitStates.update(position.id, { pendingCloseReason: decision.reason });
      await deps.positions.markClosing(position.id, closeIdempotencyKey);
      handledThisTick.add(position.id); // H15: never re-processed by the RESUME pass below, this tick

      const updatedPosition = await deps.positions.findById(position.id);
      if (!updatedPosition) throw new Error(`position ${position.id} vanished immediately after markClosing`);

      const outcome = await executeExit(updatedPosition, deps);
      results.push({ positionId: position.id, action: 'CLOSE_STARTED', outcome });
    } catch (err) {
      results.push({ positionId: position.id, action: 'NONE', outcome: { outcome: 'PENDING', reason: err instanceof Error ? err.message : String(err) } });
    }
  }

  const closing = await deps.positions.findAllClosing();
  for (const position of closing) {
    if (handledThisTick.has(position.id)) continue; // H15: already processed by DECIDE this same tick
    try {
      // H4 fix (part 2): a CLOSING position can only ever be reverted back
      // to ACTIVE here in one narrow, unambiguously safe window -- see
      // tryRecoverFromUnstartedSafetyExit's doc comment.
      const recovered = await tryRecoverFromUnstartedSafetyExit(position, deps, now);
      if (recovered) {
        results.push({ positionId: position.id, action: 'NONE' });
        continue;
      }
      const outcome = await executeExit(position, deps);
      results.push({ positionId: position.id, action: 'RESUMED', outcome });
    } catch (err) {
      results.push({ positionId: position.id, action: 'RESUMED', outcome: { outcome: 'PENDING', reason: err instanceof Error ? err.message : String(err) } });
    }
  }

  return results;
}

/**
 * H4 fix (part 2): reverts a CLOSING position back to ACTIVE if -- and
 * ONLY if -- (a) it was marked CLOSING for INFRA_SAFETY_EXIT specifically
 * (every STRATEGY exit -- HARD_STOP_LOSS, SAFETY_EXIT, OVEREXTENDED,
 * TRAILING_TP, HARD_TP, OOR_PROFIT, LOW_YIELD, OOR_TIMEOUT -- is a real
 * trading decision and is never second-guessed here; only a close caused
 * by the bot being unable to READ is), (b) NO TransactionAttempt row exists
 * AT ALL yet for its remove-liquidity leg, and (c) the safety condition
 * that triggered it no longer holds when re-checked right now.
 *
 * Condition (b) is deliberately "no attempt exists," not "no attempt has
 * reached SENT" or similar -- an attempt sitting at SIGNED could have had
 * an AMBIGUOUS broadcast already fired at it (H3: an ambiguous broadcast
 * error can NEVER be proven not to have landed), so the only signal safe
 * enough to revert on is that `executeExit` was never even called for
 * this position since it became CLOSING. This is exactly the crash-window
 * scenario this fix targets: SAFETY_EXIT decided and `markClosing`
 * persisted, then the process restarted (or the outage resolved) before
 * the very first remove-liquidity attempt was ever made. Once ANY attempt
 * exists -- however far it got, even just SIGNED -- this function refuses
 * to touch the position; a remove-liquidity attempt that reached VERIFIED
 * is never reachable here regardless, since this function bails out the
 * moment it sees ANY attempt row, VERIFIED included.
 */
/**
 * P1 audit fix: this function used to check `removeAttempt !== null` (line
 * below) and then, on a LATER `await`, unconditionally call `markExitFailed`
 * -- a classic TOCTOU window. A concurrent `executeExit` call (a second
 * worker/process, or the DECIDE pass earlier this same tick under a
 * different code path) could create the FIRST `TransactionAttempt` for
 * this position's remove-liquidity leg in the gap between this function's
 * "no attempt exists yet" read and its revert write, so the revert would
 * fire based on already-stale information -- reverting a position back to
 * ACTIVE while a real remove-liquidity transaction is simultaneously being
 * built/broadcast for it. Protected with the SAME ownership-token claim
 * primitive `executeExit` itself uses (P0-1/P1-3): whichever caller wins
 * the claim proceeds; the other sees a failed claim and does nothing here,
 * falling through to its own `executeExit` call, which will also fail to
 * claim and correctly defer (PENDING) rather than duplicate work.
 */
async function tryRecoverFromUnstartedSafetyExit(position: PositionRecord, deps: RunExitCycleDeps, now: Date): Promise<boolean> {
  const exitState = await deps.exitStates.getOrCreate(position.id);
  // TIER 3: keyed on the INFRASTRUCTURE exit specifically. Meridian's
  // `SAFETY_EXIT` (drawdown armed, recovered to breakeven) is a
  // deliberate, data-driven trading decision and is NEVER reverted here --
  // only a close that was caused by the bot being unable to READ is.
  if (exitState.pendingCloseReason !== 'INFRA_SAFETY_EXIT') return false;
  if (!position.closeIdempotencyKey) return false;

  const claimToken = await deps.positions.claimForResume(position.id, 'CLOSING', config.rules.execution.RESUME_CLAIM_FRESHNESS_MS);
  if (claimToken === null) {
    // Another worker already owns this position right now -- possibly
    // mid-flight on the very remove-liquidity attempt this function exists
    // to check for. Never touch it; defer to whoever holds the claim.
    return false;
  }
  try {
    const removeKey = `${position.closeIdempotencyKey}:removeLiquidity`;
    const removeAttempt = await deps.txAttempts.find(removeKey);
    if (removeAttempt !== null) return false; // anything attempted at all -- never touch it here

    let poolPriceState: PoolPriceState | null = null;
    let metricsOk = false;
    try {
      const [live, price] = await Promise.all([deps.livePositionState.getLiveState(position), deps.poolPrice.getPriceState(position.pool)]);
      poolPriceState = price;
      metricsOk = computePositionMetrics(position, live, price).ok;
    } catch {
      metricsOk = false;
    }
    if (!metricsOk) return false; // still can't read -- stay CLOSING, retry next tick

    if (poolPriceState !== null && isPoolPriceStructurallyInvalid(poolPriceState)) return false; // condition genuinely still holds

    // Metrics read fine and the price is structurally valid -- the
    // condition that triggered this SAFETY_EXIT has cleared, and nothing
    // on-chain was ever attempted (re-checked under the claim, not stale).
    // Safe to revert.
    await deps.positions.markExitFailed(position.id);
    await deps.exitStates.update(position.id, { metricsFailureSince: null, pendingCloseReason: null });
    return true;
  } finally {
    // Released whether or not we reverted -- if we return `false` here,
    // the caller falls through to `executeExit`, which claims again itself
    // (a claim held across two separate acquisitions is never assumed).
    await deps.positions.releaseResumeClaim(position.id, claimToken);
  }
}
