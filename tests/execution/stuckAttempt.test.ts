import { describe, expect, it } from 'vitest';
import { isStuckAttempt } from '../../src/execution/stuckAttempt';
import type { TransactionAttemptRecord } from '../../src/execution/types';

function baseAttempt(overrides: Partial<TransactionAttemptRecord> = {}): TransactionAttemptRecord {
  return {
    id: '1',
    idempotencyKey: 'k',
    purpose: 'p',
    status: 'SENT',
    txRequest: null,
    gasLimit: null,
    gasPrice: null,
    nonce: null,
    rawTx: null,
    txHash: null,
    lastError: null,
    verifyData: null,
    failureCode: null,
    attemptCount: 1,
    firstAttemptedAt: new Date(),
    version: 1,
    executorAddress: null,
    ...overrides,
  };
}

describe('isStuckAttempt', () => {
  it('is never stuck when the status is terminal (VERIFIED), regardless of counters', () => {
    const attempt = baseAttempt({ status: 'VERIFIED', attemptCount: 999, firstAttemptedAt: new Date(0) });
    expect(isStuckAttempt(attempt)).toBe(false);
  });

  it('is never stuck when the status is terminal (FAILED), regardless of counters', () => {
    const attempt = baseAttempt({ status: 'FAILED', attemptCount: 999, firstAttemptedAt: new Date(0) });
    expect(isStuckAttempt(attempt)).toBe(false);
  });

  it('is not stuck for a fresh, non-terminal attempt', () => {
    const now = Date.now();
    const attempt = baseAttempt({ status: 'SENT', attemptCount: 1, firstAttemptedAt: new Date(now) });
    expect(isStuckAttempt(attempt, now)).toBe(false);
  });

  it('becomes stuck once attemptCount reaches the configured max retries (5)', () => {
    const now = Date.now();
    const attempt = baseAttempt({ status: 'SENT', attemptCount: 5, firstAttemptedAt: new Date(now) });
    expect(isStuckAttempt(attempt, now)).toBe(true);
  });

  it('is not stuck one retry below the threshold', () => {
    const now = Date.now();
    const attempt = baseAttempt({ status: 'SENT', attemptCount: 4, firstAttemptedAt: new Date(now) });
    expect(isStuckAttempt(attempt, now)).toBe(false);
  });

  it('becomes stuck once the configured max age (10 minutes) has elapsed since firstAttemptedAt', () => {
    const now = Date.now();
    const tenMinutesAgo = now - 10 * 60 * 1000;
    const attempt = baseAttempt({ status: 'SENT', attemptCount: 1, firstAttemptedAt: new Date(tenMinutesAgo) });
    expect(isStuckAttempt(attempt, now)).toBe(true);
  });

  it('is not stuck just under the max age', () => {
    const now = Date.now();
    const almostTenMinutesAgo = now - (10 * 60 * 1000 - 1);
    const attempt = baseAttempt({ status: 'SENT', attemptCount: 1, firstAttemptedAt: new Date(almostTenMinutesAgo) });
    expect(isStuckAttempt(attempt, now)).toBe(false);
  });

  it('is not stuck when firstAttemptedAt is null (never actually attempted yet)', () => {
    const attempt = baseAttempt({ status: 'PENDING', attemptCount: 0, firstAttemptedAt: null });
    expect(isStuckAttempt(attempt)).toBe(false);
  });
});
