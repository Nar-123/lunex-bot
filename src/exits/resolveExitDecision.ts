import type { ExitDecision, ExitMetricsSnapshot, ExitRules, ExitStateFields } from './types';

export interface ResolveExitDecisionInput {
  now: Date;
  /** Every reading this decision is made from -- all nullable, see `ExitMetricsSnapshot`. */
  metrics: ExitMetricsSnapshot;
  /**
   * Lunex's INFRASTRUCTURE-fault exit (unreadable metrics for >5 minutes,
   * or a structurally impossible pool price), computed upstream by
   * `safetyExit.ts` because it depends on I/O outcomes and on whether the
   * failure is correlated across the whole portfolio (Tier 2 H4). Passed
   * in as a single boolean so this function stays pure. NOT the same thing
   * as Meridian's `SAFETY_EXIT` drawdown rule below.
   */
  infraSafetyExitTriggered: boolean;
  exitState: ExitStateFields;
}

export interface ResolveExitDecisionResult {
  decision: ExitDecision;
  nextExitState: ExitStateFields;
}

/**
 * Pure function (no I/O -- same discipline as `capital/decideCapitalAllocation.ts`):
 * decides whether a position should close THIS tick and, if so, why, given
 * its current live metrics and its persisted exit state -- and returns the
 * updated state to persist, whether or not a close was decided.
 *
 * ## TIER 3 — the Meridian exit ladder
 *
 * The ORDER BELOW IS THE POLICY. It is taken from Meridian's measured
 * strategy (`docs/strategy.md` §4) and must not be reordered without a
 * demonstrated correctness reason:
 *
 * ```
 * 1. HARD_STOP_LOSS      PnL <= -6%                      immediate, no confirmation
 * 2. SAFETY_EXIT         armed (max DD <= -8%) && PnL >= 0%
 * 3. OVEREXTENDED        %B >= 1.0 && PnL > 0
 * 4. TRAILING_TP         arm +6%, -3pp from peak, 15s confirm
 * 5. HARD_TP             PnL >= +25%                     immediate, no confirmation
 * 6. OOR_PROFIT          out of range && PnL >= +2%
 * 7. LOW_YIELD           age >= 30min && fee yield < floor
 * 8. OOR_TIMEOUT         out of range past the 30-minute grace window
 * 8. INFRA_SAFETY_EXIT   infrastructure fault
 * ```
 *
 * WHY this order. (1) and (2) are capital protection and run before any
 * profit-taking: a stop that can be delayed by a yield check is not a
 * stop. (2) sits below (1) deliberately -- if a position is both armed for
 * recovery AND through the stop, the stop wins, because "wait for a
 * bounce" is not a decision you make at -9% when your own rule says cut at
 * -6%. (3) before (4) because Meridian measures over-extension as its best
 * exit ("captures the peak almost exactly"), while trailing admits to
 * giving back ~5pp of the 3pp it promises -- when both fire, taking the
 * sharper one is strictly better. (5) after (4) because a position at +25%
 * that is ALSO 3pp off its peak is already being closed by (4) at a price
 * (4) picked; (5) exists to catch the position that rockets past +25%
 * without ever pulling back enough to arm a trailing confirmation. (6)/(7)
 * are capital-efficiency, not risk: banking idle or unproductive capital
 * is right, but never at the cost of delaying a risk exit above it. (8) is
 * unchanged pre-existing Lunex protection.
 *
 * ## Infrastructure failure is not a trading signal
 *
 * Every metric in `input.metrics` is nullable and every rule that needs
 * one is guarded. A failed RPC read produces `pnlPct: null`, and NO
 * PnL-based rule can fire on it -- not even accidentally, because there is
 * no placeholder value to mistake for a reading. The same holds for `%B`
 * (a fresh pool has <20 five-minute closes and is simply unavailable),
 * `yieldPct`, and `inRange`.
 *
 * `inRange: null` specifically leaves `oorStartedAt` EXACTLY as it was --
 * neither advanced nor cleared. The pre-Tier-3 orchestrator passed
 * `inRange ?? true`, which silently RESET a running 29-minute OOR timer on
 * any single failed metrics read.
 *
 * ## When a higher-priority trigger fires
 *
 * Lower-priority timer state (`drawdownConfirmStartedAt`, `oorStartedAt`)
 * is deliberately LEFT UNTOUCHED for that tick -- the short-circuit
 * branches return the state they were handed. If the resulting exit then
 * fails definitively and reverts the position to ACTIVE (see
 * `executeExit.ts`), those timers are exactly where they were, neither
 * lost nor double-counted.
 *
 * State that must survive a restart identically -- `safetyExitArmedAt`,
 * `maxDrawdownPnlPct`, `trailingPeakPnlPct`, `drawdownConfirmStartedAt`,
 * `oorStartedAt` -- is all returned in `nextExitState` for the caller to
 * persist, and is read back from storage on the next tick. Given the same
 * market data, the decision after a restart is the decision before it.
 *
 * `rules` is an explicit, required parameter: `HARD_STOP_LOSS_PCT` and
 * `TRAILING_TP.TRIGGER_PEAK_PNL_PCT` are live-editable via `settings/`,
 * and `runExitCycle.ts` merges the live values over frozen
 * `config.rules.exits` once per tick before calling this.
 */
export function resolveExitDecision(input: ResolveExitDecisionInput, rules: ExitRules): ResolveExitDecisionResult {
  const { now, metrics } = input;
  const { pnlPct, inRange, yieldPct, bbPercentB, positionAgeMs } = metrics;

  // ---- state updates that happen on EVERY tick, before any decision ----
  // Max drawdown must be tracked even on a tick that closes for some other
  // reason, and even while a higher-priority rule short-circuits below.
  const maxDrawdownPnlPct =
    pnlPct === null
      ? input.exitState.maxDrawdownPnlPct
      : input.exitState.maxDrawdownPnlPct === null
        ? pnlPct
        : Math.min(input.exitState.maxDrawdownPnlPct, pnlPct);

  // Safety Exit arms on maximum drawdown and is STICKY -- once armed it is
  // never cleared, so a later move back below the target cannot disarm it.
  let safetyExitArmedAt = input.exitState.safetyExitArmedAt;
  if (
    rules.SAFETY_EXIT.ENABLED &&
    safetyExitArmedAt === null &&
    maxDrawdownPnlPct !== null &&
    maxDrawdownPnlPct <= rules.SAFETY_EXIT.TRIGGER_PCT
  ) {
    safetyExitArmedAt = now;
  }

  const baseState: ExitStateFields = { ...input.exitState, maxDrawdownPnlPct, safetyExitArmedAt };

  // ---- 1. HARD_STOP_LOSS -- immediate, no confirmation timer ----------
  if (pnlPct !== null && pnlPct <= rules.HARD_STOP_LOSS_PCT) {
    return { decision: { shouldClose: true, reason: 'HARD_STOP_LOSS' }, nextExitState: baseState };
  }

  // ---- 2. SAFETY_EXIT -- armed by drawdown, closes on recovery --------
  if (rules.SAFETY_EXIT.ENABLED && safetyExitArmedAt !== null && pnlPct !== null && pnlPct >= rules.SAFETY_EXIT.TARGET_PCT) {
    return { decision: { shouldClose: true, reason: 'SAFETY_EXIT' }, nextExitState: baseState };
  }

  // ---- 3. OVEREXTENDED -- %B pierced the upper band, while in profit --
  // `bbPercentB === null` (insufficient history / unavailable) can never
  // reach this branch: an unavailable indicator is not a sell signal.
  if (rules.OVEREXTENDED.ENABLED && bbPercentB !== null && bbPercentB >= rules.OVEREXTENDED.BB_PERCENT_B && pnlPct !== null && pnlPct > 0) {
    return { decision: { shouldClose: true, reason: 'OVEREXTENDED' }, nextExitState: baseState };
  }

  // ---- 4. TRAILING_TP -- peak tracking + percentage-POINT drawdown ----
  let trailingPeakPnlPct = baseState.trailingPeakPnlPct;
  let drawdownConfirmStartedAt = baseState.drawdownConfirmStartedAt;
  let trailingTpTriggered = false;

  if (rules.TRAILING_TP.ENABLED && pnlPct !== null) {
    if (trailingPeakPnlPct === null) {
      if (pnlPct >= rules.TRAILING_TP.TRIGGER_PEAK_PNL_PCT) {
        trailingPeakPnlPct = pnlPct; // arm now, peak starts at current PnL
      }
    } else if (pnlPct > trailingPeakPnlPct) {
      trailingPeakPnlPct = pnlPct; // the peak only ever moves up
      drawdownConfirmStartedAt = null; // a new high cancels any pending confirmation
    }

    if (trailingPeakPnlPct !== null) {
      // ABSOLUTE percentage-point drop from the peak, not a multiplicative
      // haircut: peak +11% with a 3pp rule closes at +8%, NOT at +10.67%.
      const drawdownThresholdPct = trailingPeakPnlPct - rules.TRAILING_TP.DRAWDOWN_FROM_PEAK_PCT;
      if (pnlPct <= drawdownThresholdPct) {
        if (drawdownConfirmStartedAt === null) {
          drawdownConfirmStartedAt = now; // start the 15s confirmation
        } else if (now.getTime() - drawdownConfirmStartedAt.getTime() >= rules.TRAILING_TP.CONFIRM_WINDOW_MS) {
          trailingTpTriggered = true;
        }
      } else {
        drawdownConfirmStartedAt = null; // recovered above the line -- cancel the pending exit
      }
    }
  }

  const stateAfterTrailing: ExitStateFields = { ...baseState, trailingPeakPnlPct, drawdownConfirmStartedAt };

  if (trailingTpTriggered) {
    return { decision: { shouldClose: true, reason: 'TRAILING_TP' }, nextExitState: stateAfterTrailing };
  }

  // ---- 5. HARD_TP -- hard ceiling, no confirmation --------------------
  if (pnlPct !== null && pnlPct >= rules.HARD_TAKE_PROFIT_PCT) {
    return { decision: { shouldClose: true, reason: 'HARD_TP' }, nextExitState: stateAfterTrailing };
  }

  // ---- 6. OOR_PROFIT -- bank idle capital that is already in profit ---
  if (rules.OOR_PROFIT.ENABLED && inRange === false && pnlPct !== null && pnlPct >= rules.OOR_PROFIT.MIN_PNL_PCT) {
    return { decision: { shouldClose: true, reason: 'OOR_PROFIT' }, nextExitState: stateAfterTrailing };
  }

  // ---- 7. LOW_YIELD -- only after the position has had time to earn ---
  // Requires BOTH a known age past the floor AND a known yield. Missing
  // fee/TVL telemetry never closes a position.
  if (
    rules.LOW_YIELD.ENABLED &&
    positionAgeMs !== null &&
    positionAgeMs >= rules.LOW_YIELD.MIN_AGE_MS &&
    yieldPct !== null &&
    yieldPct < rules.LOW_YIELD.MIN_FEE_YIELD_PCT
  ) {
    return { decision: { shouldClose: true, reason: 'LOW_YIELD' }, nextExitState: stateAfterTrailing };
  }

  // ---- 8a. OOR_TIMEOUT -- pre-existing unprofitable-OOR grace window --
  // `inRange === null` leaves the timer untouched (see doc comment).
  let oorStartedAt = stateAfterTrailing.oorStartedAt;
  let oorTimeoutTriggered = false;
  if (inRange === false) {
    if (oorStartedAt === null) {
      oorStartedAt = now;
    } else if (now.getTime() - oorStartedAt.getTime() >= rules.OOR.GRACE_WINDOW_MS) {
      oorTimeoutTriggered = true;
    }
  } else if (inRange === true) {
    oorStartedAt = null; // back in range -- cancel the timer
  }

  const finalState: ExitStateFields = { ...stateAfterTrailing, oorStartedAt };

  if (oorTimeoutTriggered) {
    return { decision: { shouldClose: true, reason: 'OOR_TIMEOUT' }, nextExitState: finalState };
  }

  // ---- 8b. INFRA_SAFETY_EXIT -- data-integrity guard, not a strategy --
  // Last, because it is only ever true when the metrics above are
  // unavailable, in which case every rule above has already declined to
  // fire. Evaluating it here rather than first keeps the ladder above
  // exactly as Meridian specifies it, with identical behaviour.
  if (input.infraSafetyExitTriggered) {
    return { decision: { shouldClose: true, reason: 'INFRA_SAFETY_EXIT' }, nextExitState: finalState };
  }

  return { decision: { shouldClose: false }, nextExitState: finalState };
}
