/**
 * TIER 3 — every trigger that can CLOSE a position, aligned to Meridian's
 * exit ladder. Listed in evaluation-priority order (see
 * `resolveExitDecision.ts`, where that order IS the policy):
 *
 *  1. HARD_STOP_LOSS     PnL <= -6%
 *  2. SAFETY_EXIT        armed at max-drawdown <= -8%, closes on recovery to >= 0%
 *  3. OVEREXTENDED       Bollinger %B >= 1.0 AND PnL > 0
 *  4. TRAILING_TP        arm +6%, close -3pp from peak after 15s confirm
 *  5. HARD_TP            PnL >= +25%
 *  6. OOR_PROFIT         out of range AND PnL >= +2%
 *  7. LOW_YIELD          age >= 30min AND fee yield below floor
 *  8. OOR_TIMEOUT        out of range past the 30-minute grace window
 *  8. INFRA_SAFETY_EXIT  infrastructure fault (unreadable metrics / impossible price)
 *
 * Two renames from the pre-Tier-3 set, both deliberate:
 *  - `OOR` -> `OOR_TIMEOUT`, to distinguish the unprofitable grace-window
 *    exit from the new profitable `OOR_PROFIT` one.
 *  - `SAFETY_EXIT` now means Meridian's DRAWDOWN-RECOVERY rule; Lunex's
 *    original infrastructure-fault exit is `INFRA_SAFETY_EXIT`. They are
 *    genuinely different things (a trading rule vs. a data-integrity
 *    guard) and collapsing them would make an operator unable to tell a
 *    banked recovery from an RPC outage in the close history.
 *
 * `PNL_PROTECTION` is gone entirely: it was the same -8%/0% numbers
 * expressed only as a retarget of Trailing TP's arm threshold, and is
 * fully superseded by `SAFETY_EXIT`, which closes outright.
 */
export type ExitTriggerReason =
  | 'HARD_STOP_LOSS'
  | 'SAFETY_EXIT'
  | 'OVEREXTENDED'
  | 'TRAILING_TP'
  | 'HARD_TP'
  | 'OOR_PROFIT'
  | 'LOW_YIELD'
  | 'OOR_TIMEOUT'
  | 'INFRA_SAFETY_EXIT';

/** Every reason, in evaluation order -- exported so reporting surfaces (API/Telegram/UI) can render a complete, ordered legend without re-declaring the list. */
export const EXIT_TRIGGER_REASONS: readonly ExitTriggerReason[] = [
  'HARD_STOP_LOSS',
  'SAFETY_EXIT',
  'OVEREXTENDED',
  'TRAILING_TP',
  'HARD_TP',
  'OOR_PROFIT',
  'LOW_YIELD',
  'OOR_TIMEOUT',
  'INFRA_SAFETY_EXIT',
];

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
  SAFETY_EXIT: { ENABLED: boolean; TRIGGER_PCT: number; TARGET_PCT: number };
  OVEREXTENDED: { ENABLED: boolean; BB_PERCENT_B: number };
  TRAILING_TP: { ENABLED: boolean; TRIGGER_PEAK_PNL_PCT: number; DRAWDOWN_FROM_PEAK_PCT: number; CONFIRM_WINDOW_MS: number };
  HARD_TAKE_PROFIT_PCT: number;
  OOR_PROFIT: { ENABLED: boolean; MIN_PNL_PCT: number };
  LOW_YIELD: { ENABLED: boolean; MIN_AGE_MS: number; MIN_FEE_YIELD_PCT: number };
  OOR: { GRACE_WINDOW_MS: number };
}

/**
 * TIER 3 — the live readings one position's exit decision is made from.
 * EVERY field is nullable on purpose: "infrastructure failure is not a
 * trading signal" is enforced by type, not by convention. A rule whose
 * inputs are null simply does not fire; nothing is ever defaulted to a
 * placeholder number that could be mistaken for a real reading.
 *
 * (Pre-Tier-3 this was two bare `pnlPct: number` / `inRange: boolean`
 * parameters with `?? 0` / `?? true` placeholders supplied by the
 * orchestrator -- safe only because of a subtle argument about which
 * branch could be reached, and actively wrong for the OOR timer, which
 * the `?? true` placeholder silently RESET on every failed metrics read.)
 */
export interface ExitMetricsSnapshot {
  /** Position value PnL as a fraction (0.06 = +6%). null = this tick's metrics read failed. */
  pnlPct: number | null;
  /** null = unknown this tick; the OOR timer is then left exactly as it was, never advanced or cleared. */
  inRange: boolean | null;
  /** Cumulative realised fee yield (fees / entry value) as a fraction. null = unknown. */
  yieldPct: number | null;
  /** Bollinger %B of the pool price, 20 x 5-minute closes, SMA +/- 2 sigma. null = not enough history yet, or unavailable. */
  bbPercentB: number | null;
  /** Milliseconds since the position was opened. null = `openedAt` unknown (never for a genuinely ACTIVE position). */
  positionAgeMs: number | null;
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
  /** Highest PNL % ever observed since Trailing TP armed; null = not yet armed. Only ever moves UP. */
  trailingPeakPnlPct: number | null;
  /** When the current drawdown-from-peak breach was first observed; null = no breach in progress (pending trailing exit cancelled). */
  drawdownConfirmStartedAt: Date | null;
  /** When the position first went out of range; null = currently in range (or never left). */
  oorStartedAt: Date | null;
  /**
   * TIER 3 — when Meridian's Safety Exit ARMED, i.e. when this position's
   * maximum drawdown first reached `SAFETY_EXIT.TRIGGER_PCT` (-8%). Sticky:
   * never cleared, so a later dip back below 0% cannot disarm it, and a
   * restart cannot forget it. (Renamed from `pnlProtectionActivatedAt`;
   * the arming condition is materially identical, so existing rows carry
   * over unchanged -- see the migration.)
   */
  safetyExitArmedAt: Date | null;
  /**
   * TIER 3 — the most NEGATIVE PnL ever observed for this position
   * (maximum drawdown), as a fraction. null = no PnL reading yet. Only
   * ever moves down. This is what Safety Exit arms against, so that a
   * position which dipped to -9% and bounced back to -1% between two
   * polls still arms rather than silently missing the trigger.
   */
  maxDrawdownPnlPct: number | null;
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
  /**
   * The USDG increase the CURRENT swap attempt's balance check already
   * accepted, persisted the moment that check passed (reset to null by
   * `swapTx.ts`'s `buildTransaction` for every new attempt). A resumed
   * `verifyOnChain` -- after the proceeds read failed -- reuses this instead
   * of re-reading the live balance, which concurrent wallet activity (a
   * mint spending USDG between ticks) could have pushed below the baseline,
   * turning an already-filled swap into a false definitive failure.
   */
  swapVerifiedUsdgIncreaseRaw: bigint | null;
  /** The trigger reason recorded at markClosing() time, read back for markClosed() once the exit completes -- may be ticks or a restart later. */
  pendingCloseReason: ExitTriggerReason | null;
}

export interface ExitStateRecord extends ExitStateFields {
  positionId: string;
  /** Stale-writer fix: optimistic-concurrency version, +1 on every write. Pass it back to `updateDecisionState` as `expectedVersion`. */
  version: number;
  /**
   * Unroutable TOKEN leg: why the CURRENT swap attempt cannot proceed right
   * now, since when (continuous), and when last re-checked. Optional so
   * records built before the columns existed read as "not blocked".
   * Observability/classification only -- never closes or settles anything.
   */
  swapLegBlockedReason?: SwapLegBlockReason | null;
  swapLegBlockedSince?: Date | null;
  swapLegLastCheckedAt?: Date | null;
}

/** Why the TOKEN->USDG swap of a CLOSING position cannot proceed right now (it stays CLOSING and is retried every tick). */
/**
 * Why a TOKEN swap leg cannot proceed right now.
 *
 * TRANSIENT (retried every tick -- the cause can change on its own):
 *   QUOTE_UNAVAILABLE, PRICE_IMPACT_BLOCKED
 * DETERMINISTIC (backed off and surfaced to the operator -- the cause is
 * configuration and identical retries cannot succeed; see swapLegBackoff.ts):
 *   TARGET_NOT_APPROVED           the provider's swap target, its embedded
 *                                 router, or its calldata failed the
 *                                 two-layer execution-target validation
 *   APPROVAL_SPENDER_NOT_APPROVED the provider asked us to approve a spender
 *                                 that is not an approved execution target
 *
 * Persisted as `REASON#fingerprint`; read back with `decodeBlockReason`.
 */
export type SwapLegBlockReason = 'QUOTE_UNAVAILABLE' | 'PRICE_IMPACT_BLOCKED' | 'TARGET_NOT_APPROVED' | 'APPROVAL_SPENDER_NOT_APPROVED';

/**
 * The fields the per-tick DECISION owns (resolveExitDecision's timers /
 * sticky arming / running extremes, the metrics-failure streak, and the
 * close reason recorded just before `markClosing`). Deliberately EXCLUDES
 * `swapAttemptCount` (only ever moved by `incrementSwapAttemptFrom`) and
 * the swap-leg fields (only ever moved by `updateSwapLegFields`): the
 * decision pass never has a reason to write them, so it can never regress
 * them from a stale snapshot.
 */
export type DecisionStatePatch = Partial<
  Pick<
    ExitStateFields,
    'trailingPeakPnlPct' | 'drawdownConfirmStartedAt' | 'oorStartedAt' | 'safetyExitArmedAt' | 'maxDrawdownPnlPct' | 'metricsFailureSince' | 'pendingCloseReason'
  >
>;

/** The per-swap-attempt metadata `exits/swapTx.ts` records. */
export type SwapLegPatch = Partial<Pick<ExitStateFields, 'swapUsdgBalanceBeforeRaw' | 'swapMinOutputAmountRaw' | 'swapVerifiedUsdgIncreaseRaw'>>;

/**
 * Thrown by `updateDecisionState` when a patch would move a MONOTONIC field
 * backwards relative to the row it is replacing: clearing or re-dating a
 * set `safetyExitArmedAt` (sticky, write-once -- P0-3), raising
 * `maxDrawdownPnlPct` (a running minimum), or lowering / clearing
 * `trailingPeakPnlPct` (a running maximum once armed). `resolveExitDecision`
 * never produces such a patch, so this only fires on a programming error.
 */
export class ExitStateMonotonicityError extends Error {
  constructor(positionId: string, detail: string) {
    super(`ExitState for position ${positionId}: refusing a non-monotonic write -- ${detail}`);
    this.name = 'ExitStateMonotonicityError';
  }
}

/** Throws `ExitStateMonotonicityError` if `patch` would move a monotonic field of `current` backwards. Shared by the real and in-memory repositories. */
export function assertMonotonicDecisionPatch(positionId: string, current: ExitStateFields, patch: DecisionStatePatch): void {
  if ('safetyExitArmedAt' in patch && current.safetyExitArmedAt !== null && patch.safetyExitArmedAt?.getTime() !== current.safetyExitArmedAt.getTime()) {
    throw new ExitStateMonotonicityError(positionId, `safetyExitArmedAt is sticky (armed at ${current.safetyExitArmedAt.toISOString()})`);
  }
  if ('maxDrawdownPnlPct' in patch && current.maxDrawdownPnlPct !== null && (patch.maxDrawdownPnlPct === null || patch.maxDrawdownPnlPct === undefined || patch.maxDrawdownPnlPct > current.maxDrawdownPnlPct)) {
    throw new ExitStateMonotonicityError(positionId, `maxDrawdownPnlPct only moves down (${current.maxDrawdownPnlPct} -> ${String(patch.maxDrawdownPnlPct)})`);
  }
  if ('trailingPeakPnlPct' in patch && current.trailingPeakPnlPct !== null && (patch.trailingPeakPnlPct === null || patch.trailingPeakPnlPct === undefined || patch.trailingPeakPnlPct < current.trailingPeakPnlPct)) {
    throw new ExitStateMonotonicityError(positionId, `trailingPeakPnlPct only moves up (${current.trailingPeakPnlPct} -> ${String(patch.trailingPeakPnlPct)})`);
  }
}

export const EMPTY_EXIT_STATE: ExitStateFields = {
  trailingPeakPnlPct: null,
  drawdownConfirmStartedAt: null,
  oorStartedAt: null,
  safetyExitArmedAt: null,
  maxDrawdownPnlPct: null,
  metricsFailureSince: null,
  swapAttemptCount: 0,
  swapUsdgBalanceBeforeRaw: null,
  swapMinOutputAmountRaw: null,
  swapVerifiedUsdgIncreaseRaw: null,
  pendingCloseReason: null,
};

export interface ExitStateRepository {
  /** Reads the persisted state for a position, creating an all-null/zero row on first use (never throws for a position with no prior state). */
  getOrCreate(positionId: string): Promise<ExitStateRecord>;
  /**
   * Stale-writer fix: compare-and-swap write of decision-owned fields --
   * applied ONLY if the row is still at `expectedVersion` (the version the
   * caller read), bumping it by 1; returns `null` (nothing written) when
   * another writer got there first, and the caller must NOT act on the
   * decision it computed from the stale snapshot (it re-reads next tick).
   * Also enforces monotonic fields (`assertMonotonicDecisionPatch`). There
   * is no unconditional "merge a patch" write any more -- the old one let
   * a stale full-object write revert newer state (e.g. swapAttemptCount).
   */
  updateDecisionState(positionId: string, expectedVersion: number, patch: DecisionStatePatch): Promise<ExitStateRecord | null>;
  /**
   * Atomically moves swapAttemptCount from `expectedCount` to
   * `expectedCount + 1` (and bumps version). Returns false -- a no-op --
   * if the count is no longer `expectedCount`: another worker already
   * recorded THIS failure (so the counter never skips a slippage tier) or
   * moved on. Never read-increment-write.
   */
  incrementSwapAttemptFrom(positionId: string, expectedCount: number): Promise<boolean>;
  /**
   * Writes per-swap-attempt metadata ONLY while swapAttemptCount still
   * equals `expectedSwapAttemptCount` (bumps version). Returns false when
   * the counter has moved on -- the caller belongs to an older attempt and
   * must not overwrite the newer attempt's baseline.
   */
  updateSwapLegFields(positionId: string, expectedSwapAttemptCount: number, patch: SwapLegPatch): Promise<boolean>;
  /**
   * Unroutable TOKEN leg: records (for swap attempt `expectedSwapAttemptCount`
   * only -- a stale worker on an older attempt writes nothing) that the swap
   * cannot proceed right now. `swapLegBlockedSince` is set ONCE per
   * continuous block (a later tick, or a flip between the two reasons, never
   * resets it); reason and last-checked are refreshed. Returns 'NEW' when
   * this call started (or changed the reason of) the block, 'UNCHANGED' when
   * it only refreshed it, 'STALE' when the attempt number moved on.
   */
  recordSwapLegBlocked(positionId: string, expectedSwapAttemptCount: number, reason: SwapLegBlockReason, at: Date): Promise<'NEW' | 'UNCHANGED' | 'STALE'>;
  /** Clears the block (the swap can proceed now) -- for `expectedSwapAttemptCount` only; a no-op when nothing is recorded. */
  clearSwapLegBlocked(positionId: string, expectedSwapAttemptCount: number): Promise<void>;
  /** Position ids whose swapAttemptCount has reached/exceeded `threshold` -- see EXITS.SWAP_RETRY.STUCK_THRESHOLD. Not wired to any live alerting yet (Module 9). */
  findStuckSwapRetries(threshold: number): Promise<string[]>;
}
