import { z } from 'zod';

/**
 * Static per-field validation for `PATCH /settings` -- percent-scale
 * bounds on the API boundary (fields are stored as fractions internally,
 * see `settings/types.ts`). The one thing this schema CANNOT express --
 * `hardStopLossPct` cross-validated against the frozen PNL Protection
 * threshold -- is handled separately by
 * `settings/validateSettingsPatch.ts`, since that depends on a runtime
 * config value, not a fixed range.
 */
export const settingsPatchSchema = z
  .object({
    positionSizePct: z.number().gt(0).lte(100),
    maxActivePositions: z.number().int().gte(1).lte(50),
    hardStopLossPct: z.number().gte(-100).lt(0),
    trailingTpTriggerPct: z.number().gt(0).lte(1000),
  })
  .partial()
  .strict()
  .refine((body) => Object.keys(body).length > 0, { message: 'at least one field is required' });

export type SettingsPatchBody = z.infer<typeof settingsPatchSchema>;
