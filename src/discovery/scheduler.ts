export interface IntervalSchedulerOptions {
  intervalMs: number;
  runImmediately?: boolean;
  onError?: (err: unknown) => void;
}

/**
 * Runs `task` on a fixed interval with a re-entrancy guard: if a run is
 * still in flight when the next tick fires (e.g. GMGN is slow), that tick
 * is skipped rather than queued or overlapped. Discovery and screening
 * must never run two cycles concurrently against the same capital state.
 *
 * Per-call rate limiting/backoff (e.g. the up to ~11 `gmgn-cli` calls one
 * discovery cycle now makes -- 1 `market trending` + up to 10 `token
 * info`) is NOT this scheduler's job; it belongs to the task itself
 * (`GmgnCliClient` already spaces out and retries its own calls). This
 * scheduler's re-entrancy guard is the outer safety net that stops that
 * whole burst from ever overlapping with the next cycle's burst, however
 * long one run takes.
 *
 * Returns a `stop()` function.
 */
export function scheduleInterval(task: () => Promise<void>, options: IntervalSchedulerOptions): () => void {
  let running = false;
  let stopped = false;

  const runOnce = async (): Promise<void> => {
    if (running || stopped) return;
    running = true;
    try {
      await task();
    } catch (err) {
      options.onError?.(err);
    } finally {
      running = false;
    }
  };

  if (options.runImmediately) {
    void runOnce();
  }
  const handle = setInterval(() => {
    void runOnce();
  }, options.intervalMs);

  return () => {
    stopped = true;
    clearInterval(handle);
  };
}
