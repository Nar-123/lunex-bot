import { describe, expect, it } from 'vitest';
import {
  validatePositionSizePct,
  validateMaxActivePositions,
  validateHardStopLossPct,
  validateTrailingTpTriggerPct,
} from '../src/validators';

// Mirrors src/api/routes/settingsSchema.ts's bounds EXACTLY -- every
// boundary value tested here must agree with that file's zod schema.
describe('validatePositionSizePct -- mirrors settingsSchema.ts: gt(0).lte(100)', () => {
  it('rejects 0 (must be strictly greater)', () => expect(validatePositionSizePct(0).valid).toBe(false));
  it('accepts a value just above 0', () => expect(validatePositionSizePct(0.01).valid).toBe(true));
  it('accepts exactly 100 (inclusive)', () => expect(validatePositionSizePct(100).valid).toBe(true));
  it('rejects above 100', () => expect(validatePositionSizePct(100.01).valid).toBe(false));
});

describe('validateMaxActivePositions -- mirrors settingsSchema.ts: int gte(1).lte(50)', () => {
  it('rejects 0', () => expect(validateMaxActivePositions(0).valid).toBe(false));
  it('accepts exactly 1 (inclusive)', () => expect(validateMaxActivePositions(1).valid).toBe(true));
  it('accepts exactly 50 (inclusive)', () => expect(validateMaxActivePositions(50).valid).toBe(true));
  it('rejects 51', () => expect(validateMaxActivePositions(51).valid).toBe(false));
  it('rejects a non-integer', () => expect(validateMaxActivePositions(2.5).valid).toBe(false));
});

describe('validateHardStopLossPct -- mirrors settingsSchema.ts: gte(-100).lt(0)', () => {
  it('accepts exactly -100 (inclusive)', () => expect(validateHardStopLossPct(-100).valid).toBe(true));
  it('rejects below -100', () => expect(validateHardStopLossPct(-100.01).valid).toBe(false));
  it('rejects exactly 0 (must be strictly negative)', () => expect(validateHardStopLossPct(0).valid).toBe(false));
  it('accepts a small negative value', () => expect(validateHardStopLossPct(-0.01).valid).toBe(true));
});

describe('validateTrailingTpTriggerPct -- mirrors settingsSchema.ts: gt(0).lte(1000)', () => {
  it('rejects 0', () => expect(validateTrailingTpTriggerPct(0).valid).toBe(false));
  it('accepts a value just above 0', () => expect(validateTrailingTpTriggerPct(0.01).valid).toBe(true));
  it('accepts exactly 1000 (inclusive)', () => expect(validateTrailingTpTriggerPct(1000).valid).toBe(true));
  it('rejects above 1000', () => expect(validateTrailingTpTriggerPct(1000.01).valid).toBe(false));
});

/**
 * TIER 3: the `validateHardStopLossVsPnlProtection` suite that used to sit
 * here is GONE along with the function and its server-side original
 * (`validateSettingsPatch.ts`). The rule required the stop to be at or
 * below the protection threshold; the Meridian-aligned ladder makes the
 * Hard Stop Loss (-6%) deliberately TIGHTER than the Safety Exit arming
 * threshold (-8%), with the ladder's fixed priority order -- not their
 * relative magnitudes -- deciding which fires. Mirroring a rule that no
 * longer exists would have had the browser reject the product default.
 *
 * The per-field bounds above are unchanged and still mirror
 * `settingsSchema.ts` exactly, which remains the real validation.
 */
describe('TIER 3: no cross-field stop-loss rule is exported any more', () => {
  it('the per-field hard-stop bound alone accepts -6% (the product default) and -5% (looser than the -8% Safety Exit threshold)', () => {
    expect(validateHardStopLossPct(-6).valid).toBe(true);
    expect(validateHardStopLossPct(-5).valid).toBe(true);
  });

  it('and still rejects a positive or zero stop -- nothing was loosened beyond removing the cross-field rule', () => {
    expect(validateHardStopLossPct(0).valid).toBe(false);
    expect(validateHardStopLossPct(5).valid).toBe(false);
  });
});
