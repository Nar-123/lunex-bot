import { config } from '../config';
import { backoffDelayMs, decodeBlockReason, isDeterministicBlockReason } from './swapLegBackoff';
import { isStuckAttempt } from '../execution/stuckAttempt';
import type { TransactionAttemptRecord } from '../execution/types';
import type { PositionRecord } from '../positions/types';
import { classifyUsdgOnlyRemoval } from './executeExit';
import type { ExitStateRecord } from './types';

/**
 * Where a CLOSING position is in its exit, derived ONLY from durable state
 * (the exit legs' TransactionAttempts and ExitState) -- never from a live
 * quote, balance or price read -- so the same answer comes back after any
 * restart.
 */
export type ClosingRecoveryPhase =
  | 'REMOVE_NOT_STARTED'
  | 'REMOVE_IN_PROGRESS'
  | 'AMBIGUOUS'
  | 'READY_TO_FINALIZE'
  | 'USDG_ONLY_ANOMALY'
  | 'SWAP_PENDING'
  | 'QUOTE_UNAVAILABLE'
  | 'PRICE_IMPACT_BLOCKED'
  | 'TARGET_NOT_APPROVED'
  | 'APPROVAL_SPENDER_NOT_APPROVED'
  | 'SWAP_FAILED_RETRY_PENDING';

export interface ClosingRecoveryReport {
  positionId: string;
  tokenAddress: string;
  tokenSymbol: string;
  closeReason: string | null;
  /** The close lifecycle -- what a manual settlement request (`POST /positions/:id/settle-token`) must name. */
  closeIdempotencyKey: string | null;
  phase: ClosingRecoveryPhase;
  /**
   * TRUE when the exit cannot finish on its own within the repository's
   * existing stuck-surfacing policy and a human should look. It triggers
   * NOTHING automatically -- the position stays CLOSING, keeps its slot,
   * token lock and capital, and keeps being retried.
   */
  operatorActionRequired: boolean;
  /** When the exit's remove-liquidity leg was first attempted (null = not started). */
  closingSince: Date | null;
  closingAgeMs: number | null;
  /** TOKEN the remove-liquidity receipt paid the wallet and no verified swap has converted yet -- receipt-proven, raw units. null = unknown (not removed yet / legacy attempt). */
  tokenResidualRaw: bigint | null;
  /** USDG already recovered by this exit's verified legs (remove + any verified swap), receipt-measured, raw units. null = unknown. */
  usdgRecoveredRaw: bigint | null;
  swapAttemptCount: number;
  blockedSince: Date | null;
  lastCheckedAt: Date | null;
  detail: string;
}

const POSSIBLY_MINED_UNVERIFIED = new Set(['SIGNED', 'SENT', 'CONFIRMED']);

function bigintField(data: unknown, field: string): bigint | null {
  if (typeof data !== 'object' || data === null || !(field in data)) return null;
  const value = (data as Record<string, unknown>)[field];
  return typeof value === 'bigint' ? value : null;
}

/**
 * Unroutable TOKEN leg: classifies one CLOSING position for the operator.
 * Uses ONLY existing policies -- `STUCK_ATTEMPT_MAX_AGE_MS` (the repo's
 * existing "stuck" surfacing age, applied to a continuous swap-leg block),
 * `SWAP_RETRY.STUCK_THRESHOLD` (all slippage tiers spent) and
 * `isStuckAttempt` (an ambiguous transaction stuck too long / too often) --
 * no new threshold, no dust threshold, and no action of any kind.
 */
export function assessClosingRecovery(
  position: PositionRecord,
  exitLegs: readonly TransactionAttemptRecord[],
  exitState: ExitStateRecord,
  now: Date,
): ClosingRecoveryReport {
  const base = {
    positionId: position.id,
    tokenAddress: position.tokenAddress,
    tokenSymbol: position.tokenSymbol,
    closeReason: exitState.pendingCloseReason,
    closeIdempotencyKey: position.closeIdempotencyKey,
    swapAttemptCount: exitState.swapAttemptCount,
    blockedSince: exitState.swapLegBlockedSince ?? null,
    lastCheckedAt: exitState.swapLegLastCheckedAt ?? null,
  };
  const closeKey = position.closeIdempotencyKey ?? '';
  const remove = exitLegs.find((a) => a.idempotencyKey === `${closeKey}:removeLiquidity`);
  const closingSince = remove?.firstAttemptedAt ?? null;
  const closingAgeMs = closingSince ? now.getTime() - closingSince.getTime() : null;
  const report = (phase: ClosingRecoveryPhase, operatorActionRequired: boolean, detail: string, residual: bigint | null = null, recovered: bigint | null = null): ClosingRecoveryReport => ({
    ...base,
    phase,
    operatorActionRequired,
    closingSince,
    closingAgeMs,
    tokenResidualRaw: residual,
    usdgRecoveredRaw: recovered,
    detail,
  });

  if (!remove) return report('REMOVE_NOT_STARTED', false, 'remove-liquidity not attempted yet');
  if (POSSIBLY_MINED_UNVERIFIED.has(remove.status)) {
    return report('AMBIGUOUS', isStuckAttempt(remove, now.getTime()), `remove-liquidity ${remove.status} -- possibly mined, not yet verified`);
  }
  if (remove.status !== 'VERIFIED') return report('REMOVE_IN_PROGRESS', isStuckAttempt(remove, now.getTime()), `remove-liquidity ${remove.status}`);

  const removeData: unknown = remove.verifyData;
  const removeUsdg = bigintField(removeData, 'usdgProceedsRaw');
  const removeToken = bigintField(removeData, 'tokenProceedsRaw');
  const swap = exitLegs.find((a) => a.idempotencyKey === `${closeKey}:swap:${exitState.swapAttemptCount}`);
  const swapUsdg = swap?.status === 'VERIFIED' ? bigintField(swap.verifyData, 'usdgProceedsRaw') : null;
  const recovered = removeUsdg === null ? null : removeUsdg + (swapUsdg ?? 0n);

  if (swap?.status === 'VERIFIED') return report('READY_TO_FINALIZE', false, 'swap verified -- finalizes on the next tick', 0n, recovered);
  if (swap && POSSIBLY_MINED_UNVERIFIED.has(swap.status)) {
    return report('AMBIGUOUS', isStuckAttempt(swap, now.getTime()), `swap ${swap.status} -- possibly mined, not yet verified`, removeToken, recovered);
  }
  if (removeToken === 0n) {
    const usdgOnly = classifyUsdgOnlyRemoval(position.entryUsdgRaw, removeUsdg ?? 0n);
    return usdgOnly.ok
      ? report('READY_TO_FINALIZE', false, 'USDG-only removal -- finalizes on the next tick', 0n, recovered)
      : report('USDG_ONLY_ANOMALY', true, usdgOnly.reason, 0n, recovered);
  }
  // The stored value may carry a failure fingerprint (`REASON#digest`) -- the
  // operator-facing phase is always the bare reason.
  const { reason: blockReason } = decodeBlockReason(exitState.swapLegBlockedReason ?? null);
  const blockedSince = exitState.swapLegBlockedSince ?? null;
  if (blockReason !== null) {
    const blockedForMs = blockedSince ? now.getTime() - blockedSince.getTime() : 0;
    const deterministic = isDeterministicBlockReason(blockReason);
    // A deterministic block cannot resolve itself, so it reaches the operator on
    // its own (shorter) policy; a transient one keeps the existing stuck age.
    const stuck = deterministic
      ? blockedForMs >= config.rules.exits.DETERMINISTIC_BLOCK_BACKOFF.OPERATOR_ACTION_AFTER_MS
      : blockedForMs >= config.rules.execution.STUCK_ATTEMPT_MAX_AGE_MS;
    const cadence = deterministic
      ? `retries backed off to every ${Math.round(backoffDelayMs(blockedForMs) / 1000)}s -- operator action required to clear it`
      : 'retried every tick';
    return report(blockReason, stuck, `TOKEN swap cannot proceed (${blockReason}) for ${Math.floor(blockedForMs / 1000)}s -- TOKEN retained, ${cadence}`, removeToken, recovered);
  }
  if (exitState.swapAttemptCount > 0) {
    return report(
      'SWAP_FAILED_RETRY_PENDING',
      exitState.swapAttemptCount >= config.rules.exits.SWAP_RETRY.STUCK_THRESHOLD,
      `${exitState.swapAttemptCount} definitive swap failure(s) -- retrying with the next slippage tier`,
      removeToken,
      recovered,
    );
  }
  return report('SWAP_PENDING', false, 'TOKEN swap pending', removeToken, recovered);
}
