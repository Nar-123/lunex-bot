import { config } from '../config';
import { scheduleInterval } from '../discovery/scheduler';
import { runScreeningCycle } from './screeningCycle';
import { runMonitoringLoggingCycle } from './monitoringCycle';
import { runExitAndOpenResumeCycle } from './exitCycle';
import type { AppDeps } from './types';

export interface StartAppOptions {
  /** Overrides for tests -- default to the real spec-locked intervals (30 min screening, 15s monitoring, 15s exit+open-resume). */
  screeningIntervalMs?: number;
  monitoringIntervalMs?: number;
  exitIntervalMs?: number;
  /** How long `stop()` WAITS for an in-flight cycle to finish before giving up on waiting (never cancels the work itself -- see `stop()`'s doc comment). Defaults to `config.composition.shutdownTimeoutMs`. */
  shutdownTimeoutMs?: number;
}

export interface StopResult {
  /**
   * `true` if `shutdownTimeoutMs` elapsed before every cycle finished on
   * its own -- see `stop()`'s doc comment for what this does and does NOT
   * mean. Callers (specifically `src/index.ts`) MUST check this before
   * deciding whether it's safe to terminate the process.
   */
  timedOut: boolean;
}

export interface RunningApp {
  /** See doc comment on the `stop` implementation inside `startApp` for the full semantics -- summary: stops all three schedules, waits up to `shutdownTimeoutMs` for in-flight work, NEVER cancels that work even on timeout. */
  stop: () => Promise<StopResult>;
}

/**
 * Wraps a cycle function with its OWN "is a run currently in flight"
 * tracking, SEPARATE from `scheduleInterval`'s internal re-entrancy guard
 * (which only prevents two runs of the SAME cycle overlapping -- it has
 * no way to tell an outside caller "wait for the current run to finish").
 * `waitForIdle()` is what makes graceful shutdown possible without
 * modifying `scheduler.ts` itself (reused as-is, per explicit review --
 * "reuse, jangan bikin ulang").
 */
function trackable(task: () => Promise<void>): { run: () => Promise<void>; waitForIdle: () => Promise<void> } {
  let current: Promise<void> | null = null;
  const run = async (): Promise<void> => {
    const p = task();
    current = p;
    try {
      await p;
    } finally {
      if (current === p) current = null;
    }
  };
  const waitForIdle = async (): Promise<void> => {
    if (current) await current.catch(() => undefined);
  };
  return { run, waitForIdle };
}

/**
 * The composition root's live wiring: three independently-scheduled
 * cycles (30-minute screening, 15-second monitoring, 15-second
 * exit+open-resume), each with `scheduleInterval`'s existing
 * re-entrancy guard (Module 2, reused not rebuilt) and `runImmediately:
 * true` -- which is also what satisfies "run every resume pass
 * immediately at startup, don't wait for the first tick" for free: the
 * exit+open-resume cycle's resume passes are simply PART of what runs on
 * its very first (immediate) invocation, no separate startup-only code
 * path needed.
 */
export function startApp(deps: AppDeps, options: StartAppOptions = {}): RunningApp {
  const screeningIntervalMs = options.screeningIntervalMs ?? config.rules.discovery.CYCLE_INTERVAL_MS;
  const monitoringIntervalMs = options.monitoringIntervalMs ?? config.rules.monitoring.INTERVAL_MS;
  const exitIntervalMs = options.exitIntervalMs ?? config.rules.monitoring.INTERVAL_MS;
  const shutdownTimeoutMs = options.shutdownTimeoutMs ?? config.composition.shutdownTimeoutMs;

  const screening = trackable(async () => {
    await runScreeningCycle(deps);
  });
  const monitoring = trackable(async () => {
    await runMonitoringLoggingCycle(deps);
  });
  const exit = trackable(async () => {
    await runExitAndOpenResumeCycle(deps);
  });

  const stopScreening = scheduleInterval(screening.run, {
    intervalMs: screeningIntervalMs,
    runImmediately: true,
    onError: (err) => deps.logger.error('screening_cycle_error', { message: err instanceof Error ? err.message : String(err) }),
  });
  const stopMonitoring = scheduleInterval(monitoring.run, {
    intervalMs: monitoringIntervalMs,
    runImmediately: true,
    onError: (err) => deps.logger.error('monitoring_cycle_error', { message: err instanceof Error ? err.message : String(err) }),
  });
  const stopExit = scheduleInterval(exit.run, {
    intervalMs: exitIntervalMs,
    runImmediately: true,
    onError: (err) => deps.logger.error('exit_cycle_error', { message: err instanceof Error ? err.message : String(err) }),
  });

  /**
   * Stops all three schedules (no new cycle runs start after this), then
   * WAITS up to `shutdownTimeoutMs` for any currently-in-flight cycle run
   * to finish on its own.
   *
   * ## What the timeout does NOT do -- read before changing this function
   *
   * There is no `AbortController` anywhere in this pipeline (not in
   * `executeCriticalTransaction`, not in any Prisma call, not in any RPC
   * call). `Promise.race` below can only stop THIS function from
   * WAITING on the in-flight work -- it has no way to reach into that
   * work and cancel it. So when the timeout wins the race, the abandoned
   * `Promise.all([...waitForIdle()])` keeps running in the background
   * exactly as if `stop()` had never been called, completely unaffected
   * by this function returning. A `TransactionAttempt` write or a
   * position-status update that was in flight when the timeout fired
   * WILL still run to completion -- just not on `stop()`'s own clock
   * anymore.
   *
   * This is deliberate, not an oversight: forcibly cutting off a write
   * mid-flight is exactly the failure mode graceful shutdown exists to
   * prevent, so the timeout is scoped to "stop making the caller wait,"
   * never to "stop the work." The consequence lands entirely on the
   * CALLER: `timedOut: true` means it is UNSAFE to `process.exit()` right
   * away, since abandoned work may still be writing to the database --
   * see `src/index.ts`'s `shutdown()`, which checks this and skips the
   * forced exit in that case, letting Node's event loop drain naturally
   * once the abandoned work actually finishes instead.
   */
  const stop = async (): Promise<StopResult> => {
    stopScreening();
    stopMonitoring();
    stopExit();

    let timeoutHandle: ReturnType<typeof setTimeout> | undefined;
    let timedOut = false;
    const timeout = new Promise<void>((resolve) => {
      timeoutHandle = setTimeout(() => {
        timedOut = true;
        resolve();
      }, shutdownTimeoutMs);
    });
    await Promise.race([Promise.all([screening.waitForIdle(), monitoring.waitForIdle(), exit.waitForIdle()]), timeout]);
    if (timeoutHandle) clearTimeout(timeoutHandle);
    return { timedOut };
  };

  return { stop };
}
