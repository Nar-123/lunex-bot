import type { ExitDecision, ExitRules, ExitStateFields } from './types';

export interface ResolveExitDecisionInput {
  now: Date;
  pnlPct: number;
  inRange: boolean;
  /**
   * Computed upstream (see `safetyExit.ts`'s `evaluateSafetyExit`) from
   * conditions that have nothing to do with PNL/range -- sustained
   * metrics-read failure, a structurally invalid pool price read. Passed in
   * as a single boolean so this function stays a pure function of
   * (metrics, state) -> decision, with no I/O and no config-reading beyond
   * the pnlPct/OOR/TP thresholds below.
   */
  safetyExitTriggered: boolean;
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
 * ## Priority order (spec section 8 + explicit review before this module started)
 *
 * ```
 * 1. SAFETY_EXIT     -- abnormal condition, close immediately, no confirm timer
 * 2. HARD_STOP_LOSS   -- PNL <= -15%, close immediately, no confirm timer
 * 3. (PNL_PROTECTION applied here -- see below; never itself closes)
 * 4. TRAILING_TP      -- peak tracking + 2% drawdown + 15s confirm timer
 * 5. OOR              -- 30 min out-of-range grace timer
 * ```
 *
 * WHY this order: (1)/(2) are pure capital-protection -- no reason to wait
 * even one tick once true, so they short-circuit everything else. (3) isn't
 * a competing decision -- PNL_PROTECTION never appears as a `closeReason`
 * (see `types.ts`'s `ExitTriggerReason`) -- it's evaluated between (2) and
 * (4) purely because it changes what threshold (4) arms at, and that must
 * take effect the SAME tick it flips (a position recovering from -8% to 0%
 * in one tick must see the lowered threshold immediately, not next tick).
 * (4) before (5): a timer-confirmed profit-taking signal represents money
 * already on the table; (5) is a capital-efficiency concern (earning zero
 * fees out of range), not a risk one -- realized profit takes precedence
 * over range-efficiency.
 *
 * WHEN A HIGHER-PRIORITY TRIGGER FIRES, lower-priority timer state
 * (`drawdownConfirmStartedAt`, `oorStartedAt`) is deliberately LEFT
 * UNTOUCHED for that tick -- the short-circuit branches return
 * `input.exitState` completely unmodified. This matters concretely: if a
 * price crash trips HARD_STOP_LOSS on the same tick OOR's 30-minute timer
 * would otherwise have elapsed, OOR's timer is neither reset nor advanced
 * -- it's simply not looked at. If the resulting exit then fails and
 * reverts the position to ACTIVE (see `executeExit.ts`), OOR's
 * already-elapsed time is exactly where it was, not lost and not
 * double-counted.
 *
 * ## PNL Protection mechanics (sticky, literal-spec reading -- confirmed in
 * review, not assumed): once PNL ever reaches
 * `EXITS.PNL_PROTECTION.TRIGGER_PNL_PCT` (-8%), `pnlProtectionActivatedAt`
 * is set once and never cleared, even if PNL later recovers. From then on,
 * Trailing TP arms at `EXITS.PNL_PROTECTION.NEW_TP_TARGET_PCT` (0%) instead
 * of `EXITS.TRAILING_TP.TRIGGER_PEAK_PNL_PCT` (+5%) -- using the EXACT SAME
 * peak/drawdown/confirm-timer mechanism as normal Trailing TP, deliberately
 * with NO clamp on the drawdown line. This means PNL can legitimately dip
 * back down to (0% - 2% = -2%) before the confirm timer even starts --
 * this was raised explicitly in review and confirmed as the intended
 * behavior (matches the spec's literal "cuma mengubah parameter Trailing
 * TP" wording), not a bug to be "fixed" with a floor/clamp.
 *
 * ## `rules` is an explicit, required parameter (Module 10)
 *
 * `HARD_STOP_LOSS_PCT` and `TRAILING_TP.TRIGGER_PEAK_PNL_PCT` are
 * live-editable via `settings/`; the composition root (`runExitCycle.ts`)
 * merges the live values over frozen `config.rules.exits` once per
 * exit-cycle tick and passes the result in here. Critically,
 * `PNL_PROTECTION.TRIGGER_PNL_PCT`/`NEW_TP_TARGET_PCT` are NEVER
 * settings-derived -- `runExitCycle.ts` never touches them, so they always
 * resolve from frozen config regardless of what live settings currently
 * say. This function's own branch below (`pnlProtectionActivatedAt !==
 * null ? rules.PNL_PROTECTION.NEW_TP_TARGET_PCT : rules.TRAILING_TP.TRIGGER_PEAK_PNL_PCT`)
 * is what makes that guarantee concrete: once PNL Protection has activated
 * for a position, its arm threshold is ALWAYS the frozen 0%, completely
 * ignoring whatever `rules.TRAILING_TP.TRIGGER_PEAK_PNL_PCT` (live) says --
 * proven with a two-directional test pair in `resolveExitDecision.test.ts`
 * (both "not yet activated, live value applies" AND "already activated,
 * live value ignored"), not assumed safe from reading this branch once.
 */
export function resolveExitDecision(input: ResolveExitDecisionInput, rules: ExitRules): ResolveExitDecisionResult {
  // 1. SAFETY_EXIT -- highest priority, short-circuits everything.
  if (input.safetyExitTriggered) {
    return { decision: { shouldClose: true, reason: 'SAFETY_EXIT' }, nextExitState: input.exitState };
  }

  // 2. HARD_STOP_LOSS -- immediate, no confirm timer.
  if (input.pnlPct <= rules.HARD_STOP_LOSS_PCT) {
    return { decision: { shouldClose: true, reason: 'HARD_STOP_LOSS' }, nextExitState: input.exitState };
  }

  // 3. PNL_PROTECTION -- sticky state update only, never itself closes.
  let pnlProtectionActivatedAt = input.exitState.pnlProtectionActivatedAt;
  if (pnlProtectionActivatedAt === null && input.pnlPct <= rules.PNL_PROTECTION.TRIGGER_PNL_PCT) {
    pnlProtectionActivatedAt = input.now;
  }
  const trailingArmThresholdPct =
    pnlProtectionActivatedAt !== null ? rules.PNL_PROTECTION.NEW_TP_TARGET_PCT : rules.TRAILING_TP.TRIGGER_PEAK_PNL_PCT;

  // 4. TRAILING_TP -- peak tracking (persisted), dynamic drawdown, confirm timer (persisted).
  let trailingPeakPnlPct = input.exitState.trailingPeakPnlPct;
  let drawdownConfirmStartedAt = input.exitState.drawdownConfirmStartedAt;

  if (trailingPeakPnlPct === null) {
    if (input.pnlPct >= trailingArmThresholdPct) {
      trailingPeakPnlPct = input.pnlPct; // arm now, peak starts at current PNL
    }
  } else if (input.pnlPct > trailingPeakPnlPct) {
    trailingPeakPnlPct = input.pnlPct;
    drawdownConfirmStartedAt = null; // a new high cancels any in-progress confirm timer
  }

  let trailingTpTriggered = false;
  if (trailingPeakPnlPct !== null) {
    const drawdownThresholdPct = trailingPeakPnlPct - rules.TRAILING_TP.DRAWDOWN_FROM_PEAK_PCT;
    if (input.pnlPct <= drawdownThresholdPct) {
      if (drawdownConfirmStartedAt === null) {
        drawdownConfirmStartedAt = input.now;
      } else if (input.now.getTime() - drawdownConfirmStartedAt.getTime() >= rules.TRAILING_TP.CONFIRM_WINDOW_MS) {
        trailingTpTriggered = true;
      }
    } else {
      drawdownConfirmStartedAt = null; // recovered back above the drawdown line -- cancel the timer
    }
  }

  const stateAfterTrailing: ExitStateFields = {
    ...input.exitState,
    trailingPeakPnlPct,
    drawdownConfirmStartedAt,
    pnlProtectionActivatedAt,
  };

  if (trailingTpTriggered) {
    return { decision: { shouldClose: true, reason: 'TRAILING_TP' }, nextExitState: stateAfterTrailing };
  }

  // 5. OOR -- lowest priority, only reached if nothing above triggered.
  let oorStartedAt = stateAfterTrailing.oorStartedAt;
  let oorTriggered = false;
  if (!input.inRange) {
    if (oorStartedAt === null) {
      oorStartedAt = input.now;
    } else if (input.now.getTime() - oorStartedAt.getTime() >= rules.OOR.GRACE_WINDOW_MS) {
      oorTriggered = true;
    }
  } else {
    oorStartedAt = null; // back in range -- cancel the timer
  }

  const finalState: ExitStateFields = { ...stateAfterTrailing, oorStartedAt };

  if (oorTriggered) {
    return { decision: { shouldClose: true, reason: 'OOR' }, nextExitState: finalState };
  }

  return { decision: { shouldClose: false }, nextExitState: finalState };
}
