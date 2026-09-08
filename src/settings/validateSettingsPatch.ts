import type { SettingsPatch } from './types';

export type ValidateSettingsPatchResult = { ok: true } | { ok: false; reason: string };

/**
 * Pure function (no I/O): the one cross-field business-rule check that a
 * static per-field schema (see `api/routes/settingsSchema.ts`) can't
 * express, because it depends on a runtime config value rather than a
 * fixed range.
 *
 * `hardStopLossPct` must never be set looser (less negative) than the
 * frozen `EXITS.PNL_PROTECTION.TRIGGER_PNL_PCT` (-8%) -- otherwise Hard
 * Stop Loss would always fire before PNL Protection ever got a chance to
 * activate, silently defeating a mechanism Module 8 was built around.
 * `-15%` is valid (worse than -8%, so PNL Protection activates first);
 * `-5%` is rejected (looser than -8%, so HARD_STOP_LOSS always wins);
 * `-8%` exactly is valid (inclusive boundary -- PNL Protection and Hard
 * Stop Loss would activate at the same PNL, which is still "PNL
 * Protection gets its chance," not defeated).
 *
 * Only checked when `patch.hardStopLossPct` is actually present -- a PATCH
 * that doesn't touch this field has nothing to validate here.
 */
export function validateSettingsPatch(patch: SettingsPatch, pnlProtectionTriggerPct: number): ValidateSettingsPatchResult {
  if (patch.hardStopLossPct !== undefined && patch.hardStopLossPct > pnlProtectionTriggerPct) {
    return {
      ok: false,
      reason:
        `hardStopLossPct tidak boleh lebih longgar dari threshold PNL Protection saat ini ` +
        `(${(pnlProtectionTriggerPct * 100).toFixed(0)}%): got ${(patch.hardStopLossPct * 100).toFixed(2)}%, ` +
        `must be <= ${(pnlProtectionTriggerPct * 100).toFixed(0)}% (i.e. equal or more negative).`,
    };
  }
  return { ok: true };
}
