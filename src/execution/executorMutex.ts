/**
 * A single process-wide mutex serializing the nonce-assignment ->
 * sign -> broadcast span of `executeCriticalTransaction` (C7 fix).
 *
 * The executor wallet has exactly one valid "next nonce" at any instant.
 * Without this, two independently-scheduled cycles racing in the same
 * process (e.g. the 30-minute screening cycle's deploy and the 15-second
 * exit cycle's open-resume pass -- see `composition/app.ts`, which runs
 * all three cycles on independent `scheduleInterval` timers with no
 * mutual exclusion between them) can both read the same pending nonce via
 * `viemTxSteps.getCurrentNonce()` and sign two DIFFERENT payloads under
 * it. Only one broadcast can ever land; the other's node-level rejection
 * ("nonce too low") is disambiguated by `classifyBroadcastError.ts`, but
 * that disambiguation is a safety net for a genuinely rare event, not a
 * substitute for simply not racing the nonce in the first place.
 *
 * Implemented as a promise-chain lock (no new dependency): each call
 * waits for every earlier queued call to finish (success OR failure)
 * before its own `fn` runs, guaranteeing at most one holder at a time,
 * process-wide, in call order.
 *
 * Liveness (stuck-transaction incident): the HOLDER is never timed out.
 * The lock is released only when the holder's `fn` has settled -- a
 * `Promise.race` that let the next caller in while a sign/broadcast is
 * still running could put two workers on the wallet's nonce at once.
 * Instead a WAITER may give up (`maxWaitMs`): it rejects with
 * `ExecutorLockTimeoutError` and, when its turn eventually comes, its `fn`
 * is skipped entirely -- it never ran any part of the critical section, so
 * abandoning it is always safe and cannot create a concurrent nonce. The
 * caller treats that as "executor busy, resume next tick", so one stuck
 * holder can no longer silently freeze every other cycle's transactions
 * (and the cycle schedulers behind them) forever. The holder itself is
 * bounded by its own I/O: signing is local (no network), and every RPC
 * call goes through viem's HTTP transport, which has a request timeout.
 */
export class ExecutorLockTimeoutError extends Error {
  constructor(
    public readonly waitedMs: number,
    public readonly holder: ExecutorLockHolder | null,
  ) {
    super(
      `executor lock not acquired within ${waitedMs}ms` +
        (holder ? ` -- held by "${holder.label}" for ${Date.now() - holder.since}ms` : ''),
    );
    this.name = 'ExecutorLockTimeoutError';
  }
}

export interface ExecutorLockHolder {
  label: string;
  /** epoch ms when the holder's critical section started */
  since: number;
}

export interface ExecutorLockOptions {
  /** Identifies the critical section in diagnostics (e.g. the idempotency key). */
  label?: string;
  /** Give up waiting after this long (the critical section is then never run). Omitted = wait indefinitely. */
  maxWaitMs?: number;
}

let queueTail: Promise<void> = Promise.resolve();
let currentHolder: ExecutorLockHolder | null = null;

/** Who holds the executor lock right now, and since when (diagnostics only). */
export function getExecutorLockHolder(): ExecutorLockHolder | null {
  return currentHolder ? { ...currentHolder } : null;
}

export function withExecutorLock<T>(fn: () => Promise<T>, options: ExecutorLockOptions = {}): Promise<T> {
  const label = options.label ?? 'unlabelled';
  let started = false;
  let abandoned = false;
  const run = queueTail.then(async () => {
    // A waiter that already gave up must not touch the wallet: skip, and
    // hand the lock straight to the next caller.
    if (abandoned) throw new ExecutorLockTimeoutError(options.maxWaitMs ?? 0, currentHolder);
    started = true;
    currentHolder = { label, since: Date.now() };
    try {
      return await fn();
    } finally {
      currentHolder = null;
    }
  });
  // Chain the NEXT waiter on a version of this call that never rejects --
  // one holder's failure must never permanently jam the lock for callers
  // queued behind it. `run` itself still resolves/rejects normally for
  // ITS OWN caller.
  queueTail = run.then(
    () => undefined,
    () => undefined,
  );
  if (options.maxWaitMs === undefined) return run;

  const maxWaitMs = options.maxWaitMs;
  return new Promise<T>((resolve, reject) => {
    const timer = setTimeout(() => {
      // Once the critical section has STARTED it is never abandoned -- the
      // caller must learn its real outcome.
      if (started) return;
      abandoned = true;
      reject(new ExecutorLockTimeoutError(maxWaitMs, currentHolder));
    }, maxWaitMs);
    run.then(
      (value) => { clearTimeout(timer); if (!abandoned) resolve(value); },
      (err: unknown) => { clearTimeout(timer); if (!abandoned) reject(err instanceof Error ? err : new Error(String(err))); },
    );
  });
}
