import { describe, expect, it } from 'vitest';
import { resolveExitDecision } from '../../src/exits/resolveExitDecision';
import type { ResolveExitDecisionInput } from '../../src/exits/resolveExitDecision';
import { EMPTY_EXIT_STATE } from '../../src/exits/types';
import type { ExitMetricsSnapshot, ExitRules, ExitStateFields } from '../../src/exits/types';
import { config } from '../../src/config';

/**
 * TIER 3 — the Meridian exit ladder, exercised rule by rule and boundary
 * by boundary. Every threshold asserted here is Meridian's measured value
 * (`docs/strategy.md` §4 + `backend/src/config/types.rs`), so a silent
 * drift back toward Lunex's old placeholders (-15% stop, +5%/-2% trailing)
 * fails a test rather than quietly changing how real money is traded.
 */

const T0 = new Date('2026-01-01T00:00:00.000Z');
const state = (overrides: Partial<ExitStateFields> = {}): ExitStateFields => ({ ...EMPTY_EXIT_STATE, ...overrides });

/** Same shape `runExitCycle.ts` builds every tick (frozen config, no live-settings override). */
const RULES: ExitRules = config.rules.exits;

/** Every metric present and neutral, so each test only varies what it is about. */
function metrics(overrides: Partial<ExitMetricsSnapshot> = {}): ExitMetricsSnapshot {
  return { pnlPct: 0, inRange: true, yieldPct: 1, bbPercentB: null, positionAgeMs: 0, ...overrides };
}

function decide(overrides: Partial<ResolveExitDecisionInput> = {}, rules: ExitRules = RULES) {
  return resolveExitDecision(
    { now: T0, metrics: metrics(), infraSafetyExitTriggered: false, exitState: state(), ...overrides },
    rules,
  );
}

describe('resolveExitDecision -- TIER 3 config values match Meridian exactly', () => {
  it('carries Meridian\'s measured numbers, not Lunex\'s old placeholders', () => {
    expect(RULES.HARD_STOP_LOSS_PCT).toBe(-0.06); // not -0.15
    expect(RULES.SAFETY_EXIT.TRIGGER_PCT).toBe(-0.08);
    expect(RULES.SAFETY_EXIT.TARGET_PCT).toBe(0);
    expect(RULES.OVEREXTENDED.BB_PERCENT_B).toBe(1.0);
    expect(RULES.TRAILING_TP.TRIGGER_PEAK_PNL_PCT).toBe(0.06); // not 0.05
    expect(RULES.TRAILING_TP.DRAWDOWN_FROM_PEAK_PCT).toBe(0.03); // not 0.02
    expect(RULES.TRAILING_TP.CONFIRM_WINDOW_MS).toBe(15_000);
    expect(RULES.HARD_TAKE_PROFIT_PCT).toBe(0.25);
    expect(RULES.OOR_PROFIT.MIN_PNL_PCT).toBe(0.02);
    expect(RULES.LOW_YIELD.MIN_AGE_MS).toBe(30 * 60 * 1000); // 30min, not 60
  });
});

describe('PRIORITY 1 -- HARD_STOP_LOSS (-6%)', () => {
  it('does not close at -5.99%', () => {
    expect(decide({ metrics: metrics({ pnlPct: -0.0599 }) }).decision.shouldClose).toBe(false);
  });

  it('closes at exactly -6.00% (inclusive boundary, no confirmation timer)', () => {
    expect(decide({ metrics: metrics({ pnlPct: -0.06 }) }).decision).toEqual({ shouldClose: true, reason: 'HARD_STOP_LOSS' });
  });

  it('closes at -7.00%', () => {
    expect(decide({ metrics: metrics({ pnlPct: -0.07 }) }).decision).toEqual({ shouldClose: true, reason: 'HARD_STOP_LOSS' });
  });

  it('never fires on a missing PnL reading -- an unreadable position is not a losing one', () => {
    expect(decide({ metrics: metrics({ pnlPct: null }) }).decision.shouldClose).toBe(false);
  });

  it('wins over an already-armed SAFETY_EXIT (explicit priority requirement)', () => {
    // Armed AND recovered would normally be SAFETY_EXIT, but this PnL is
    // through the stop, so the stop takes it.
    const armed = state({ safetyExitArmedAt: T0, maxDrawdownPnlPct: -0.09 });
    const { decision } = decide({ metrics: metrics({ pnlPct: -0.09 }), exitState: armed });
    expect(decision).toEqual({ shouldClose: true, reason: 'HARD_STOP_LOSS' });
  });
});

describe('PRIORITY 2 -- SAFETY_EXIT (arm at max drawdown -8%, close on recovery to 0%)', () => {
  /** Stop loss widened past the arming point, which is the only configuration where this rule can produce a close -- see EXITS.SAFETY_EXIT's doc comment. */
  const WIDE_STOP: ExitRules = { ...RULES, HARD_STOP_LOSS_PCT: -0.5 };

  it('does not arm at a max drawdown of -7.99%', () => {
    const { nextExitState } = decide({ metrics: metrics({ pnlPct: -0.0799 }) }, WIDE_STOP);
    expect(nextExitState.safetyExitArmedAt).toBeNull();
    expect(nextExitState.maxDrawdownPnlPct).toBeCloseTo(-0.0799, 6);
  });

  it('arms at exactly -8.00% (inclusive boundary) without closing while still underwater', () => {
    const { decision, nextExitState } = decide({ metrics: metrics({ pnlPct: -0.08 }) }, WIDE_STOP);
    expect(nextExitState.safetyExitArmedAt).toEqual(T0);
    expect(decision.shouldClose).toBe(false); // waits for the recovery, never closes into the hole
  });

  it('armed + still at -5%: stays open, waiting for recovery', () => {
    const armed = state({ safetyExitArmedAt: T0, maxDrawdownPnlPct: -0.09 });
    expect(decide({ metrics: metrics({ pnlPct: -0.05 }), exitState: armed }, WIDE_STOP).decision.shouldClose).toBe(false);
  });

  it('armed + recovered to exactly 0%: closes', () => {
    const armed = state({ safetyExitArmedAt: T0, maxDrawdownPnlPct: -0.09 });
    expect(decide({ metrics: metrics({ pnlPct: 0 }), exitState: armed }, WIDE_STOP).decision).toEqual({
      shouldClose: true,
      reason: 'SAFETY_EXIT',
    });
  });

  it('armed + recovered to +1%: closes', () => {
    const armed = state({ safetyExitArmedAt: T0, maxDrawdownPnlPct: -0.09 });
    expect(decide({ metrics: metrics({ pnlPct: 0.01 }), exitState: armed }, WIDE_STOP).decision).toEqual({
      shouldClose: true,
      reason: 'SAFETY_EXIT',
    });
  });

  it('arms off MAX DRAWDOWN, not the current reading -- a dip to -9% then a bounce to -1% in one gap still arms', () => {
    // Tick 1: the dip is observed and recorded.
    const afterDip = decide({ metrics: metrics({ pnlPct: -0.09 }) }, WIDE_STOP).nextExitState;
    expect(afterDip.safetyExitArmedAt).toEqual(T0);
    // Tick 2: price has already bounced; the arming must survive it.
    const afterBounce = decide({ metrics: metrics({ pnlPct: -0.01 }), exitState: afterDip }, WIDE_STOP);
    expect(afterBounce.nextExitState.safetyExitArmedAt).toEqual(T0);
    expect(afterBounce.nextExitState.maxDrawdownPnlPct).toBeCloseTo(-0.09, 6);
  });

  it('is STICKY: a later dip back below the target cannot disarm it', () => {
    const armed = state({ safetyExitArmedAt: T0, maxDrawdownPnlPct: -0.09 });
    const later = new Date(T0.getTime() + 60_000);
    const { nextExitState } = decide({ now: later, metrics: metrics({ pnlPct: -0.04 }), exitState: armed }, WIDE_STOP);
    expect(nextExitState.safetyExitArmedAt).toEqual(T0); // unchanged, not cleared
  });

  it('survives a restart: armed state read back from storage still closes on recovery', () => {
    // "Restart" = the exact persisted row, handed to a fresh call.
    const persisted = decide({ metrics: metrics({ pnlPct: -0.09 }) }, WIDE_STOP).nextExitState;
    const reloaded = state({ safetyExitArmedAt: persisted.safetyExitArmedAt, maxDrawdownPnlPct: persisted.maxDrawdownPnlPct });
    const afterRestart = decide({ metrics: metrics({ pnlPct: 0.005 }), exitState: reloaded }, WIDE_STOP);
    expect(afterRestart.decision).toEqual({ shouldClose: true, reason: 'SAFETY_EXIT' });
  });

  it('tracks max drawdown even on a tick that closes for a different reason', () => {
    const { nextExitState } = decide({ metrics: metrics({ pnlPct: -0.2 }) }); // default rules -> HARD_STOP_LOSS
    expect(nextExitState.maxDrawdownPnlPct).toBeCloseTo(-0.2, 6);
  });
});

describe('PRIORITY 3 -- OVEREXTENDED (Bollinger %B >= 1.0 while in profit)', () => {
  it('does not close at %B 0.99', () => {
    expect(decide({ metrics: metrics({ bbPercentB: 0.99, pnlPct: 0.05 }) }).decision.shouldClose).toBe(false);
  });

  it('closes at %B exactly 1.00 when PnL is positive', () => {
    expect(decide({ metrics: metrics({ bbPercentB: 1.0, pnlPct: 0.05 }) }).decision).toEqual({
      shouldClose: true,
      reason: 'OVEREXTENDED',
    });
  });

  it('closes when %B pierces well past the band (1.4) in profit', () => {
    expect(decide({ metrics: metrics({ bbPercentB: 1.4, pnlPct: 0.01 }) }).decision).toEqual({
      shouldClose: true,
      reason: 'OVEREXTENDED',
    });
  });

  it('does NOT close at %B 1.00 when PnL is negative -- never realises a loss on this rule', () => {
    expect(decide({ metrics: metrics({ bbPercentB: 1.0, pnlPct: -0.02 }) }).decision.shouldClose).toBe(false);
  });

  it('does NOT close at %B 1.00 when PnL is exactly 0 (strictly-in-profit requirement)', () => {
    expect(decide({ metrics: metrics({ bbPercentB: 1.0, pnlPct: 0 }) }).decision.shouldClose).toBe(false);
  });

  it('unavailable %B (null) never forces an exit, even deep in profit', () => {
    expect(decide({ metrics: metrics({ bbPercentB: null, pnlPct: 0.2 }) }).decision.shouldClose).toBe(false);
  });

  it('unavailable PnL never forces an exit even with %B over the band', () => {
    expect(decide({ metrics: metrics({ bbPercentB: 1.5, pnlPct: null }) }).decision.shouldClose).toBe(false);
  });

  it('is skipped entirely when disabled', () => {
    const off: ExitRules = { ...RULES, OVEREXTENDED: { ...RULES.OVEREXTENDED, ENABLED: false } };
    expect(decide({ metrics: metrics({ bbPercentB: 1.5, pnlPct: 0.05 }) }, off).decision.shouldClose).toBe(false);
  });
});

describe('PRIORITY 4 -- TRAILING_TP (arm +6%, -3 percentage points from peak, 15s confirm)', () => {
  it('does not arm at +5.99%', () => {
    const { nextExitState } = decide({ metrics: metrics({ pnlPct: 0.0599 }) });
    expect(nextExitState.trailingPeakPnlPct).toBeNull();
  });

  it('arms at exactly +6.00%, with the peak starting at the current PnL', () => {
    const { nextExitState } = decide({ metrics: metrics({ pnlPct: 0.06 }) });
    expect(nextExitState.trailingPeakPnlPct).toBeCloseTo(0.06, 6);
  });

  it('the peak only ever moves UP', () => {
    const armed = state({ trailingPeakPnlPct: 0.1 });
    const { nextExitState } = decide({ metrics: metrics({ pnlPct: 0.08 }), exitState: armed });
    expect(nextExitState.trailingPeakPnlPct).toBeCloseTo(0.1, 6); // not lowered to 0.08
  });

  it('peak +10%, current +8.1%: only a 1.9pp fall, no confirmation started', () => {
    const armed = state({ trailingPeakPnlPct: 0.1 });
    const { decision, nextExitState } = decide({ metrics: metrics({ pnlPct: 0.081 }), exitState: armed });
    expect(decision.shouldClose).toBe(false);
    expect(nextExitState.drawdownConfirmStartedAt).toBeNull();
  });

  it('peak +10%, current +7.0%: a 3pp fall starts the 15s confirmation but does not close yet', () => {
    const armed = state({ trailingPeakPnlPct: 0.1 });
    const { decision, nextExitState } = decide({ metrics: metrics({ pnlPct: 0.07 }), exitState: armed });
    expect(decision.shouldClose).toBe(false);
    expect(nextExitState.drawdownConfirmStartedAt).toEqual(T0);
  });

  it('the drop is PERCENTAGE POINTS, not a multiplicative haircut: peak +11% breaches at +8%, and +10.67% is NOT a breach', () => {
    const armed = state({ trailingPeakPnlPct: 0.11 });
    // A multiplicative reading (11% x 0.97 = 10.67%) would have started a
    // confirmation here. The point-based rule must not.
    expect(decide({ metrics: metrics({ pnlPct: 0.1067 }), exitState: armed }).nextExitState.drawdownConfirmStartedAt).toBeNull();
    // 11% - 3pp = 8% exactly -> breach.
    expect(decide({ metrics: metrics({ pnlPct: 0.08 }), exitState: armed }).nextExitState.drawdownConfirmStartedAt).toEqual(T0);
  });

  it('closes once the breach has held for the full 15 seconds', () => {
    const pending = state({ trailingPeakPnlPct: 0.1, drawdownConfirmStartedAt: T0 });
    const at15s = new Date(T0.getTime() + 15_000);
    expect(decide({ now: at15s, metrics: metrics({ pnlPct: 0.07 }), exitState: pending }).decision).toEqual({
      shouldClose: true,
      reason: 'TRAILING_TP',
    });
  });

  it('does not close one millisecond early', () => {
    const pending = state({ trailingPeakPnlPct: 0.1, drawdownConfirmStartedAt: T0 });
    const justShy = new Date(T0.getTime() + 14_999);
    expect(decide({ now: justShy, metrics: metrics({ pnlPct: 0.07 }), exitState: pending }).decision.shouldClose).toBe(false);
  });

  it('CANCELS a pending confirmation when price recovers back above the drawdown line', () => {
    const pending = state({ trailingPeakPnlPct: 0.1, drawdownConfirmStartedAt: T0 });
    const later = new Date(T0.getTime() + 10_000);
    const { decision, nextExitState } = decide({ now: later, metrics: metrics({ pnlPct: 0.09 }), exitState: pending });
    expect(decision.shouldClose).toBe(false);
    expect(nextExitState.drawdownConfirmStartedAt).toBeNull();
  });

  it('a NEW high cancels a pending confirmation and raises the peak', () => {
    const pending = state({ trailingPeakPnlPct: 0.1, drawdownConfirmStartedAt: T0 });
    const later = new Date(T0.getTime() + 10_000);
    const { nextExitState } = decide({ now: later, metrics: metrics({ pnlPct: 0.12 }), exitState: pending });
    expect(nextExitState.trailingPeakPnlPct).toBeCloseTo(0.12, 6);
    expect(nextExitState.drawdownConfirmStartedAt).toBeNull();
  });

  it('restart while armed preserves the peak (decision is identical either side of a restart)', () => {
    const armed = decide({ metrics: metrics({ pnlPct: 0.1 }) }).nextExitState;
    const reloaded = state({ trailingPeakPnlPct: armed.trailingPeakPnlPct });
    const { nextExitState } = decide({ metrics: metrics({ pnlPct: 0.09 }), exitState: reloaded });
    expect(nextExitState.trailingPeakPnlPct).toBeCloseTo(0.1, 6);
  });

  it('restart DURING confirmation preserves the timer -- it does not restart the 15 seconds', () => {
    const pending = decide({ metrics: metrics({ pnlPct: 0.07 }), exitState: state({ trailingPeakPnlPct: 0.1 }) }).nextExitState;
    expect(pending.drawdownConfirmStartedAt).toEqual(T0);
    // Process restarts; the persisted row is read back and the window
    // elapses measured from the ORIGINAL start, not from the restart.
    const reloaded = state({ trailingPeakPnlPct: 0.1, drawdownConfirmStartedAt: pending.drawdownConfirmStartedAt });
    const at15s = new Date(T0.getTime() + 15_000);
    expect(decide({ now: at15s, metrics: metrics({ pnlPct: 0.07 }), exitState: reloaded }).decision).toEqual({
      shouldClose: true,
      reason: 'TRAILING_TP',
    });
  });

  it('is skipped entirely when disabled', () => {
    const off: ExitRules = { ...RULES, TRAILING_TP: { ...RULES.TRAILING_TP, ENABLED: false } };
    const pending = state({ trailingPeakPnlPct: 0.1, drawdownConfirmStartedAt: T0 });
    const at15s = new Date(T0.getTime() + 15_000);
    expect(decide({ now: at15s, metrics: metrics({ pnlPct: 0.07 }), exitState: pending }, off).decision.shouldClose).toBe(false);
  });
});

describe('PRIORITY 5 -- HARD_TP (+25%)', () => {
  it('does not close at +24.99%', () => {
    // Trailing is deliberately not armed/breached here, so only HARD_TP could fire.
    expect(decide({ metrics: metrics({ pnlPct: 0.2499 }) }).decision.shouldClose).toBe(false);
  });

  it('closes at exactly +25.00%', () => {
    expect(decide({ metrics: metrics({ pnlPct: 0.25 }) }).decision).toEqual({ shouldClose: true, reason: 'HARD_TP' });
  });

  it('closes at +30%', () => {
    expect(decide({ metrics: metrics({ pnlPct: 0.3 }) }).decision).toEqual({ shouldClose: true, reason: 'HARD_TP' });
  });

  it('still arms trailing on the way through, so a later pullback is covered too', () => {
    const { nextExitState } = decide({ metrics: metrics({ pnlPct: 0.3 }) });
    expect(nextExitState.trailingPeakPnlPct).toBeCloseTo(0.3, 6);
  });

  it('a CONFIRMED trailing exit takes precedence over HARD_TP on the same tick', () => {
    // Peak +30%, now +26%: past the hard ceiling AND 4pp off the peak with
    // the confirmation already elapsed. Trailing is priority 4.
    const pending = state({ trailingPeakPnlPct: 0.3, drawdownConfirmStartedAt: T0 });
    const at15s = new Date(T0.getTime() + 15_000);
    expect(decide({ now: at15s, metrics: metrics({ pnlPct: 0.26 }), exitState: pending }).decision).toEqual({
      shouldClose: true,
      reason: 'TRAILING_TP',
    });
  });
});

describe('PRIORITY 6 -- OOR_PROFIT (out of range and >= +2%)', () => {
  it('does not close out of range at +1.99%', () => {
    expect(decide({ metrics: metrics({ inRange: false, pnlPct: 0.0199 }) }).decision.shouldClose).toBe(false);
  });

  it('closes out of range at exactly +2.00%', () => {
    expect(decide({ metrics: metrics({ inRange: false, pnlPct: 0.02 }) }).decision).toEqual({
      shouldClose: true,
      reason: 'OOR_PROFIT',
    });
  });

  it('does NOT close IN range at +2% -- being in range means the capital is still working', () => {
    expect(decide({ metrics: metrics({ inRange: true, pnlPct: 0.02 }) }).decision.shouldClose).toBe(false);
  });

  it('does not fire on an unknown range status', () => {
    expect(decide({ metrics: metrics({ inRange: null, pnlPct: 0.05 }) }).decision.shouldClose).toBe(false);
  });

  it('still starts the OOR timeout clock on the same tick it declines to bank', () => {
    const { nextExitState } = decide({ metrics: metrics({ inRange: false, pnlPct: 0.01 }) });
    expect(nextExitState.oorStartedAt).toEqual(T0);
  });
});

describe('PRIORITY 7 -- LOW_YIELD (age >= 30min AND fee yield below the floor)', () => {
  const LOW = RULES.LOW_YIELD.MIN_FEE_YIELD_PCT / 2;
  const MIN_AGE = RULES.LOW_YIELD.MIN_AGE_MS;

  /**
   * Validation phase: LOW_YIELD ships DISABLED (Lunex cannot reproduce
   * Meridian's pool-level 24h fee/TVL metric -- see EXITS.LOW_YIELD's doc
   * comment). Every behavioural test in this block therefore runs against
   * an explicitly-enabled copy of the rule: the rule's LOGIC is unchanged
   * and must stay provably correct for whenever a real fee/TVL feed is
   * wired in and the single ENABLED flag flips.
   */
  const ON: ExitRules = { ...RULES, LOW_YIELD: { ...RULES.LOW_YIELD, ENABLED: true } };

  it('does NOT fire at all under the shipped (disabled) default, whatever the metrics', () => {
    expect(decide({ metrics: metrics({ positionAgeMs: MIN_AGE, yieldPct: LOW }) }).decision.shouldClose).toBe(false);
  });

  it('does NOT close at 29 minutes even with a low yield -- the age floor is deliberate', () => {
    const age = 29 * 60 * 1000;
    expect(decide({ metrics: metrics({ positionAgeMs: age, yieldPct: LOW }) }, ON).decision.shouldClose).toBe(false);
  });

  it('closes at exactly 30 minutes with a low yield', () => {
    expect(decide({ metrics: metrics({ positionAgeMs: MIN_AGE, yieldPct: LOW }) }, ON).decision).toEqual({
      shouldClose: true,
      reason: 'LOW_YIELD',
    });
  });

  it('does NOT close at 60 minutes when the yield is healthy', () => {
    const age = 60 * 60 * 1000;
    const healthy = RULES.LOW_YIELD.MIN_FEE_YIELD_PCT * 10;
    expect(decide({ metrics: metrics({ positionAgeMs: age, yieldPct: healthy }) }, ON).decision.shouldClose).toBe(false);
  });

  it('does NOT close when the yield reading is missing, however old the position is', () => {
    const age = 24 * 60 * 60 * 1000;
    expect(decide({ metrics: metrics({ positionAgeMs: age, yieldPct: null }) }, ON).decision.shouldClose).toBe(false);
  });

  it('does NOT close when the position age is unknown', () => {
    expect(decide({ metrics: metrics({ positionAgeMs: null, yieldPct: LOW }) }, ON).decision.shouldClose).toBe(false);
  });

  it('yield exactly AT the floor is not "below" it', () => {
    expect(
      decide({ metrics: metrics({ positionAgeMs: MIN_AGE, yieldPct: RULES.LOW_YIELD.MIN_FEE_YIELD_PCT }) }, ON).decision.shouldClose,
    ).toBe(false);
  });

  it('is skipped entirely when disabled', () => {
    const off: ExitRules = { ...RULES, LOW_YIELD: { ...RULES.LOW_YIELD, ENABLED: false } };
    expect(decide({ metrics: metrics({ positionAgeMs: MIN_AGE, yieldPct: LOW }) }, off).decision.shouldClose).toBe(false);
  });
});

describe('PRIORITY 8 -- OOR_TIMEOUT and INFRA_SAFETY_EXIT (pre-existing protections)', () => {
  it('starts the OOR timer on the first out-of-range tick', () => {
    const { decision, nextExitState } = decide({ metrics: metrics({ inRange: false, pnlPct: -0.01 }) });
    expect(decision.shouldClose).toBe(false);
    expect(nextExitState.oorStartedAt).toEqual(T0);
  });

  it('closes once the 30-minute grace window has elapsed (unprofitable OOR)', () => {
    const running = state({ oorStartedAt: T0 });
    const past = new Date(T0.getTime() + 30 * 60 * 1000);
    expect(decide({ now: past, metrics: metrics({ inRange: false, pnlPct: -0.01 }), exitState: running }).decision).toEqual({
      shouldClose: true,
      reason: 'OOR_TIMEOUT',
    });
  });

  it('clears the timer once back in range', () => {
    const running = state({ oorStartedAt: T0 });
    const { nextExitState } = decide({ metrics: metrics({ inRange: true }), exitState: running });
    expect(nextExitState.oorStartedAt).toBeNull();
  });

  it('LEAVES the timer untouched when range status is unknown -- an RPC blip must not reset a 29-minute clock', () => {
    const running = state({ oorStartedAt: T0 });
    const later = new Date(T0.getTime() + 29 * 60 * 1000);
    const { nextExitState } = decide({ now: later, metrics: metrics({ inRange: null, pnlPct: null }), exitState: running });
    expect(nextExitState.oorStartedAt).toEqual(T0); // neither cleared nor advanced
  });

  it('INFRA_SAFETY_EXIT fires when the bot cannot read anything at all', () => {
    const blind = metrics({ pnlPct: null, inRange: null, yieldPct: null, bbPercentB: null, positionAgeMs: null });
    expect(decide({ metrics: blind, infraSafetyExitTriggered: true }).decision).toEqual({
      shouldClose: true,
      reason: 'INFRA_SAFETY_EXIT',
    });
  });

  it('a strategy rule still wins over INFRA_SAFETY_EXIT when metrics ARE readable', () => {
    const { decision } = decide({ metrics: metrics({ pnlPct: -0.09 }), infraSafetyExitTriggered: true });
    expect(decision).toEqual({ shouldClose: true, reason: 'HARD_STOP_LOSS' });
  });
});

describe('ladder ordering -- the order IS the policy', () => {
  it('SAFETY_EXIT (armed, recovered) beats OVEREXTENDED, TRAILING_TP, HARD_TP and OOR_PROFIT on one tick', () => {
    const WIDE_STOP: ExitRules = { ...RULES, HARD_STOP_LOSS_PCT: -0.5 };
    const armedAndPeaked = state({
      safetyExitArmedAt: T0,
      maxDrawdownPnlPct: -0.09,
      trailingPeakPnlPct: 0.3,
      drawdownConfirmStartedAt: T0,
    });
    const at15s = new Date(T0.getTime() + 15_000);
    // +26%: past HARD_TP, 4pp off a confirmed trailing peak, out of range
    // and profitable, %B over the band -- every one of them true at once.
    const { decision } = decide(
      {
        now: at15s,
        metrics: metrics({ pnlPct: 0.26, inRange: false, bbPercentB: 1.2 }),
        exitState: armedAndPeaked,
      },
      WIDE_STOP,
    );
    expect(decision).toEqual({ shouldClose: true, reason: 'SAFETY_EXIT' });
  });

  it('OVEREXTENDED beats TRAILING_TP, HARD_TP and OOR_PROFIT', () => {
    const pending = state({ trailingPeakPnlPct: 0.3, drawdownConfirmStartedAt: T0 });
    const at15s = new Date(T0.getTime() + 15_000);
    const { decision } = decide({
      now: at15s,
      metrics: metrics({ pnlPct: 0.26, inRange: false, bbPercentB: 1.2 }),
      exitState: pending,
    });
    expect(decision).toEqual({ shouldClose: true, reason: 'OVEREXTENDED' });
  });

  it('OOR_PROFIT beats LOW_YIELD and OOR_TIMEOUT', () => {
    const running = state({ oorStartedAt: T0 });
    const past = new Date(T0.getTime() + 60 * 60 * 1000);
    const { decision } = decide({
      now: past,
      metrics: metrics({ pnlPct: 0.05, inRange: false, yieldPct: 0, positionAgeMs: 60 * 60 * 1000 }),
      exitState: running,
    });
    expect(decision).toEqual({ shouldClose: true, reason: 'OOR_PROFIT' });
  });

  it('LOW_YIELD beats OOR_TIMEOUT (rule explicitly enabled -- it ships disabled by default)', () => {
    const ON: ExitRules = { ...RULES, LOW_YIELD: { ...RULES.LOW_YIELD, ENABLED: true } };
    const running = state({ oorStartedAt: T0 });
    const past = new Date(T0.getTime() + 60 * 60 * 1000);
    const { decision } = decide(
      {
        now: past,
        metrics: metrics({ pnlPct: -0.01, inRange: false, yieldPct: 0, positionAgeMs: 60 * 60 * 1000 }),
        exitState: running,
      },
      ON,
    );
    expect(decision).toEqual({ shouldClose: true, reason: 'LOW_YIELD' });
  });

  it('a totally quiet tick closes nothing and simply carries state forward', () => {
    const { decision, nextExitState } = decide({ metrics: metrics({ pnlPct: 0.01, yieldPct: 1 }) });
    expect(decision).toEqual({ shouldClose: false });
    expect(nextExitState.oorStartedAt).toBeNull();
    expect(nextExitState.safetyExitArmedAt).toBeNull();
  });
});

describe('data quality -- infrastructure failure is never a trading signal', () => {
  it('a completely blind tick (every metric null) closes nothing when no infra exit is armed', () => {
    const blind = metrics({ pnlPct: null, inRange: null, yieldPct: null, bbPercentB: null, positionAgeMs: null });
    expect(decide({ metrics: blind }).decision.shouldClose).toBe(false);
  });

  it('a blind tick does not corrupt max-drawdown or peak tracking', () => {
    const existing = state({ maxDrawdownPnlPct: -0.04, trailingPeakPnlPct: 0.09 });
    const blind = metrics({ pnlPct: null, inRange: null, yieldPct: null, bbPercentB: null, positionAgeMs: null });
    const { nextExitState } = decide({ metrics: blind, exitState: existing });
    expect(nextExitState.maxDrawdownPnlPct).toBeCloseTo(-0.04, 6);
    expect(nextExitState.trailingPeakPnlPct).toBeCloseTo(0.09, 6);
  });
});
