/**
 * The four triggers that can actually CLOSE a position (spec section 8,
 * minus LOW_YIELD -- explicitly OFF/not implemented). PNL_PROTECTION is
 * deliberately NOT a member of this type: it never independently closes a
 * position, it only retargets TRAILING_TP's arm threshold (see
 * `resolveExitDecision.ts`'s doc comment for the full reasoning) -- so
 * there is no `ExitTriggerReason` value for it, matching that it can never
 * appear as a `closeReason`.
 */
export type ExitTriggerReason = 'SAFETY_EXIT' | 'HARD_STOP_LOSS' | 'TRAILING_TP' | 'OOR';

export type ExitDecision = { shouldClose: false } | { shouldClose: true; reason: ExitTriggerReason };

/**
 * The subset of `config.rules.exits`'s shape `resolveExitDecision` actually
 * reads. Passed as an explicit, required parameter (Module 10) rather than
 * read from `config` internally -- `HARD_STOP_LOSS_PCT` and
 * `TRAILING_TP.TRIGGER_PEAK_PNL_PCT` are live-editable via
 * `settings/` (re-read fresh every exit-cycle tick by `runExitCycle.ts`,
 * merged over frozen `config.rules.exits` for every other field, most
 * importantly `PNL_PROTECTION.*` -- which stays frozen ALWAYS, never
 * settings-derived, per the explicit review requirement that PNL
 * Protection's own activation threshold and retarget value can never be
 * silently overridden by a live Trailing-TP-trigger change). `typeof
 * config.rules.exits` structurally satisfies this (it's a superset), so
 * passing it directly at any call site that hasn't opted into live
 * settings (tests, anything outside the composition root) needs no
 * conversion.
 */
export interface ExitRules {
  HARD_STOP_LOSS_PCT: number;
  PNL_PROTECTION: { TRIGGER_PNL_PCT: number; NEW_TP_TARGET_PCT: number };
  TRAILING_TP: { TRIGGER_PEAK_PNL_PCT: number; DRAWDOWN_FROM_PEAK_PCT: number; CONFIRM_WINDOW_MS: number };
  OOR: { GRACE_WINDOW_MS: number };
}

/**
 * Everything `resolveExitDecision` needs to persist across ticks/restarts,
 * with NO positionId/updatedAt (those are repository-level concerns, not
 * decision-engine inputs/outputs) -- kept as a plain data shape so
 * `resolveExitDecision` stays a pure function: (metrics, this) -> (decision,
 * a new value of this same shape), with the orchestrator responsible for
 * reading it from and writing it back to real storage.
 */
export interface ExitStateFields {
  /** Highest PNL % ever observed since Trailing TP armed; null = not yet armed. */
  trailingPeakPnlPct: number | null;
  /** When the current drawdown-from-peak breach was first observed; null = no breach in progress. */
  drawdownConfirmStartedAt: Date | null;
  /** When the position first went out of range; null = currently in range (or never left). */
  oorStartedAt: Date | null;
  /** When PNL first hit <= PNL_PROTECTION.TRIGGER_PNL_PCT; null = never (sticky once set -- never cleared by recovery). */
  pnlProtectionActivatedAt: Date | null;
  /** When this position's live metrics first failed to read; null = currently reading fine (or never failed). */
  metricsFailureSince: Date | null;
  /** How many times the exit SWAP sub-transaction (not remove-liquidity) has been found FAILED -- drives the swap's idempotencyKey suffix. */
  swapAttemptCount: number;
  /**
   * The wallet's USDG balance observed at the moment the CURRENT swap
   * attempt's transaction was built (set once, inside `swapTx.ts`'s
   * `buildTransaction` -- which runs exactly once per attempt and is
   * skipped on resume, so this is the only reliable way for a resumed
   * `verifyOnChain` call, potentially in a different process after a
   * restart, to know the correct "before" baseline). `null` until a swap
   * attempt has actually started building.
   */
  swapUsdgBalanceBeforeRaw: bigint | null;
  /** The minimum USDG increase `verifyOnChain` requires for the current swap attempt (0 when `EXITS.MIN_RECEIVED_PROTECTION_ENABLED` is false -- verification then degrades to "genuinely increased at all," matching the spec's literal on-chain-verification requirement without inventing a minimum that isn't supposed to exist). Persisted alongside `swapUsdgBalanceBeforeRaw` for the same restart-safety reason. */
  swapMinOutputAmountRaw: bigint | null;
  /** The trigger reason recorded at markClosing() time, read back for markClosed() once the exit completes -- may be ticks or a restart later. */
  pendingCloseReason: ExitTriggerReason | null;
}

export interface ExitStateRecord extends ExitStateFields {
  positionId: string;
}

export const EMPTY_EXIT_STATE: ExitStateFields = {
  trailingPeakPnlPct: null,
  drawdownConfirmStartedAt: null,
  oorStartedAt: null,
  pnlProtectionActivatedAt: null,
  metricsFailureSince: null,
  swapAttemptCount: 0,
  swapUsdgBalanceBeforeRaw: null,
  swapMinOutputAmountRaw: null,
  pendingCloseReason: null,
};

export interface ExitStateRepository {
  /** Reads the persisted state for a position, creating an all-null/zero row on first use (never throws for a position with no prior state). */
  getOrCreate(positionId: string): Promise<ExitStateRecord>;
  /** Merges `patch` into the stored record -- never a full replace, so a caller updating one field never has to first re-read every other field. */
  update(positionId: string, patch: Partial<ExitStateFields>): Promise<ExitStateRecord>;
  /** Atomically increments swapAttemptCount by 1 and returns the new record -- the one write that must never race with a plain `update`. */
  incrementSwapAttempt(positionId: string): Promise<ExitStateRecord>;
  /** Position ids whose swapAttemptCount has reached/exceeded `threshold` -- see EXITS.SWAP_RETRY.STUCK_THRESHOLD. Not wired to any live alerting yet (Module 9). */
  findStuckSwapRetries(threshold: number): Promise<string[]>;
}
