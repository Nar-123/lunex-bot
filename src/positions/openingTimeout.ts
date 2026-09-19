import { config } from '../config';
import type { OpeningExpiryResult, PositionRecord, PositionRepository } from './types';

/** Structurally the project's `composition/logger.ts` `Logger` -- `positions/` does not depend on `composition/`. */
export interface OpeningTimeoutLogger {
  info(event: string, data?: Record<string, unknown>): void;
  warn(event: string, data?: Record<string, unknown>): void;
}

export interface OpeningTimeoutDeps {
  positions: PositionRepository;
  logger: OpeningTimeoutLogger;
  /** Defaults to `config.rules.execution.OPENING_MAX_AGE_MS`. */
  maxAgeMs?: number;
  /** Defaults to the wall clock -- injectable for deterministic tests. */
  now?: () => Date;
}

/**
 * H3: bounds how long an OPENING position may hold reserved capital, its
 * position slot, and its token -- without ever releasing them while its
 * entry could still succeed.
 *
 * Why this is needed: an OPENING whose mint cannot be built (P0-4's
 * fresh-price guard keeps rejecting a range the price has moved into, or
 * the price read keeps failing) returns `PENDING` from
 * `executeCriticalTransaction` every 15s tick, forever -- nothing ever
 * moved it to a terminal state, so its capital stayed reserved
 * (`freeUsdgBalance` reduced, `totalDeployedUsdg` increased), its slot
 * counted against MAX_ACTIVE_POSITIONS, and the token stayed locked by the
 * one-token-one-position index.
 *
 * Policy (fail-closed, see `PositionRepository.expireStaleOpening`):
 *  - younger than `OPENING_MAX_AGE_MS` (age from the persisted
 *    `createdAt`, so a restart never resets it) -> untouched;
 *  - older, and the mint provably never broadcast (no mint attempt, or one
 *    still before SIGNED -- price unavailable, price incompatible, build /
 *    simulate / gas / nonce stage) -> mint key fenced FAILED and the
 *    position FAILED, atomically: capital, slot and token released; NO
 *    retry transaction is created (the next screening cycle re-evaluates
 *    fresh candidates, per the entry flow's own documented policy);
 *  - older, but the mint is SIGNED/SENT/CONFIRMED (may be or become
 *    mined; confirmed-but-not-yet-verified) -> NOT released; the normal
 *    resume path keeps resolving it through the existing
 *    transaction-attempt semantics;
 *  - older, but the mint is already VERIFIED -> NOT released; the normal
 *    resume path recovers it to ACTIVE (P1-6).
 *
 * Returns whether the caller must SKIP the normal resume for this
 * position this tick (only when it was just expired / is no longer OPENING).
 */
export async function enforceOpeningTimeout(position: PositionRecord, deps: OpeningTimeoutDeps): Promise<{ skipResume: boolean; result: OpeningExpiryResult }> {
  const maxAgeMs = deps.maxAgeMs ?? config.rules.execution.OPENING_MAX_AGE_MS;
  const now = deps.now?.() ?? new Date();
  const result = await deps.positions.expireStaleOpening(position.id, maxAgeMs, now);

  switch (result.outcome) {
    case 'TOO_YOUNG':
      return { skipResume: false, result };
    case 'NOT_OPENING':
      return { skipResume: true, result };
    case 'EXPIRED':
      deps.logger.info('opening_timeout_eligible', { positionId: position.id, maxAgeMs });
      deps.logger.warn('opening_timeout_failed', {
        positionId: position.id,
        tokenAddress: position.tokenAddress,
        releasedEntryUsdgRaw: position.entryUsdgRaw.toString(),
        mintStatusBefore: result.mintStatusBefore,
        maxAgeMs,
      });
      return { skipResume: true, result };
    case 'BLOCKED_UNRESOLVED_TX':
      deps.logger.info('opening_timeout_eligible', { positionId: position.id, maxAgeMs });
      deps.logger.warn('opening_timeout_blocked_unresolved_tx', { positionId: position.id, mintStatus: result.mintStatus, maxAgeMs });
      return { skipResume: false, result };
    case 'MINT_VERIFIED':
      deps.logger.info('opening_timeout_eligible', { positionId: position.id, maxAgeMs });
      return { skipResume: false, result };
  }
}
