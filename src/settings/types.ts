/**
 * Live, operator-editable parameters (Module 10) -- the counterpart to the
 * frozen-at-import `config.rules.*` constants for the specific fields the
 * UI is allowed to change without a restart. Re-read fresh every relevant
 * cycle by the composition root (`screeningCycle.ts`/`runExitCycle.ts`),
 * never mutated in place -- see those files' doc comments for exactly how
 * a value here gets merged over frozen `config` before reaching a pure
 * decision function.
 *
 * Deliberately NOT every parameter the spec locks -- see README's Module
 * 10 section for the full "why these four, not more" reasoning (stateless
 * thresholds are safe to hot-swap; values compared against an
 * already-running persisted timer are not, so timer/window durations stay
 * frozen; anything not explicitly named as a candidate stays frozen too).
 */
export interface SettingsFields {
  /** True = screening cycle skips entirely (no new deployments). Monitoring/exit are never affected -- see `screeningCycle.ts`. Controlled ONLY via `pause()`/`resume()`, never via `update()`. */
  paused: boolean;
  /** Fraction 0-1 (e.g. 0.35 = 35%) -- replaces `CAPITAL.POSITION_SIZE_PCT_OF_FREE_BALANCE`. */
  positionSizePct: number;
  /** Replaces `CAPITAL.MAX_ACTIVE_POSITIONS`. */
  maxActivePositions: number;
  /** Fraction, always negative (TIER 3 default -0.06 = -6%, Meridian's measured stop) -- replaces `EXITS.HARD_STOP_LOSS_PCT`. No longer cross-validated against the Safety Exit trigger: the Meridian ladder puts the stop deliberately TIGHTER than the -8% arming point. */
  hardStopLossPct: number;
  /** Fraction, always positive (TIER 3 default 0.06 = +6%, Meridian's measured trailing arm) -- replaces `EXITS.TRAILING_TP.TRIGGER_PEAK_PNL_PCT`. */
  trailingTpTriggerPct: number;
}

export interface SettingsRecord extends SettingsFields {
  updatedAt: Date;
}

/** Fields `PATCH /settings` may change. `paused` is deliberately excluded -- only `pause()`/`resume()` touch it, so a bug in one control surface can never accidentally flip the other. */
export type SettingsPatch = Partial<Omit<SettingsFields, 'paused'>>;

export interface SettingsRepository {
  /** Reads the current live settings, creating the singleton row with defaults matching today's frozen `config.rules.*` values on first call (so behavior is unchanged until a real PATCH/pause happens). */
  get(): Promise<SettingsRecord>;
  /** Merges `patch` into the stored record. Caller (the `PATCH /settings` handler) is responsible for validating `patch` first -- this method does not re-validate. */
  update(patch: SettingsPatch): Promise<SettingsRecord>;
  pause(): Promise<SettingsRecord>;
  resume(): Promise<SettingsRecord>;
}

/** Matches the Prisma model's `@default(...)` values exactly -- see `prisma/schema.prisma`'s `BotSettings`. Also what the in-memory test double starts from. */
export const DEFAULT_SETTINGS: SettingsFields = {
  paused: false,
  positionSizePct: 0.35,
  maxActivePositions: 3,
  hardStopLossPct: -0.06, // TIER 3: Meridian's measured stop (was -0.15)
  trailingTpTriggerPct: 0.06, // TIER 3: Meridian's measured trailing arm (was 0.05)
};
