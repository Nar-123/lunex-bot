import { describe, expect, it } from 'vitest';
import { computeCooldownEndsAt, computeCooldownStatus } from '../../src/cooldown/cooldownLogic';

const TWO_HOURS_MS = 2 * 60 * 60 * 1000;

describe('computeCooldownEndsAt', () => {
  it('adds exactly the configured cooldown duration (2h) to the exit time', () => {
    const exitedAt = new Date('2026-01-01T00:00:00.000Z');
    const endsAt = computeCooldownEndsAt(exitedAt);
    expect(endsAt.getTime() - exitedAt.getTime()).toBe(TWO_HOURS_MS);
  });
});

describe('computeCooldownStatus', () => {
  it('is not in cooldown when there is no stored record at all', () => {
    const status = computeCooldownStatus(null);
    expect(status).toEqual({ inCooldown: false, remainingMs: 0 });
  });

  it('is in cooldown with correct remaining time when still active', () => {
    const now = Date.now();
    const cooldownEndsAt = new Date(now + 45 * 60 * 1000);
    const status = computeCooldownStatus(cooldownEndsAt, now);
    expect(status.inCooldown).toBe(true);
    expect(status.remainingMs).toBe(45 * 60 * 1000);
    expect(status.cooldownEndsAt).toBe(cooldownEndsAt.getTime());
  });

  it('is not in cooldown once the end time has passed', () => {
    const now = Date.now();
    const cooldownEndsAt = new Date(now - 1000);
    const status = computeCooldownStatus(cooldownEndsAt, now);
    expect(status).toEqual({ inCooldown: false, remainingMs: 0 });
  });

  it('is not in cooldown at the exact boundary instant (now === cooldownEndsAt)', () => {
    const now = Date.now();
    const status = computeCooldownStatus(new Date(now), now);
    expect(status.inCooldown).toBe(false);
  });

  it('is in cooldown one millisecond before the boundary', () => {
    const now = Date.now();
    const status = computeCooldownStatus(new Date(now + 1), now);
    expect(status.inCooldown).toBe(true);
    expect(status.remainingMs).toBe(1);
  });
});
