import type { CapitalRules } from './types';

/**
 * P0-2 fix: the strategy's hard safety ceilings -- the SAME numbers as the
 * documented Draft V1 / TIER 3 policy (`config/constants.ts`'s `CAPITAL`
 * block derives its defaults from these, not the other way around, so
 * there is exactly one place these three numbers are ever written).
 *
 * Before this fix, `PATCH /settings` could set `positionSizePct` up to
 * 100% and `maxActivePositions` up to 50 (see `api/routes/settingsSchema.ts`'s
 * old bounds) -- an authenticated API caller could silently blow past the
 * strategy's own documented risk limits. These ceilings are enforced in
 * TWO independent places (defense-in-depth, per explicit instruction not
 * to rely on API validation alone):
 *   1. `api/routes/settingsSchema.ts` -- rejects a PATCH that asks for
 *      more than the ceiling outright (400, never reaches the DB).
 *   2. `clampToHardCeilings` below -- called from
 *      `decideCapitalAllocation` itself, so even a value that somehow
 *      ended up in the DB above the ceiling (a legacy row from before
 *      this fix, a direct DB edit, a future bug in some OTHER caller of
 *      `SettingsRepository.update`) can never actually size a position
 *      beyond it. A value AT or BELOW the ceiling always passes through
 *      unchanged -- operators may still tighten these below the ceiling
 *      freely.
 */
export const CAPITAL_HARD_CEILINGS = {
  /** Fraction (0.35 = 35%) -- matches Draft V1 / TIER 3's position-size policy exactly. */
  MAX_POSITION_SIZE_PCT: 0.35,
  MAX_ACTIVE_POSITIONS: 3,
  /** Fraction (0.95 = 95%) -- the global exposure cap. */
  MAX_TOTAL_DEPLOYED_PCT: 0.95,
} as const;

/**
 * Clamps (never rejects the whole cycle -- a single malformed settings row
 * must not halt the bot) each ceiling-governed field DOWN to the hard
 * ceiling if it exceeds it. A value already at or below the ceiling is
 * returned unchanged -- this is a one-directional safety net, never a
 * floor, and never widens anything.
 */
export function clampToHardCeilings(rules: CapitalRules): CapitalRules {
  return {
    ...rules,
    POSITION_SIZE_PCT_OF_FREE_BALANCE: Math.min(rules.POSITION_SIZE_PCT_OF_FREE_BALANCE, CAPITAL_HARD_CEILINGS.MAX_POSITION_SIZE_PCT),
    MAX_ACTIVE_POSITIONS: Math.min(rules.MAX_ACTIVE_POSITIONS, CAPITAL_HARD_CEILINGS.MAX_ACTIVE_POSITIONS),
    MAX_TOTAL_DEPLOYED_PCT_OF_PORTFOLIO: Math.min(rules.MAX_TOTAL_DEPLOYED_PCT_OF_PORTFOLIO, CAPITAL_HARD_CEILINGS.MAX_TOTAL_DEPLOYED_PCT),
  };
}

/**
 * `true` iff `clampToHardCeilings` would actually change something --
 * lets callers (e.g. `screeningCycle.ts`) log a loud warning ONLY when a
 * real clamp happened, without duplicating the comparison logic or ever
 * risking the log and the clamp disagreeing.
 */
export function exceedsHardCeilings(rules: CapitalRules): boolean {
  return (
    rules.POSITION_SIZE_PCT_OF_FREE_BALANCE > CAPITAL_HARD_CEILINGS.MAX_POSITION_SIZE_PCT ||
    rules.MAX_ACTIVE_POSITIONS > CAPITAL_HARD_CEILINGS.MAX_ACTIVE_POSITIONS ||
    rules.MAX_TOTAL_DEPLOYED_PCT_OF_PORTFOLIO > CAPITAL_HARD_CEILINGS.MAX_TOTAL_DEPLOYED_PCT
  );
}
