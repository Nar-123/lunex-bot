import { Router } from 'express';
import { config } from '../../config';
import type { SettingsPatch } from '../../settings/types';
import { validateSettingsPatch } from '../../settings/validateSettingsPatch';
import type { AppDeps } from '../../composition/types';
import { settingsPatchSchema } from './settingsSchema';

/**
 * Shared by both handlers below -- the API boundary speaks percent for
 * every field (matching `PATCH /settings`'s request body convention,
 * `settingsPatchSchema`'s bounds, and `validateSettingsPatch`'s error
 * messages, which already all speak in percent, e.g. "(-8%)"); only the
 * internal `SettingsRepository`/DB representation is a fraction. Also
 * carries the frozen `pnlProtectionTriggerPct` (Decision 5, Module 12) --
 * read-only, never settable via `PATCH`, exposed specifically so
 * `ui/validators.ts`'s client-side mirror of the `hardStopLossPct`
 * cross-check reads it from this response instead of hardcoding a second
 * copy of the number (see README's Module 12 section for why a hardcoded
 * copy was rejected during review).
 */
function toSettingsResponse(s: { paused: boolean; positionSizePct: number; maxActivePositions: number; hardStopLossPct: number; trailingTpTriggerPct: number; updatedAt: Date }) {
  return {
    paused: s.paused,
    positionSizePct: s.positionSizePct * 100,
    maxActivePositions: s.maxActivePositions,
    hardStopLossPct: s.hardStopLossPct * 100,
    trailingTpTriggerPct: s.trailingTpTriggerPct * 100,
    pnlProtectionTriggerPct: config.rules.exits.PNL_PROTECTION.TRIGGER_PNL_PCT * 100,
    updatedAt: s.updatedAt,
  };
}

/**
 * `GET /settings` (Module 12) -- reuses the existing
 * `SettingsRepository.get()` (Module 10), zero new business logic. The
 * one thing Module 10 never built: a way to read current values before
 * an operator edits them via `PATCH`.
 *
 * `PATCH /settings` -- validates the request body in two layers:
 *  1. `settingsPatchSchema` (static, per-field percent-range bounds).
 *  2. `validateSettingsPatch` (the one cross-field rule a static schema
 *     can't express: `hardStopLossPct` vs the frozen PNL Protection
 *     activation threshold -- Decision 3b, see that file's doc comment).
 * A patch that fails either layer never reaches `deps.settings.update()`
 * -- the DB is never touched on a rejected PATCH.
 */
export function createSettingsRouter(deps: AppDeps): Router {
  const router = Router();

  router.get('/', async (_req, res) => {
    const current = await deps.settings.get();
    res.status(200).json(toSettingsResponse(current));
  });

  router.patch('/', async (req, res) => {
    const parsed = settingsPatchSchema.safeParse(req.body);
    if (!parsed.success) {
      res.status(400).json({ error: parsed.error.issues.map((i) => `${i.path.join('.')}: ${i.message}`).join('; ') });
      return;
    }

    const fractionPatch: SettingsPatch = {};
    if (parsed.data.positionSizePct !== undefined) fractionPatch.positionSizePct = parsed.data.positionSizePct / 100;
    if (parsed.data.maxActivePositions !== undefined) fractionPatch.maxActivePositions = parsed.data.maxActivePositions;
    if (parsed.data.hardStopLossPct !== undefined) fractionPatch.hardStopLossPct = parsed.data.hardStopLossPct / 100;
    if (parsed.data.trailingTpTriggerPct !== undefined) fractionPatch.trailingTpTriggerPct = parsed.data.trailingTpTriggerPct / 100;

    const crossFieldCheck = validateSettingsPatch(fractionPatch, config.rules.exits.PNL_PROTECTION.TRIGGER_PNL_PCT);
    if (!crossFieldCheck.ok) {
      res.status(400).json({ error: crossFieldCheck.reason });
      return;
    }

    const updated = await deps.settings.update(fractionPatch);
    res.status(200).json(toSettingsResponse(updated));
  });

  return router;
}
