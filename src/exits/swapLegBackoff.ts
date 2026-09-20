import { createHash } from 'node:crypto';
import { config } from '../config';
import type { ExitStateRecord, ExitStateRepository, SwapLegBlockReason } from './types';

/**
 * Deterministic swap-leg blocks and their backoff.
 *
 * A swap leg can be blocked for two very different kinds of reason:
 *
 *  TRANSIENT   `QUOTE_UNAVAILABLE`, `PRICE_IMPACT_BLOCKED` -- the cause can
 *              change on its own (routing, liquidity, price). These keep
 *              retrying EVERY tick, exactly as before; nothing here applies.
 *
 *  DETERMINISTIC  `TARGET_NOT_APPROVED`, `APPROVAL_SPENDER_NOT_APPROVED` -- a
 *              statement about CONFIGURATION (an unapproved execution target,
 *              an unapproved embedded router, undecodable proxy calldata, an
 *              unapproved approval spender). Identical inputs will fail
 *              identically forever, so retrying every 15s only burns Trading
 *              API calls. These back off on a ladder and, once they have stood
 *              long enough, surface as OPERATOR_ACTION_REQUIRED.
 *
 * ## Fingerprint, and why it lives in the existing column
 *
 * The block is persisted through the EXISTING `ExitState.swapLegBlocked*`
 * mechanism (no new column, no migration): `swapLegBlockedReason` stores
 * `REASON#fingerprint`, where the fingerprint is a short digest of the exact
 * failure (error class + target + embedded router + reason text). Readers that
 * only care about the reason -- `closingRecovery.ts`, `/positions/stuck`,
 * Telegram `/stuck` -- use `decodeBlockReason`, so the operator-visible phase
 * stays a stable enum value.
 *
 * A CHANGED fingerprint means a genuinely different failure: the block is
 * cleared and re-recorded, which resets `swapLegBlockedSince` and therefore the
 * backoff, so a fresh condition is evaluated immediately rather than waiting
 * out the previous ladder.
 *
 * The ladder is a pure function of how long the SAME fingerprint has stood, so
 * it needs no counter and survives restarts.
 */

export const DETERMINISTIC_BLOCK_REASONS = ['TARGET_NOT_APPROVED', 'APPROVAL_SPENDER_NOT_APPROVED'] as const;
export type DeterministicBlockReason = (typeof DETERMINISTIC_BLOCK_REASONS)[number];

export function isDeterministicBlockReason(reason: string | null | undefined): reason is DeterministicBlockReason {
  return typeof reason === 'string' && (DETERMINISTIC_BLOCK_REASONS as readonly string[]).includes(reason);
}

/** `REASON#fingerprint` -- what actually goes in `ExitState.swapLegBlockedReason`. */
export function encodeBlockReason(reason: SwapLegBlockReason, fingerprint?: string): string {
  return fingerprint ? `${reason}#${fingerprint}` : reason;
}

export function decodeBlockReason(stored: string | null | undefined): { reason: SwapLegBlockReason | null; fingerprint: string | null } {
  if (typeof stored !== 'string' || stored.length === 0) return { reason: null, fingerprint: null };
  const [reason, fingerprint] = stored.split('#');
  return { reason: (reason ?? null) as SwapLegBlockReason | null, fingerprint: fingerprint ?? null };
}

/**
 * Stable digest of ONE deterministic failure. Everything that distinguishes a
 * genuinely different failure goes in; nothing that changes per tick does (no
 * timestamps, no attempt counters), so an unchanged condition keeps its
 * fingerprint and keeps backing off.
 */
export function fingerprintDeterministicFailure(parts: { errorClass: string; target?: string | null; embeddedRouter?: string | null; detail: string }): string {
  const canonical = [parts.errorClass, (parts.target ?? '').toLowerCase(), (parts.embeddedRouter ?? '').toLowerCase(), parts.detail.replace(/\s+/g, ' ').trim()].join('|');
  return createHash('sha256').update(canonical).digest('hex').slice(0, 12);
}

/** Extracts the addresses a validation message names, so the fingerprint covers target + embedded router without the caller having to plumb them through. */
export function addressesInMessage(message: string): string[] {
  return [...new Set((message.match(/0x[0-9a-fA-F]{40}/g) ?? []).map((a) => a.toLowerCase()))];
}

/** Minimum spacing between attempts for a deterministic block that has stood `blockedForMs`. */
export function backoffDelayMs(blockedForMs: number, ladder: readonly (readonly [number, number])[] = config.rules.exits.DETERMINISTIC_BLOCK_BACKOFF.LADDER_MS): number {
  let delay = ladder[0]?.[1] ?? 0;
  for (const [afterMs, everyMs] of ladder) if (blockedForMs >= afterMs) delay = everyMs;
  return delay;
}

export interface SuppressionDecision {
  /** true = skip this tick entirely: no quote, no swap, no API call, no transaction attempt. */
  suppressed: boolean;
  reason: SwapLegBlockReason | null;
  fingerprint: string | null;
  blockedForMs: number;
  /** When the next attempt is allowed (null when not suppressed / not blocked). */
  nextAttemptAt: Date | null;
  /** The block has stood long enough that an operator must look at it. */
  operatorActionRequired: boolean;
}

type BlockView = Pick<ExitStateRecord, 'swapLegBlockedReason' | 'swapLegBlockedSince' | 'swapLegLastCheckedAt'>;

/**
 * Decides whether this tick may touch the provider at all. Transient blocks and
 * unblocked states are never suppressed.
 */
export function evaluateSuppression(state: BlockView, now: Date, backoff = config.rules.exits.DETERMINISTIC_BLOCK_BACKOFF): SuppressionDecision {
  const { reason, fingerprint } = decodeBlockReason(state.swapLegBlockedReason);
  const idle = { suppressed: false, reason, fingerprint, blockedForMs: 0, nextAttemptAt: null, operatorActionRequired: false };
  if (!isDeterministicBlockReason(reason) || !state.swapLegBlockedSince) return idle;

  const blockedForMs = Math.max(0, now.getTime() - state.swapLegBlockedSince.getTime());
  const operatorActionRequired = blockedForMs >= backoff.OPERATOR_ACTION_AFTER_MS;
  const lastChecked = state.swapLegLastCheckedAt ?? state.swapLegBlockedSince;
  const delay = backoffDelayMs(blockedForMs, backoff.LADDER_MS);
  const nextAttemptAt = new Date(lastChecked.getTime() + delay);
  return {
    suppressed: now.getTime() < nextAttemptAt.getTime(),
    reason,
    fingerprint,
    blockedForMs,
    nextAttemptAt,
    operatorActionRequired,
  };
}

/**
 * Records (or refreshes) a deterministic block. A changed fingerprint clears the
 * previous block first, so `swapLegBlockedSince` -- and therefore the whole
 * ladder -- restarts for the new condition.
 *
 * Purely observational: it never touches the position, its capital, its status
 * or any transaction attempt.
 */
export async function recordDeterministicBlock(
  exitStates: ExitStateRepository,
  positionId: string,
  swapAttemptCount: number,
  reason: DeterministicBlockReason,
  fingerprint: string,
  now: Date,
  previous?: string | null,
): Promise<'NEW' | 'UNCHANGED' | 'STALE'> {
  const prior = decodeBlockReason(previous);
  if (prior.reason !== null && prior.fingerprint !== fingerprint) {
    // Different failure than the one on record -- drop the old block so the backoff restarts from the first rung.
    await exitStates.clearSwapLegBlocked(positionId, swapAttemptCount);
  }
  return exitStates.recordSwapLegBlocked(positionId, swapAttemptCount, encodeBlockReason(reason, fingerprint) as SwapLegBlockReason, now);
}
