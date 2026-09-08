import { randomUUID } from 'node:crypto';
import { config } from '../config';
import { computePositionMetrics } from '../monitoring/computePositionMetrics';
import type { LivePositionStateProvider, PoolPriceProvider, PoolPriceState } from '../monitoring/types';
import type { PositionRepository } from '../positions/types';
import type { TransactionAttemptRepository } from '../execution/types';
import type { SwapExecutor } from '../swap/types';
import type { SettingsRepository } from '../settings/types';
import type { ExitRules, ExitStateFields, ExitStateRepository } from './types';
import { resolveExitDecision } from './resolveExitDecision';
import { evaluateSafetyExit } from './safetyExit';
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
  /** Module 10: live-editable HARD_STOP_LOSS_PCT/TRAILING_TP.TRIGGER_PEAK_PNL_PCT, read fresh once per call (see below), merged over frozen config for every other field -- most importantly PNL_PROTECTION, which is NEVER settings-derived. */
  settings: SettingsRepository;
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

  const liveSettings = await deps.settings.get();
  const exitRules: ExitRules = {
    ...config.rules.exits,
    HARD_STOP_LOSS_PCT: liveSettings.hardStopLossPct,
    TRAILING_TP: { ...config.rules.exits.TRAILING_TP, TRIGGER_PEAK_PNL_PCT: liveSettings.trailingTpTriggerPct },
    // PNL_PROTECTION deliberately untouched -- always frozen config, never settings-derived (Decision 3a/3b).
  };

  const active = await deps.positions.findAllActive();
  for (const position of active) {
    try {
      const rawExitState = await deps.exitStates.getOrCreate(position.id);

      let pnlPct: number | null = null;
      let inRange: boolean | null = null;
      let poolPriceState: PoolPriceState | null = null;
      let metricsOk = false;
      try {
        const [live, price] = await Promise.all([deps.livePositionState.getLiveState(position), deps.poolPrice.getPriceState(position.pool)]);
        poolPriceState = price;
        const metrics = computePositionMetrics(position, live, price);
        if (metrics.ok) {
          pnlPct = metrics.pnlPct;
          inRange = metrics.inRange;
          metricsOk = true;
        }
      } catch {
        metricsOk = false;
      }

      // Computed FIRST and folded into the exit-state snapshot BEFORE
      // resolveExitDecision runs, specifically so its returned
      // `nextExitState` (which spreads the rest of the record through
      // unmodified) carries the CORRECT value -- persisting a
      // separately-computed value first and resolveExitDecision's stale
      // copy second would silently revert this field on every tick.
      const metricsFailureSince = metricsOk ? null : (rawExitState.metricsFailureSince ?? now);
      const currentExitState: ExitStateFields = { ...rawExitState, metricsFailureSince };
      const safetyExitTriggered = evaluateSafetyExit({ metricsFailureSince, now, poolPrice: poolPriceState });

      if (!metricsOk && !safetyExitTriggered) {
        // Can't evaluate PNL/OOR-based triggers without metrics, and the
        // Safety Exit failure-streak threshold hasn't been crossed yet --
        // still persist the (possibly newly-started) failure streak.
        await deps.exitStates.update(position.id, { metricsFailureSince });
        results.push({ positionId: position.id, action: 'NONE' });
        continue;
      }

      // pnlPct/inRange placeholders are safe when !metricsOk: that only
      // happens here when safetyExitTriggered is true, and SAFETY_EXIT is
      // resolveExitDecision's first, unconditional check -- pnlPct/inRange
      // are never read on that path.
      const { decision, nextExitState } = resolveExitDecision(
        {
          now,
          pnlPct: pnlPct ?? 0,
          inRange: inRange ?? true,
          safetyExitTriggered,
          exitState: currentExitState,
        },
        exitRules,
      );
      await deps.exitStates.update(position.id, nextExitState);

      if (!decision.shouldClose) {
        results.push({ positionId: position.id, action: 'NONE' });
        continue;
      }

      const closeIdempotencyKey = `exit:${position.id}:${randomUUID()}`;
      await deps.positions.markClosing(position.id, closeIdempotencyKey);
      await deps.exitStates.update(position.id, { pendingCloseReason: decision.reason });

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
    try {
      const outcome = await executeExit(position, deps);
      results.push({ positionId: position.id, action: 'RESUMED', outcome });
    } catch (err) {
      results.push({ positionId: position.id, action: 'RESUMED', outcome: { outcome: 'PENDING', reason: err instanceof Error ? err.message : String(err) } });
    }
  }

  return results;
}
