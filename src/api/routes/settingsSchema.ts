import { z } from 'zod';
import { CAPITAL_HARD_CEILINGS } from '../../capital/hardCeilings';

const MAX_POSITION_SIZE_PCT = CAPITAL_HARD_CEILINGS.MAX_POSITION_SIZE_PCT * 100; // 35
const MAX_ACTIVE_POSITIONS_CEILING = CAPITAL_HARD_CEILINGS.MAX_ACTIVE_POSITIONS; // 3

/**
 * Static per-field validation for `PATCH /settings` -- percent-scale
 * bounds on the API boundary (fields are stored as fractions internally,
 * see `settings/types.ts`).
 *
 * P0-2 fix: `positionSizePct`/`maxActivePositions` are now capped at the
 * strategy's HARD SAFETY CEILING (`capital/hardCeilings.ts` --
 * `CAPITAL_HARD_CEILINGS`, 35% / 3 positions), not the previous 100% / 50
 * bounds -- an authenticated `PATCH /settings` caller could otherwise
 * silently size positions far beyond the documented Draft V1 / TIER 3
 * policy. Operators may still LOWER these freely (`gt(0)`/`gte(1)` is
 * still the floor) -- only raising past the ceiling is now rejected. This
 * is the FIRST of two independent enforcement layers -- see
 * `capital/decideCapitalAllocation.ts`'s `clampToHardCeilings` call for
 * the second, which protects even a value that somehow bypasses this
 * schema (a legacy DB row, a future bug in another caller).
 *
 * The one thing this schema CANNOT express -- `hardStopLossPct` no longer
 * needs cross-validation against Safety Exit's arming threshold under the
 * current (P0-3) precedence: Safety Exit governs any drawdown that reaches
 * its own trigger regardless of where `hardStopLossPct` sits -- see
 * `exits/resolveExitDecision.ts`'s doc comment.
 */
export const settingsPatchSchema = z
  .object({
    positionSizePct: z.number().gt(0).lte(MAX_POSITION_SIZE_PCT),
    maxActivePositions: z.number().int().gte(1).lte(MAX_ACTIVE_POSITIONS_CEILING),
    hardStopLossPct: z.number().gte(-100).lt(0),
    trailingTpTriggerPct: z.number().gt(0).lte(1000),
  })
  .partial()
  .strict()
  .refine((body) => Object.keys(body).length > 0, { message: 'at least one field is required' });

export type SettingsPatchBody = z.infer<typeof settingsPatchSchema>;
