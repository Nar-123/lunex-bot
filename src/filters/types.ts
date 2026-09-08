export type FilterRuleId =
  | 'MARKET_CAP'
  | 'TOKEN_AGE'
  | 'VOLUME'
  | 'TOTAL_FEE'
  | 'HOLDER_CONCENTRATION'
  | 'ASSET_TYPE'
  | 'DUPLICATE_POSITION'
  | 'COOLDOWN';

export interface FilterCheckResult {
  rule: FilterRuleId;
  passed: boolean;
  /** Always populated (pass or fail), human-readable — used directly in logs/reports. */
  reason: string;
  meta?: Record<string, unknown>;
}

export interface ScreeningResult {
  tokenAddress: string;
  symbol: string;
  passed: boolean;
  /** Every rule's result, in spec-table order, always fully evaluated. */
  checks: FilterCheckResult[];
  /** First failing rule in spec-table order, if any. */
  failedRule?: FilterRuleId;
  evaluatedAt: number;
}

/**
 * Port for the "does this token already have an active position" check.
 * Filters must not depend on `positions/`'s concrete storage — that module
 * lands later in the build order. Whatever provides real position state
 * later just needs to satisfy this interface.
 */
export interface ActivePositionChecker {
  hasActivePosition(tokenAddress: string): Promise<boolean>;
}

export interface CooldownStatus {
  inCooldown: boolean;
  /** 0 when not in cooldown. */
  remainingMs: number;
  /** Epoch ms when the cooldown ends — present only while `inCooldown` is true. */
  cooldownEndsAt?: number;
}

/**
 * Port for the per-token cooldown check (2h post-exit, per spec). Same
 * dependency-inversion reasoning as `ActivePositionChecker` — the real
 * implementation arrives with the `cooldown/` module. Returns the full
 * remaining-time status, not just a boolean, since Telegram/UI `/status`
 * reporting (Module 8) needs to show how much cooldown time is left.
 */
export interface CooldownChecker {
  getCooldownStatus(tokenAddress: string): Promise<CooldownStatus>;
}

export interface ScreeningDeps {
  activePositionChecker: ActivePositionChecker;
  cooldownChecker: CooldownChecker;
}
