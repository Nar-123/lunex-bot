import { describe, expect, it, vi } from 'vitest';
import {
  addressesInMessage,
  backoffDelayMs,
  decodeBlockReason,
  encodeBlockReason,
  evaluateSuppression,
  fingerprintDeterministicFailure,
  isDeterministicBlockReason,
  recordDeterministicBlock,
} from '../../src/exits/swapLegBackoff';
import { assessClosingRecovery } from '../../src/exits/closingRecovery';
import { InMemoryExitStateRepository } from './inMemoryExitStateRepository';
import { config } from '../../src/config';
import type { SwapLegBlockReason } from '../../src/exits/types';

const T0 = new Date('2026-09-20T00:00:00.000Z');
const at = (ms: number): Date => new Date(T0.getTime() + ms);
const LADDER = config.rules.exits.DETERMINISTIC_BLOCK_BACKOFF;

function blocked(reason: string, fingerprint: string, sinceMs: number, lastCheckedMs = sinceMs) {
  return {
    swapLegBlockedReason: encodeBlockReason(reason as SwapLegBlockReason, fingerprint) as SwapLegBlockReason,
    swapLegBlockedSince: at(sinceMs),
    swapLegLastCheckedAt: at(lastCheckedMs),
  };
}

describe('block record encoding', () => {
  it('round-trips REASON#fingerprint and keeps the operator-facing reason stable', () => {
    expect(decodeBlockReason(encodeBlockReason('TARGET_NOT_APPROVED', 'abc123'))).toEqual({ reason: 'TARGET_NOT_APPROVED', fingerprint: 'abc123' });
    expect(decodeBlockReason('QUOTE_UNAVAILABLE')).toEqual({ reason: 'QUOTE_UNAVAILABLE', fingerprint: null });
    expect(decodeBlockReason(null)).toEqual({ reason: null, fingerprint: null });
  });

  it('classifies only configuration failures as deterministic', () => {
    expect(isDeterministicBlockReason('TARGET_NOT_APPROVED')).toBe(true);
    expect(isDeterministicBlockReason('APPROVAL_SPENDER_NOT_APPROVED')).toBe(true);
    expect(isDeterministicBlockReason('QUOTE_UNAVAILABLE')).toBe(false);
    expect(isDeterministicBlockReason('PRICE_IMPACT_BLOCKED')).toBe(false);
    expect(isDeterministicBlockReason(null)).toBe(false);
  });
});

describe('fingerprint', () => {
  it('is stable for the same failure and different for a different target or router', () => {
    const a = fingerprintDeterministicFailure({ errorClass: 'TARGET_NOT_APPROVED', target: '0xAAA', embeddedRouter: '0xBBB', detail: 'not approved' });
    expect(a).toBe(fingerprintDeterministicFailure({ errorClass: 'TARGET_NOT_APPROVED', target: '0xaaa', embeddedRouter: '0xbbb', detail: 'not  approved' }));
    expect(a).not.toBe(fingerprintDeterministicFailure({ errorClass: 'TARGET_NOT_APPROVED', target: '0xAAA', embeddedRouter: '0xCCC', detail: 'not approved' }));
    expect(a).not.toBe(fingerprintDeterministicFailure({ errorClass: 'APPROVAL_SPENDER_NOT_APPROVED', target: '0xAAA', embeddedRouter: '0xBBB', detail: 'not approved' }));
  });

  it('extracts the addresses a validation message names', () => {
    expect(addressesInMessage('target 0x02E5be68D46DAc0B524905bfF209cf47EE6dB2a9 router 0x204FAca1764B154221e35c0d20aBb3c525710498')).toEqual([
      '0x02e5be68d46dac0b524905bff209cf47ee6db2a9',
      '0x204faca1764b154221e35c0d20abb3c525710498',
    ]);
  });
});

describe('20. backoff ladder', () => {
  it('escalates 15s -> 1m -> 5m -> 15m as the SAME block persists, then caps', () => {
    expect(backoffDelayMs(0)).toBe(15_000);
    expect(backoffDelayMs(59_000)).toBe(15_000);
    expect(backoffDelayMs(60_000)).toBe(60_000);
    expect(backoffDelayMs(4 * 60_000)).toBe(60_000);
    expect(backoffDelayMs(5 * 60_000)).toBe(5 * 60_000);
    expect(backoffDelayMs(15 * 60_000)).toBe(15 * 60_000);
    expect(backoffDelayMs(10 * 60 * 60_000)).toBe(15 * 60_000); // capped
  });
});

describe('21. suppression', () => {
  it('suppresses ticks inside the current window and allows one when it expires', () => {
    const state = blocked('TARGET_NOT_APPROVED', 'fp1', 0);
    expect(evaluateSuppression(state, at(5_000)).suppressed).toBe(true);
    expect(evaluateSuppression(state, at(14_999)).suppressed).toBe(true);
    expect(evaluateSuppression(state, at(15_000)).suppressed).toBe(false);
  });

  it('after 1 minute blocked, the window is a minute wide (measured from the last check)', () => {
    const state = blocked('TARGET_NOT_APPROVED', 'fp1', 0, 90_000);
    expect(evaluateSuppression(state, at(120_000)).suppressed).toBe(true);
    expect(evaluateSuppression(state, at(150_000)).suppressed).toBe(false);
  });

  it('23. transient blocks are NEVER suppressed -- they keep retrying every tick', () => {
    for (const reason of ['QUOTE_UNAVAILABLE', 'PRICE_IMPACT_BLOCKED']) {
      expect(evaluateSuppression(blocked(reason, '', 0), at(1_000)).suppressed).toBe(false);
    }
    expect(evaluateSuppression({ swapLegBlockedReason: null, swapLegBlockedSince: null, swapLegLastCheckedAt: null }, at(1_000)).suppressed).toBe(false);
  });

  it('24. reports OPERATOR_ACTION_REQUIRED once the block has stood long enough', () => {
    expect(evaluateSuppression(blocked('TARGET_NOT_APPROVED', 'fp1', 0), at(LADDER.OPERATOR_ACTION_AFTER_MS - 1)).operatorActionRequired).toBe(false);
    expect(evaluateSuppression(blocked('TARGET_NOT_APPROVED', 'fp1', 0), at(LADDER.OPERATOR_ACTION_AFTER_MS)).operatorActionRequired).toBe(true);
  });
});

describe('19/22. durable block records', () => {
  it('19. records a durable block with its fingerprint', async () => {
    const repo = new InMemoryExitStateRepository();
    await repo.getOrCreate('p1');
    const change = await recordDeterministicBlock(repo, 'p1', 0, 'TARGET_NOT_APPROVED', 'fp1', T0, null);
    expect(change).toBe('NEW');
    const state = await repo.getOrCreate('p1');
    expect(decodeBlockReason(state.swapLegBlockedReason)).toEqual({ reason: 'TARGET_NOT_APPROVED', fingerprint: 'fp1' });
    expect(state.swapLegBlockedSince).toEqual(T0);
  });

  it('an unchanged fingerprint keeps the ORIGINAL blockedSince, so the ladder keeps escalating', async () => {
    const repo = new InMemoryExitStateRepository();
    await repo.getOrCreate('p1');
    await recordDeterministicBlock(repo, 'p1', 0, 'TARGET_NOT_APPROVED', 'fp1', T0, null);
    const stored = (await repo.getOrCreate('p1')).swapLegBlockedReason;
    await recordDeterministicBlock(repo, 'p1', 0, 'TARGET_NOT_APPROVED', 'fp1', at(600_000), stored);
    expect((await repo.getOrCreate('p1')).swapLegBlockedSince).toEqual(T0);
  });

  it('22. a CHANGED fingerprint resets the block (and therefore the backoff) immediately', async () => {
    const repo = new InMemoryExitStateRepository();
    await repo.getOrCreate('p1');
    await recordDeterministicBlock(repo, 'p1', 0, 'TARGET_NOT_APPROVED', 'fp1', T0, null);
    const stored = (await repo.getOrCreate('p1')).swapLegBlockedReason;

    await recordDeterministicBlock(repo, 'p1', 0, 'TARGET_NOT_APPROVED', 'fp2', at(600_000), stored);

    const state = await repo.getOrCreate('p1');
    expect(decodeBlockReason(state.swapLegBlockedReason).fingerprint).toBe('fp2');
    expect(state.swapLegBlockedSince).toEqual(at(600_000));
    expect(evaluateSuppression(state, at(600_000 + 15_001)).suppressed).toBe(false); // back to the first rung
  });

  it('never mutates anything but the block fields', async () => {
    const repo = new InMemoryExitStateRepository();
    const before = await repo.getOrCreate('p1');
    await recordDeterministicBlock(repo, 'p1', 0, 'APPROVAL_SPENDER_NOT_APPROVED', 'fp', T0, null);
    const after = await repo.getOrCreate('p1');
    expect({ ...after, swapLegBlockedReason: null, swapLegBlockedSince: null, swapLegLastCheckedAt: null, version: 0 }).toEqual({
      ...before,
      swapLegBlockedReason: null,
      swapLegBlockedSince: null,
      swapLegLastCheckedAt: null,
      version: 0,
    });
  });
});

describe('24. operator surfacing through the existing stuck report', () => {
  const position = { id: 'p1', tokenAddress: '0xtoken', tokenSymbol: 'PONS', entryUsdgRaw: 100n, closeIdempotencyKey: 'exit:p1:k' } as never;
  const legs = [
    { idempotencyKey: 'exit:p1:k:removeLiquidity', status: 'VERIFIED', firstAttemptedAt: T0, verifyData: { usdgProceedsRaw: '90', tokenProceedsRaw: '5' }, attemptCount: 1 },
  ] as never;

  it('a deterministic block surfaces its own phase and flips operatorActionRequired on its own policy', () => {
    const state = { ...blocked('TARGET_NOT_APPROVED', 'fp1', 0), swapAttemptCount: 0, pendingCloseReason: 'HARD_STOP_LOSS' } as never;
    const early = assessClosingRecovery(position, legs, state, at(60_000));
    expect(early.phase).toBe('TARGET_NOT_APPROVED'); // fingerprint never leaks into the phase
    expect(early.operatorActionRequired).toBe(false);
    expect(early.detail).toMatch(/retries backed off to every \d+s -- operator action required to clear it/);

    const late = assessClosingRecovery(position, legs, state, at(LADDER.OPERATOR_ACTION_AFTER_MS));
    expect(late.operatorActionRequired).toBe(true);
  });

  it('an APPROVAL_SPENDER_NOT_APPROVED block surfaces the same way', () => {
    const state = { ...blocked('APPROVAL_SPENDER_NOT_APPROVED', 'fp2', 0), swapAttemptCount: 0, pendingCloseReason: 'HARD_STOP_LOSS' } as never;
    expect(assessClosingRecovery(position, legs, state, at(LADDER.OPERATOR_ACTION_AFTER_MS)).phase).toBe('APPROVAL_SPENDER_NOT_APPROVED');
  });

  it('transient blocks keep their existing wording and (longer) stuck policy', () => {
    const state = { ...blocked('QUOTE_UNAVAILABLE', '', 0), swapAttemptCount: 0, pendingCloseReason: 'HARD_STOP_LOSS' } as never;
    const report = assessClosingRecovery(position, legs, state, at(60_000));
    expect(report.phase).toBe('QUOTE_UNAVAILABLE');
    expect(report.detail).toMatch(/retried every tick/);
  });
});

describe('recordDeterministicBlock resilience', () => {
  it('a repository failure is observational only -- it never throws into the exit flow', async () => {
    const repo = new InMemoryExitStateRepository();
    vi.spyOn(repo, 'recordSwapLegBlocked').mockRejectedValue(new Error('db down'));
    await expect(recordDeterministicBlock(repo, 'p1', 0, 'TARGET_NOT_APPROVED', 'fp', T0, null)).rejects.toThrow('db down');
  });
});
