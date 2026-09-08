import { describe, expect, it } from 'vitest';
import { validateSettingsPatch } from '../../src/settings/validateSettingsPatch';

const PNL_PROTECTION_TRIGGER = -0.08; // -8%, matches EXITS.PNL_PROTECTION.TRIGGER_PNL_PCT

describe('validateSettingsPatch -- Decision 3b: hardStopLossPct vs frozen PNL Protection threshold', () => {
  it('rejects a hardStopLossPct looser than -8% (would always fire before PNL Protection gets a chance)', () => {
    const result = validateSettingsPatch({ hardStopLossPct: -0.05 }, PNL_PROTECTION_TRIGGER);
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.reason).toMatch(/hardStopLossPct/);
      expect(result.reason).toMatch(/PNL Protection/);
    }
  });

  it('accepts a hardStopLossPct worse (more negative) than -8%', () => {
    expect(validateSettingsPatch({ hardStopLossPct: -0.15 }, PNL_PROTECTION_TRIGGER)).toEqual({ ok: true });
  });

  it('accepts the exact boundary value, -8% (inclusive)', () => {
    expect(validateSettingsPatch({ hardStopLossPct: -0.08 }, PNL_PROTECTION_TRIGGER)).toEqual({ ok: true });
  });

  it('does not validate hardStopLossPct at all when the patch does not touch it', () => {
    expect(validateSettingsPatch({ positionSizePct: 0.5 }, PNL_PROTECTION_TRIGGER)).toEqual({ ok: true });
  });

  it('is unaffected by other fields in the same patch', () => {
    const result = validateSettingsPatch({ hardStopLossPct: -0.05, positionSizePct: 0.2, maxActivePositions: 5 }, PNL_PROTECTION_TRIGGER);
    expect(result.ok).toBe(false);
  });
});
