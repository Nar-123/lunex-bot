/**
 * Client-side mirrors of `src/api/routes/settingsSchema.ts`'s per-field
 * percent bounds -- for instant form feedback only. The server
 * re-validates everything on every `PATCH` regardless; these functions are
 * never the actual source of truth.
 *
 * TIER 3 removed the former `hardStopLossPct`-vs-PNL-Protection cross-field
 * rule (and its server-side original, `validateSettingsPatch.ts`) rather
 * than inverting it. That rule required the stop to sit at or below the
 * protection threshold; under the Meridian-aligned ladder the Hard Stop
 * Loss (-6%) is deliberately TIGHTER than the Safety Exit arming threshold
 * (-8%), and which one wins is decided by the exit ladder's fixed priority
 * order (stop first, always), not by their relative magnitudes. Keeping a
 * mirror of a rule the server no longer enforces would have meant the
 * browser rejecting the product's own default value.
 *
 * `safetyExitTriggerPct` is still surfaced by `GET /settings` and still
 * displayed read-only in the form, so the operator can see the threshold
 * they are setting the stop alongside -- it is just no longer a validation
 * input. Nothing here hardcodes it.
 */

export type FieldValidation = { valid: true } | { valid: false; error: string };

export function validatePositionSizePct(value: number): FieldValidation {
  if (!(value > 0) || !(value <= 100)) {
    return { valid: false, error: 'Position size harus lebih dari 0% dan maksimal 100%.' };
  }
  return { valid: true };
}

export function validateMaxActivePositions(value: number): FieldValidation {
  if (!Number.isInteger(value) || value < 1 || value > 50) {
    return { valid: false, error: 'Max active positions harus bilangan bulat antara 1 dan 50.' };
  }
  return { valid: true };
}

export function validateHardStopLossPct(value: number): FieldValidation {
  if (!(value >= -100) || !(value < 0)) {
    return { valid: false, error: 'Hard stop loss harus antara -100% dan kurang dari 0%.' };
  }
  return { valid: true };
}

export function validateTrailingTpTriggerPct(value: number): FieldValidation {
  if (!(value > 0) || !(value <= 1000)) {
    return { valid: false, error: 'Trailing TP trigger harus lebih dari 0% dan maksimal 1000%.' };
  }
  return { valid: true };
}
