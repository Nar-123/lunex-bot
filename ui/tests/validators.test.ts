import { describe, expect, it } from 'vitest';
import {
  validatePositionSizePct,
  validateMaxActivePositions,
  validateHardStopLossPct,
  validateTrailingTpTriggerPct,
  validateHardStopLossVsPnlProtection,
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

describe('validateHardStopLossVsPnlProtection -- mirrors validateSettingsPatch.ts, threshold ALWAYS a parameter, never hardcoded', () => {
  it('rejects a value looser than the given threshold', () => {
    const result = validateHardStopLossVsPnlProtection(-5, -8);
    expect(result.valid).toBe(false);
  });

  it('accepts a value worse (more negative) than the given threshold', () => {
    expect(validateHardStopLossVsPnlProtection(-20, -8).valid).toBe(true);
  });

  it('accepts the exact boundary, inclusive', () => {
    expect(validateHardStopLossVsPnlProtection(-8, -8).valid).toBe(true);
  });

  it('genuinely uses whatever threshold it is given, not a baked-in -8% -- proven with a DIFFERENT threshold value', () => {
    // If this were hardcoded to -8 internally, this test (threshold -12)
    // would give the wrong answer for -10.
    expect(validateHardStopLossVsPnlProtection(-10, -12).valid).toBe(false); // -10 is looser than -12
    expect(validateHardStopLossVsPnlProtection(-15, -12).valid).toBe(true); // -15 is worse than -12
    expect(validateHardStopLossVsPnlProtection(-12, -12).valid).toBe(true); // exact boundary at the DIFFERENT threshold
  });
});
