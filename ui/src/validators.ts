/**
 * Client-side mirrors of `src/api/routes/settingsSchema.ts`'s per-field
 * percent bounds and `src/settings/validateSettingsPatch.ts`'s
 * `hardStopLossPct`-vs-PNL-Protection cross-check -- for instant form
 * feedback only. The server re-validates everything on every `PATCH`
 * regardless; these functions are never the actual source of truth.
 *
 * `pnlProtectionTriggerPct` is always a PARAMETER, never a hardcoded
 * constant here -- sourced from the same `GET /settings` response the
 * settings view already loads to populate the form (Decision 5, Module
 * 12), so this file structurally cannot drift from the server's real
 * frozen threshold the way a hardcoded copy could if that value were ever
 * revised. See README's Module 12 section for why a hardcoded copy was
 * rejected during review.
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

/**
 * Mirrors `validateSettingsPatch.ts`'s cross-field rule exactly:
 * `hardStopLossPct` must be <= `pnlProtectionTriggerPct` (equal or more
 * negative), otherwise Hard Stop Loss would always fire before PNL
 * Protection ever gets a chance to activate. Boundary-inclusive: exactly
 * equal to the threshold is valid.
 */
export function validateHardStopLossVsPnlProtection(hardStopLossPct: number, pnlProtectionTriggerPct: number): FieldValidation {
  if (hardStopLossPct > pnlProtectionTriggerPct) {
    return {
      valid: false,
      error: `Hard stop loss tidak boleh lebih longgar dari threshold PNL Protection saat ini (${pnlProtectionTriggerPct}%).`,
    };
  }
  return { valid: true };
}
