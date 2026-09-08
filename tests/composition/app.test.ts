import { describe, expect, it, vi } from 'vitest';
import { startApp } from '../../src/composition/app';
import { createFakeAppDeps } from './fakeAppDeps';
import type { createInMemoryLogger } from '../../src/composition/logger';
import type { AppDeps } from '../../src/composition/types';

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function logLines(deps: AppDeps): ReturnType<typeof createInMemoryLogger>['lines'] {
  return (deps.logger as ReturnType<typeof createInMemoryLogger>).lines;
}

describe('startApp', () => {
  it('runs all three cycles immediately at startup (runImmediately), without waiting for the first tick', async () => {
    const deps = createFakeAppDeps();
    const { stop } = startApp(deps, { screeningIntervalMs: 100_000, monitoringIntervalMs: 100_000, exitIntervalMs: 100_000 });
    // Immediate runs are fire-and-forget (scheduleInterval's runImmediately doesn't await) -- give the microtask queue a moment.
    await sleep(20);
    await stop();

    const events = logLines(deps).map((l) => l.event);
    expect(events).toContain('screening_cycle');
    expect(events).toContain('monitoring_cycle');
    expect(events).toContain('exit_cycle');
  });

  it('re-entrancy: a slow cycle is never invoked a second time while the first run is still in flight', async () => {
    let concurrentRuns = 0;
    let maxConcurrent = 0;
    const discoverTopCandidates = vi.fn(async () => {
      concurrentRuns++;
      maxConcurrent = Math.max(maxConcurrent, concurrentRuns);
      await sleep(50); // deliberately slower than the scheduled interval below
      concurrentRuns--;
      return [];
    });
    const deps = createFakeAppDeps({ discoveryService: { discoverTopCandidates } as never });

    // Interval shorter than the cycle's own duration -- if there were no re-entrancy guard, this would overlap.
    const { stop } = startApp(deps, { screeningIntervalMs: 10, monitoringIntervalMs: 100_000, exitIntervalMs: 100_000 });
    await sleep(150);
    await stop();

    expect(maxConcurrent).toBeLessThanOrEqual(1);
    expect(discoverTopCandidates.mock.calls.length).toBeGreaterThanOrEqual(1);
  });

  it('the three cycles run independently -- a slow screening cycle does not block monitoring/exit ticks', async () => {
    const discoverTopCandidates = vi.fn(async () => {
      await sleep(200); // much slower than the other two cycles' intervals
      return [];
    });
    const deps = createFakeAppDeps({ discoveryService: { discoverTopCandidates } as never });

    const { stop } = startApp(deps, { screeningIntervalMs: 100_000, monitoringIntervalMs: 20, exitIntervalMs: 20 });
    await sleep(90);
    await stop();

    const monitoringRuns = logLines(deps).filter((l) => l.event === 'monitoring_cycle').length;
    const exitRuns = logLines(deps).filter((l) => l.event === 'exit_cycle').length;
    // Both ran multiple times despite the screening cycle still being in flight the whole time.
    expect(monitoringRuns).toBeGreaterThan(1);
    expect(exitRuns).toBeGreaterThan(1);
  });

  describe('graceful shutdown', () => {
    it('stop() waits for an in-flight cycle to finish before resolving', async () => {
      let cycleFinished = false;
      const discoverTopCandidates = vi.fn(async () => {
        await sleep(80);
        cycleFinished = true;
        return [];
      });
      const deps = createFakeAppDeps({ discoveryService: { discoverTopCandidates } as never });

      const { stop } = startApp(deps, { screeningIntervalMs: 100_000, monitoringIntervalMs: 100_000, exitIntervalMs: 100_000 });
      await sleep(10); // let the immediate run start, but not finish
      await stop();

      expect(cycleFinished).toBe(true); // stop() only returned AFTER the in-flight cycle actually completed
    });

    it('stop() does not wait forever -- falls back to the configured timeout if a cycle hangs, and reports timedOut: true', async () => {
      const discoverTopCandidates = vi.fn(async () => {
        await sleep(300); // deliberately longer than the shutdownTimeoutMs below
        return [];
      });
      const deps = createFakeAppDeps({ discoveryService: { discoverTopCandidates } as never });

      const { stop } = startApp(deps, { screeningIntervalMs: 100_000, monitoringIntervalMs: 100_000, exitIntervalMs: 100_000, shutdownTimeoutMs: 50 });
      await sleep(10);
      const start = Date.now();
      const result = await stop();
      const elapsed = Date.now() - start;

      expect(elapsed).toBeLessThan(200); // returned well before the 300ms "slow" cycle would have finished, honoring the 50ms timeout
      expect(result).toEqual({ timedOut: true });
    });

    it('reports timedOut: false when every cycle genuinely finished within the timeout', async () => {
      const deps = createFakeAppDeps();
      const { stop } = startApp(deps, { screeningIntervalMs: 100_000, monitoringIntervalMs: 100_000, exitIntervalMs: 100_000, shutdownTimeoutMs: 5_000 });
      await sleep(20);
      const result = await stop();
      expect(result).toEqual({ timedOut: false });
    });

    it('CRITICAL: a timeout does NOT cancel the in-flight work -- it keeps running in the background and genuinely completes after stop() has already returned', async () => {
      let cycleActuallyFinished = false;
      const discoverTopCandidates = vi.fn(async () => {
        await sleep(150); // longer than the 50ms shutdown timeout below
        cycleActuallyFinished = true;
        return [];
      });
      const deps = createFakeAppDeps({ discoveryService: { discoverTopCandidates } as never });

      const { stop } = startApp(deps, { screeningIntervalMs: 100_000, monitoringIntervalMs: 100_000, exitIntervalMs: 100_000, shutdownTimeoutMs: 50 });
      await sleep(10);
      const result = await stop();

      // stop() already returned (timed out) -- the cycle must NOT have been force-cancelled to make that happen.
      expect(result.timedOut).toBe(true);
      expect(cycleActuallyFinished).toBe(false); // not yet, at the moment stop() returned -- proves stop() didn't just secretly wait for it anyway

      // But given enough real time, the abandoned work genuinely completes on its own -- proving it was never cancelled, only abandoned by stop()'s own wait.
      await sleep(200);
      expect(cycleActuallyFinished).toBe(true);
    });

    it('after stop(), no further cycle runs happen', async () => {
      const deps = createFakeAppDeps();
      const { stop } = startApp(deps, { screeningIntervalMs: 15, monitoringIntervalMs: 100_000, exitIntervalMs: 100_000 });
      await sleep(20);
      await stop();
      const countAtStop = logLines(deps).filter((l) => l.event === 'screening_cycle').length;
      await sleep(60); // long enough for several more 15ms ticks to have fired if stop() didn't actually stop the schedule
      const countAfter = logLines(deps).filter((l) => l.event === 'screening_cycle').length;
      expect(countAfter).toBe(countAtStop);
    });
  });
});
