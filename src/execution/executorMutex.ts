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
 */
let queueTail: Promise<void> = Promise.resolve();

export function withExecutorLock<T>(fn: () => Promise<T>): Promise<T> {
  const run = queueTail.then(fn);
  // Chain the NEXT waiter on a version of this call that never rejects --
  // one holder's failure must never permanently jam the lock for callers
  // queued behind it. `run` itself still resolves/rejects normally for
  // ITS OWN caller.
  queueTail = run.then(
    () => undefined,
    () => undefined,
  );
  return run;
}
