import { describe, expect, it } from 'vitest';
import { InMemoryExitStateRepository } from './inMemoryExitStateRepository';
import { resolveExitDecision } from '../../src/exits/resolveExitDecision';
import { EMPTY_EXIT_STATE } from '../../src/exits/types';
import type { ExitRules } from '../../src/exits/types';
import { config } from '../../src/config';

const RULES: ExitRules = config.rules.exits;

describe('ExitStateRepository', () => {
  it('getOrCreate returns an all-null/zero row for a position with no prior state', async () => {
    const repo = new InMemoryExitStateRepository();
    const record = await repo.getOrCreate('pos-1');
    expect(record).toEqual({ positionId: 'pos-1', ...EMPTY_EXIT_STATE });
  });

  it('update merges a patch without clobbering other fields', async () => {
    const repo = new InMemoryExitStateRepository();
    await repo.update('pos-1', { trailingPeakPnlPct: 0.06 });
    await repo.update('pos-1', { oorStartedAt: new Date('2026-01-01T00:00:00.000Z') });
    const record = await repo.getOrCreate('pos-1');
    expect(record.trailingPeakPnlPct).toBe(0.06);
    expect(record.oorStartedAt).toEqual(new Date('2026-01-01T00:00:00.000Z'));
  });

  it('incrementSwapAttempt increments from 0, and repeated calls keep incrementing', async () => {
    const repo = new InMemoryExitStateRepository();
    const first = await repo.incrementSwapAttempt('pos-1');
    expect(first.swapAttemptCount).toBe(1);
    const second = await repo.incrementSwapAttempt('pos-1');
    expect(second.swapAttemptCount).toBe(2);
  });

  it('findStuckSwapRetries returns only positions at/above the threshold', async () => {
    const repo = new InMemoryExitStateRepository();
    await repo.update('stuck', { swapAttemptCount: 5 });
    await repo.update('fine', { swapAttemptCount: 2 });
    const stuck = await repo.findStuckSwapRetries(5);
    expect(stuck).toEqual(['stuck']);
  });

  describe('restart survival -- the point-1 requirement: a timer measured from its ORIGINAL persisted timestamp, not restarted at 0', () => {
    it('Trailing TP drawdown confirm timer resumes correctly after a simulated restart', async () => {
      const T0 = new Date('2026-01-01T00:00:00.000Z');

      // "Before restart": a drawdown breach was observed at T0 and the confirm timer started then.
      const breachStartedAt = T0;
      const beforeRestart = new InMemoryExitStateRepository();
      await beforeRestart.update('pos-1', { trailingPeakPnlPct: 0.1, drawdownConfirmStartedAt: breachStartedAt });
      const persisted = await beforeRestart.getOrCreate('pos-1');

      // "After restart": a BRAND NEW repository instance (no shared in-memory
      // state whatsoever -- the only thing carried across is what was
      // actually persisted), seeded with exactly that persisted record, as
      // if it had just been read back from real storage after a process restart.
      const afterRestart = new InMemoryExitStateRepository();
      afterRestart.seed(persisted);

      const readBack = await afterRestart.getOrCreate('pos-1');
      expect(readBack.drawdownConfirmStartedAt).toEqual(breachStartedAt);

      // 16 seconds after the ORIGINAL breach (restart happened somewhere in
      // between, irrelevant to this calculation) -- past the 15s window.
      const nowAfterRestart = new Date(breachStartedAt.getTime() + 16_000);
      const { decision } = resolveExitDecision({
        now: nowAfterRestart,
        // Peak 10% minus the 3-PERCENTAGE-POINT drawdown = 7% -- exactly on
        // the line, so the breach is still live and the confirm timer is
        // still the pre-restart one.
        metrics: { pnlPct: 0.07, inRange: true, yieldPct: null, bbPercentB: null, positionAgeMs: null },
        infraSafetyExitTriggered: false,
        exitState: readBack,
      }, RULES);

      // Proves the 15s window was measured from the ORIGINAL pre-restart
      // timestamp (10s + 6s = 16s >= 15s -> closes), NOT restarted at 0
      // post-restart (which would have needed a fresh 15s from nowAfterRestart).
      expect(decision).toEqual({ shouldClose: true, reason: 'TRAILING_TP' });
    });

    it('OOR grace timer resumes correctly after a simulated restart', async () => {
      const T0 = new Date('2026-01-01T00:00:00.000Z');
      const oorStartedAt = new Date(T0.getTime() - 29 * 60 * 1000); // 29 minutes ago, pre-restart

      const beforeRestart = new InMemoryExitStateRepository();
      await beforeRestart.update('pos-1', { oorStartedAt });
      const persisted = await beforeRestart.getOrCreate('pos-1');

      const afterRestart = new InMemoryExitStateRepository();
      afterRestart.seed(persisted);
      const readBack = await afterRestart.getOrCreate('pos-1');

      // Only 2 more minutes pass post-restart (29 + 2 = 31 >= 30 -> closes).
      const nowAfterRestart = new Date(oorStartedAt.getTime() + 31 * 60 * 1000);
      const { decision } = resolveExitDecision({
        now: nowAfterRestart,
        // PnL is a real, flat 0 -- below OOR_PROFIT's +2% floor, so the only
        // rule that can fire here is the grace-window timeout itself.
        metrics: { pnlPct: 0, inRange: false, yieldPct: null, bbPercentB: null, positionAgeMs: null },
        infraSafetyExitTriggered: false,
        exitState: readBack,
      }, RULES);

      expect(decision).toEqual({ shouldClose: true, reason: 'OOR_TIMEOUT' });
    });
  });
});
