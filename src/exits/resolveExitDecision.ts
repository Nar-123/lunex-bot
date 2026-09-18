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
 * 1. HARD_STOP_LOSS      PnL <= -6%  AND Safety Exit not (yet) armed     immediate, no confirmation
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
 * ## P0-2026 remediation — Hard Stop now YIELDS to an arming/armed Safety Exit
 *
 * PRIOR HISTORY, preserved for context (do not delete): the original TIER 3
 * Meridian-alignment change (migration `20260912000000_tier3_meridian_exit_alignment`)
 * deliberately made Hard Stop (-6%) TIGHTER than Safety Exit's arming point
 * (-8%) and had it "win outright when both are true" -- see that migration
 * and `settings.ts`'s doc comment for the removed cross-field validation
 * this used to require. The practical effect: under smooth, continuous
 * price decline, Hard Stop intercepts and closes the position the moment
 * PnL first crosses -6%, so Safety Exit's arming condition (-8%) was, in
 * practice, never reached -- Safety Exit's own documented "arm at -8%,
 * wait for recovery to 0%" semantics were unreachable dead code along the
 * ordinary path. Flagged as a P0 in a subsequent audit and confirmed with
 * the operator (explicit choice among several possible fixes) rather than
 * silently reinterpreted.
 *
 * FIX: Hard Stop's condition below now ALSO requires `safetyExitArmedAt ===
 * null` (computed fresh THIS tick, using `maxDrawdownPnlPct` which already
 * folds in the current reading -- see the arming block above rule 1). This
 * does NOT make Safety Exit reachable via ordinary smooth decline (a
 * tick-by-tick fall still crosses -6% strictly before -8% and Hard Stop
 * still closes it there, exactly as before -- this is an accepted,
 * understood limitation of a discrete 15s-tick check, not something this
 * fix claims to solve). What it DOES fix: the two realistic paths where a
 * position's drawdown reaches -8% WITHOUT first stopping out at exactly
 * -6% -- (a) a genuine same-tick price gap/jump (volatility spike, a missed
 * tick after a restart) that skips straight past -6% to -8%-or-deeper in
 * one reading, and (b) Hard Stop's own close attempt failing/staying
 * ambiguous (`executeExit` returns PENDING or reverts to ACTIVE) while
 * price keeps falling, so a LATER tick's fresh reading is what actually
 * reaches -8%. In both cases, Safety Exit now arms and takes over instead
 * of Hard Stop force-closing at a price Safety Exit's own "wait for
 * breakeven" logic was specifically designed to improve on. Once armed,
 * `safetyExitArmedAt` is STICKY (never cleared) as it always was, so Hard
 * Stop stays yielded to Safety Exit for the rest of this position's life,
 * even if PnL bounces back above -6% and dips again.
 *
 * WHY this order. (1) and (2) are capital protection and run before any
 * profit-taking: a stop that can be delayed by a yield check is not a
 * stop. (2) sits below (1) in EVALUATION ORDER, but (1) now explicitly
 * defers to (2) once (2) has armed -- "wait for a bounce" IS the decision
 * you make once Safety Exit's own deeper threshold has genuinely been
 * reached, per the operator's explicit resolution of this contradiction;
 * for any drawdown between -6% and -8% that Safety Exit has NOT armed for,
 * Hard Stop still wins immediately, exactly as before. (3) before (4)
 * because Meridian measures over-extension as its best
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
 * ## P1-14 — every `pnlPct` threshold above is principal-only, BY DESIGN,
 * and is NOT expected to match the position's final `realizedUsdgRaw` once closed
 *
 * `metrics.pnlPct` (see `monitoring/types.ts`'s doc comment on
 * `PositionMetrics.pnlPct`) is `(currentValue - entryValue) / entryValue`
 * using LIVE, UNCOLLECTED-FEES-EXCLUDED position value -- every rule above
 * (HARD_STOP_LOSS, SAFETY_EXIT, OVEREXTENDED, TRAILING_TP, HARD_TP,
 * OOR_PROFIT) fires purely off this principal-only number. Separately,
 * `executeExit.ts`'s `computeRealizedProceeds` sets the position's final
 * `realizedUsdgRaw` to the RAW SUM of every USDG transfer actually received
 * across the remove-liquidity and swap legs -- which, because Uniswap v4's
 * `TAKE_PAIR` settlement pays out withdrawn principal and any
 * accrued-but-uncollected fees TOGETHER in one settlement (see
 * `removeLiquidityTx.ts`'s doc comment), is principal PLUS whatever fees
 * happened to be collected in that same transaction, combined and never
 * separately labeled.
 *
 * These are two DELIBERATELY DIFFERENT numbers, confirmed via explicit
 * operator decision (same category of decision as the Hard-Stop-vs-
 * Safety-Exit precedence fix documented above): a position that fires
 * HARD_STOP_LOSS at exactly `pnlPct <= -6%` can legitimately show a
 * smaller loss (or even a gain) in its persisted `realizedUsdgRaw -
 * entryUsdgRaw` once accumulated fees are folded in at close -- this is
 * NOT a bug, NOT something either number should be "corrected" to match,
 * and NOT evidence the trigger threshold was computed wrong. `pnlPct`
 * answers "should we exit, based on the position's own principal
 * performance" (the risk question); `realizedUsdgRaw` answers "how much
 * USDG did we actually get back" (the accounting question). Do not add
 * logic anywhere that reconciles, cross-validates, or expects these two
 * to converge -- see `tests/exits/resolveExitDecision.test.ts`'s "P1-14"
 * boundary tests for worked examples of the divergence this documents.
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
  // P0-3 fix: yields to Safety Exit once armed (this tick or a prior one)
  // -- see this function's doc comment for the full mechanism and the
  // prior "Hard Stop always wins" history this changes.
  if (pnlPct !== null && pnlPct <= rules.HARD_STOP_LOSS_PCT && safetyExitArmedAt === null) {
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
