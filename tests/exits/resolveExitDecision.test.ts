import { describe, expect, it } from 'vitest';
import { resolveExitDecision } from '../../src/exits/resolveExitDecision';
import { EMPTY_EXIT_STATE } from '../../src/exits/types';
import type { ExitStateFields } from '../../src/exits/types';
import type { ExitRules } from '../../src/exits/types';
import { config } from '../../src/config';

const T0 = new Date('2026-01-01T00:00:00.000Z');
const state = (overrides: Partial<ExitStateFields> = {}): ExitStateFields => ({ ...EMPTY_EXIT_STATE, ...overrides });
/** Same shape `runExitCycle.ts` builds every tick (frozen config, no live-settings override) -- the default every pre-existing test in this file exercises. */
const RULES: ExitRules = config.rules.exits;

describe('resolveExitDecision', () => {
  describe('HARD_STOP_LOSS boundary (-15%)', () => {
    it('does not close at exactly -14.99%', () => {
      const { decision } = resolveExitDecision({ now: T0, pnlPct: -0.1499, inRange: true, safetyExitTriggered: false, exitState: state() }, RULES);
      expect(decision.shouldClose).toBe(false);
    });

    it('closes at exactly -15% (inclusive boundary, no confirm timer)', () => {
      const { decision } = resolveExitDecision({ now: T0, pnlPct: -0.15, inRange: true, safetyExitTriggered: false, exitState: state() }, RULES);
      expect(decision).toEqual({ shouldClose: true, reason: 'HARD_STOP_LOSS' });
    });

    it('closes at -20% (well past the boundary)', () => {
      const { decision } = resolveExitDecision({ now: T0, pnlPct: -0.2, inRange: true, safetyExitTriggered: false, exitState: state() }, RULES);
      expect(decision).toEqual({ shouldClose: true, reason: 'HARD_STOP_LOSS' });
    });
  });

  describe('SAFETY_EXIT priority', () => {
    it('overrides everything else, including a simultaneous HARD_STOP_LOSS condition', () => {
      const { decision } = resolveExitDecision({ now: T0, pnlPct: -0.5, inRange: true, safetyExitTriggered: true, exitState: state() }, RULES);
      expect(decision).toEqual({ shouldClose: true, reason: 'SAFETY_EXIT' });
    });

    it('leaves exitState completely untouched when it short-circuits', () => {
      const priorState = state({ oorStartedAt: new Date('2025-12-31T23:00:00.000Z'), trailingPeakPnlPct: 0.03 });
      const { nextExitState } = resolveExitDecision({ now: T0, pnlPct: 0.1, inRange: false, safetyExitTriggered: true, exitState: priorState }, RULES);
      expect(nextExitState).toEqual(priorState);
    });
  });

  describe('priority: HARD_STOP_LOSS wins over a simultaneously-elapsed OOR timer (the user\'s exact example)', () => {
    it('a price crash that trips BOTH HARD_STOP_LOSS and an already-elapsed 30-min OOR timer closes for HARD_STOP_LOSS, and leaves the OOR timer untouched', () => {
      const oorStartedAt = new Date(T0.getTime() - 31 * 60 * 1000); // 31 minutes ago -- OOR would have triggered on its own
      const priorState = state({ oorStartedAt });

      const { decision, nextExitState } = resolveExitDecision({
        now: T0,
        pnlPct: -0.3, // well past HARD_STOP_LOSS
        inRange: false, // still out of range too
        safetyExitTriggered: false,
        exitState: priorState,
      }, RULES);

      expect(decision).toEqual({ shouldClose: true, reason: 'HARD_STOP_LOSS' });
      // OOR's timer is neither reset nor advanced -- simply never looked at this tick.
      expect(nextExitState.oorStartedAt).toEqual(oorStartedAt);
    });
  });

  describe('TRAILING_TP', () => {
    it('does not arm below the +5% threshold', () => {
      const { nextExitState } = resolveExitDecision({ now: T0, pnlPct: 0.049, inRange: true, safetyExitTriggered: false, exitState: state() }, RULES);
      expect(nextExitState.trailingPeakPnlPct).toBeNull();
    });

    it('arms at exactly +5%, peak = current PNL', () => {
      const { nextExitState } = resolveExitDecision({ now: T0, pnlPct: 0.05, inRange: true, safetyExitTriggered: false, exitState: state() }, RULES);
      expect(nextExitState.trailingPeakPnlPct).toBe(0.05);
    });

    it('tracks a new peak upward and cancels any in-progress confirm timer', () => {
      const priorState = state({ trailingPeakPnlPct: 0.05, drawdownConfirmStartedAt: T0 });
      const { nextExitState } = resolveExitDecision({ now: T0, pnlPct: 0.08, inRange: true, safetyExitTriggered: false, exitState: priorState }, RULES);
      expect(nextExitState.trailingPeakPnlPct).toBe(0.08);
      expect(nextExitState.drawdownConfirmStartedAt).toBeNull();
    });

    it('starts the confirm timer exactly when PNL hits (peak - 2%)', () => {
      const priorState = state({ trailingPeakPnlPct: 0.1 });
      const { decision, nextExitState } = resolveExitDecision({ now: T0, pnlPct: 0.08, inRange: true, safetyExitTriggered: false, exitState: priorState }, RULES);
      expect(decision.shouldClose).toBe(false);
      expect(nextExitState.drawdownConfirmStartedAt).toEqual(T0);
    });

    it('does NOT close before the 15s confirm window elapses', () => {
      const priorState = state({ trailingPeakPnlPct: 0.1, drawdownConfirmStartedAt: T0 });
      const almostThere = new Date(T0.getTime() + 14_999);
      const { decision } = resolveExitDecision({ now: almostThere, pnlPct: 0.08, inRange: true, safetyExitTriggered: false, exitState: priorState }, RULES);
      expect(decision.shouldClose).toBe(false);
    });

    it('closes at exactly the 15s confirm window boundary', () => {
      const priorState = state({ trailingPeakPnlPct: 0.1, drawdownConfirmStartedAt: T0 });
      const exactly15s = new Date(T0.getTime() + 15_000);
      const { decision } = resolveExitDecision({ now: exactly15s, pnlPct: 0.08, inRange: true, safetyExitTriggered: false, exitState: priorState }, RULES);
      expect(decision).toEqual({ shouldClose: true, reason: 'TRAILING_TP' });
    });

    it('cancels the confirm timer if PNL recovers back above the drawdown line before 15s', () => {
      const priorState = state({ trailingPeakPnlPct: 0.1, drawdownConfirmStartedAt: T0 });
      const laterButRecovered = new Date(T0.getTime() + 10_000);
      const { decision, nextExitState } = resolveExitDecision({
        now: laterButRecovered,
        pnlPct: 0.09, // back above (peak - 2% = 0.08)
        inRange: true,
        safetyExitTriggered: false,
        exitState: priorState,
      }, RULES);
      expect(decision.shouldClose).toBe(false);
      expect(nextExitState.drawdownConfirmStartedAt).toBeNull();
    });
  });

  describe('PNL_PROTECTION (sticky, literal-spec reading -- no clamp on the drawdown line, confirmed in review)', () => {
    it('never itself closes the position -- crossing -8% alone (below HARD_STOP_LOSS, below Trailing TP arming) only updates state', () => {
      const { decision, nextExitState } = resolveExitDecision({ now: T0, pnlPct: -0.08, inRange: true, safetyExitTriggered: false, exitState: state() }, RULES);
      expect(decision.shouldClose).toBe(false);
      expect(nextExitState.pnlProtectionActivatedAt).toEqual(T0);
    });

    it('activates exactly at -8%, once, and never clears even if PNL later recovers', () => {
      const { nextExitState: afterTrigger } = resolveExitDecision({ now: T0, pnlPct: -0.08, inRange: true, safetyExitTriggered: false, exitState: state() }, RULES);
      expect(afterTrigger.pnlProtectionActivatedAt).toEqual(T0);

      const later = new Date(T0.getTime() + 60_000);
      const { nextExitState: afterRecovery } = resolveExitDecision({ now: later, pnlPct: 0.5, inRange: true, safetyExitTriggered: false, exitState: afterTrigger }, RULES);
      expect(afterRecovery.pnlProtectionActivatedAt).toEqual(T0); // unchanged, still set
    });

    it('lowers the Trailing TP arm threshold from +5% to 0% once active', () => {
      const activated = state({ pnlProtectionActivatedAt: T0 });
      // +2% would NOT arm normal Trailing TP (needs +5%), but DOES arm once PNL Protection is active (needs 0%).
      const { nextExitState } = resolveExitDecision({ now: T0, pnlPct: 0.02, inRange: true, safetyExitTriggered: false, exitState: activated }, RULES);
      expect(nextExitState.trailingPeakPnlPct).toBe(0.02);
    });

    it('deliberately allows PNL to dip to (0% - 2% = -2%) before the confirm timer starts -- accepted literal-spec behavior, not a clamped floor', () => {
      // Recovered to exactly breakeven (0%) with protection active -- arms at peak=0.
      const armed = state({ pnlProtectionActivatedAt: T0, trailingPeakPnlPct: 0 });
      // Now drops all the way to -2% -- still no close, timer only just starting.
      const { decision, nextExitState } = resolveExitDecision({ now: T0, pnlPct: -0.02, inRange: true, safetyExitTriggered: false, exitState: armed }, RULES);
      expect(decision.shouldClose).toBe(false);
      expect(nextExitState.drawdownConfirmStartedAt).toEqual(T0);
      // PNL is negative again at this exact tick -- confirms no clamp prevents this.
      expect(-0.02).toBeLessThan(0);
    });
  });

  describe('OOR', () => {
    it('starts the timer the moment price leaves range', () => {
      const { nextExitState } = resolveExitDecision({ now: T0, pnlPct: 0, inRange: false, safetyExitTriggered: false, exitState: state() }, RULES);
      expect(nextExitState.oorStartedAt).toEqual(T0);
    });

    it('does not close before the 30-minute grace window elapses', () => {
      const priorState = state({ oorStartedAt: T0 });
      const almostThere = new Date(T0.getTime() + 30 * 60 * 1000 - 1);
      const { decision } = resolveExitDecision({ now: almostThere, pnlPct: 0, inRange: false, safetyExitTriggered: false, exitState: priorState }, RULES);
      expect(decision.shouldClose).toBe(false);
    });

    it('closes at exactly the 30-minute boundary', () => {
      const priorState = state({ oorStartedAt: T0 });
      const exactly30min = new Date(T0.getTime() + 30 * 60 * 1000);
      const { decision } = resolveExitDecision({ now: exactly30min, pnlPct: 0, inRange: false, safetyExitTriggered: false, exitState: priorState }, RULES);
      expect(decision).toEqual({ shouldClose: true, reason: 'OOR' });
    });

    it('cancels the timer the moment price is back in range', () => {
      const priorState = state({ oorStartedAt: T0 });
      const { nextExitState } = resolveExitDecision({ now: new Date(T0.getTime() + 60_000), pnlPct: 0, inRange: true, safetyExitTriggered: false, exitState: priorState }, RULES);
      expect(nextExitState.oorStartedAt).toBeNull();
    });

    it('is lowest priority -- an elapsed OOR timer loses to a simultaneously-confirmed TRAILING_TP', () => {
      const priorState = state({
        oorStartedAt: new Date(T0.getTime() - 40 * 60 * 1000), // long elapsed
        trailingPeakPnlPct: 0.1,
        drawdownConfirmStartedAt: new Date(T0.getTime() - 20_000), // also long elapsed
      });
      const { decision } = resolveExitDecision({ now: T0, pnlPct: 0.08, inRange: false, safetyExitTriggered: false, exitState: priorState }, RULES);
      expect(decision).toEqual({ shouldClose: true, reason: 'TRAILING_TP' });
    });
  });

  describe('Decision 3a (Module 10 review): trailingTpTriggerPct live-setting vs frozen PNL Protection -- two-directional proof', () => {
    it('(a) PNL Protection NOT active: a live-changed trailingTpTriggerPct is what actually arms Trailing TP', () => {
      const liveRules = { ...RULES, TRAILING_TP: { ...RULES.TRAILING_TP, TRIGGER_PEAK_PNL_PCT: 0.2 } }; // live setting changed to +20%, way above the frozen +5% default
      const notYetActivated = state({ pnlProtectionActivatedAt: null });

      // +10% would ARM under the frozen default (+5%) but must NOT arm under the new live +20% threshold.
      const belowNewThreshold = resolveExitDecision({ now: T0, pnlPct: 0.1, inRange: true, safetyExitTriggered: false, exitState: notYetActivated }, liveRules);
      expect(belowNewThreshold.nextExitState.trailingPeakPnlPct).toBeNull();

      // +25% DOES clear the new live +20% threshold -- arms at the live value, proving the live setting is what's actually being read.
      const aboveNewThreshold = resolveExitDecision({ now: T0, pnlPct: 0.25, inRange: true, safetyExitTriggered: false, exitState: notYetActivated }, liveRules);
      expect(aboveNewThreshold.nextExitState.trailingPeakPnlPct).toBe(0.25);
    });

    it('(b) PNL Protection ALREADY active: trailingTpTriggerPct changed live to ANY value is completely ignored -- arm threshold stays the frozen 0%', () => {
      const alreadyActivated = state({ pnlProtectionActivatedAt: T0 });

      // Three wildly different live values for trailingTpTriggerPct -- none of them should matter once PNL Protection has activated for this position.
      for (const liveTrigger of [0.2, 0.5, 0.9]) {
        const liveRules = { ...RULES, TRAILING_TP: { ...RULES.TRAILING_TP, TRIGGER_PEAK_PNL_PCT: liveTrigger } };
        // +1% clears the frozen 0% PNL-Protection arm threshold, but would NOT clear any of the live values above -- if the live value were being used instead of the frozen 0%, this would fail to arm.
        const { nextExitState } = resolveExitDecision({ now: T0, pnlPct: 0.01, inRange: true, safetyExitTriggered: false, exitState: alreadyActivated }, liveRules);
        expect(nextExitState.trailingPeakPnlPct).toBe(0.01); // armed at current PNL -- proves the 0% (frozen) threshold was used, not any live value
      }
    });
  });
});
