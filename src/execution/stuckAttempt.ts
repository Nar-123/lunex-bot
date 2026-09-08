import { config } from '../config';
import type { TransactionAttemptRecord } from './types';

/**
 * True if a non-terminal attempt has been ambiguous/in-flight for
 * suspiciously long -- per `config.rules.execution`'s thresholds (5
 * retries or 10 minutes by default, both explicitly revisable). This is
 * NOT a trigger for any automatic notification (Telegram stays fully
 * on-demand-only, per spec) -- it exists purely so a stuck attempt is
 * easy to find via a query (`TransactionAttemptRepository.findNonTerminal()`
 * + this filter), e.g. from a future `/status` command, instead of being
 * indistinguishable from an attempt that's mid-retry for a few seconds.
 */
export function isStuckAttempt(attempt: TransactionAttemptRecord, now: number = Date.now()): boolean {
  if (attempt.status === 'VERIFIED' || attempt.status === 'FAILED') {
    return false; // terminal -- "stuck" only describes a non-terminal attempt
  }
  const rules = config.rules.execution;
  if (attempt.attemptCount >= rules.STUCK_ATTEMPT_MAX_RETRIES) {
    return true;
  }
  if (attempt.firstAttemptedAt && now - attempt.firstAttemptedAt.getTime() >= rules.STUCK_ATTEMPT_MAX_AGE_MS) {
    return true;
  }
  return false;
}
