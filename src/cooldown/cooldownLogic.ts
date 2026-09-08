import { config } from '../config';
import type { CooldownStatus } from '../filters/types';

/** Pure function: given a stored exit time, compute when the cooldown ends. No I/O. */
export function computeCooldownEndsAt(exitedAt: Date): Date {
  return new Date(exitedAt.getTime() + config.rules.cooldown.DURATION_MS);
}

/**
 * Pure function: given a stored cooldown-end time (or none, meaning the
 * token has never exited / has no row), compute the current status. No
 * I/O -- `cooldownRepository.ts` is the only thing that touches the
 * database, and it delegates the actual pass/fail + remaining-time
 * arithmetic here so it's fully unit-testable without a DB.
 */
export function computeCooldownStatus(cooldownEndsAt: Date | null, now: number = Date.now()): CooldownStatus {
  if (!cooldownEndsAt) {
    return { inCooldown: false, remainingMs: 0 };
  }
  const endsAtMs = cooldownEndsAt.getTime();
  if (now >= endsAtMs) {
    return { inCooldown: false, remainingMs: 0 };
  }
  return { inCooldown: true, remainingMs: endsAtMs - now, cooldownEndsAt: endsAtMs };
}
