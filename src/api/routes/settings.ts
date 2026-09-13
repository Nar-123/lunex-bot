import { Router } from 'express';
import { config } from '../../config';
import type { SettingsPatch } from '../../settings/types';
import type { AppDeps } from '../../composition/types';
import { settingsPatchSchema } from './settingsSchema';

/**
 * Shared by both handlers below -- the API boundary speaks percent for
 * every field (matching `PATCH /settings`'s request body convention and
 * `settingsPatchSchema`'s bounds); only the internal
 * `SettingsRepository`/DB representation is a fraction.
 *
 * TIER 3: `pnlProtectionTriggerPct` became `safetyExitTriggerPct` -- same
 * frozen -8% number, now the arming threshold of Meridian's Safety Exit
 * (`EXITS.SAFETY_EXIT.TRIGGER_PCT`) rather than of the superseded PNL
 * Protection. Still read-only and never settable via `PATCH`; it is
 * exposed so the settings UI can SHOW an operator the fixed threshold
 * their editable stop-loss sits next to, without hardcoding a second copy
 * of the number in browser code. It is no longer used for a client-side
 * cross-field check -- under the Meridian ladder the stop is deliberately
 * TIGHTER than this value (see `validateSettingsPatch`'s deletion note in
 * the Tier 3 report).
 */
function toSettingsResponse(s: { paused: boolean; positionSizePct: number; maxActivePositions: number; hardStopLossPct: number; trailingTpTriggerPct: number; updatedAt: Date }) {
  return {
    paused: s.paused,
    positionSizePct: s.positionSizePct * 100,
    maxActivePositions: s.maxActivePositions,
    hardStopLossPct: s.hardStopLossPct * 100,
    trailingTpTriggerPct: s.trailingTpTriggerPct * 100,
    safetyExitTriggerPct: config.rules.exits.SAFETY_EXIT.TRIGGER_PCT * 100,
    updatedAt: s.updatedAt,
  };
}

/**
 * `GET /settings` (Module 12) -- reuses the existing
 * `SettingsRepository.get()` (Module 10), zero new business logic. The
 * one thing Module 10 never built: a way to read current values before
 * an operator edits them via `PATCH`.
 *
 * `PATCH /settings` -- validated by `settingsPatchSchema` (static,
 * per-field percent-range bounds). A patch that fails it never reaches
 * `deps.settings.update()` -- the DB is never touched on a rejected PATCH.
 *
 * TIER 3 removed the second, cross-field layer (`validateSettingsPatch`),
 * which required `hardStopLossPct` to be at or below the -8% PNL
 * Protection threshold. The Meridian ladder inverts that relationship on
 * purpose -- the stop is -6%, TIGHTER than the -8% Safety Exit arming
 * point, and wins outright when both are true -- so the old rule would now
 * reject the system's own default. The policy it encoded no longer exists.
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

    const updated = await deps.settings.update(fractionPatch);
    res.status(200).json(toSettingsResponse(updated));
  });

  return router;
}
