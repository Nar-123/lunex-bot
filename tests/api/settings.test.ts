import { describe, expect, it } from 'vitest';
import request from 'supertest';
import { buildTestApp, authHeader } from './testApp';

describe('PATCH /settings', () => {
  it('updates positionSizePct: request/response both speak percent (API boundary), storage is a fraction', async () => {
    const { app, deps } = buildTestApp();
    const res = await request(app).patch('/settings').set('Authorization', authHeader()).send({ positionSizePct: 10 });
    expect(res.status).toBe(200);
    expect(res.body.positionSizePct).toBeCloseTo(10); // response echoes percent, same convention as the request body
    expect((await deps.settings.get()).positionSizePct).toBeCloseTo(0.1); // internal storage stays a fraction
  });

  it('updates maxActivePositions as a plain integer (not a percent)', async () => {
    const { app, deps } = buildTestApp();
    // P0-2: 5 exceeds the new hard ceiling (3) -- 2 is a legal, below-default value that still proves the update took effect.
    const res = await request(app).patch('/settings').set('Authorization', authHeader()).send({ maxActivePositions: 2 });
    expect(res.status).toBe(200);
    expect(res.body.maxActivePositions).toBe(2);
    expect((await deps.settings.get()).maxActivePositions).toBe(2);
  });

  it('rejects an empty body', async () => {
    const { app } = buildTestApp();
    const res = await request(app).patch('/settings').set('Authorization', authHeader()).send({});
    expect(res.status).toBe(400);
  });

  it('rejects an unknown field', async () => {
    const { app } = buildTestApp();
    const res = await request(app).patch('/settings').set('Authorization', authHeader()).send({ notARealField: 1 });
    expect(res.status).toBe(400);
  });

  it('cannot set `paused` -- it is not a recognized field on this endpoint (control/pause+resume own it exclusively)', async () => {
    const { app, deps } = buildTestApp();
    const res = await request(app).patch('/settings').set('Authorization', authHeader()).send({ paused: true });
    expect(res.status).toBe(400);
    expect((await deps.settings.get()).paused).toBe(false);
  });

  it('rejects positionSizePct out of range (0-100)', async () => {
    const { app } = buildTestApp();
    const tooHigh = await request(app).patch('/settings').set('Authorization', authHeader()).send({ positionSizePct: 150 });
    expect(tooHigh.status).toBe(400);
    const zero = await request(app).patch('/settings').set('Authorization', authHeader()).send({ positionSizePct: 0 });
    expect(zero.status).toBe(400);
  });

  it('rejects maxActivePositions out of range or non-integer', async () => {
    const { app } = buildTestApp();
    const zero = await request(app).patch('/settings').set('Authorization', authHeader()).send({ maxActivePositions: 0 });
    expect(zero.status).toBe(400);
    const fractional = await request(app).patch('/settings').set('Authorization', authHeader()).send({ maxActivePositions: 2.5 });
    expect(fractional.status).toBe(400);
  });

  describe('P0-2: positionSizePct/maxActivePositions are HARD-CEILINGED at the strategy limit (35% / 3), never just the old wide 0-100% / 1-50 bounds', () => {
    it('PATCH positionSizePct=36 (just above the 35% ceiling) is rejected', async () => {
      const { app } = buildTestApp();
      const res = await request(app).patch('/settings').set('Authorization', authHeader()).send({ positionSizePct: 36 });
      expect(res.status).toBe(400);
    });

    it('PATCH positionSizePct=100 is rejected', async () => {
      const { app } = buildTestApp();
      const res = await request(app).patch('/settings').set('Authorization', authHeader()).send({ positionSizePct: 100 });
      expect(res.status).toBe(400);
    });

    it('PATCH maxActivePositions=4 (just above the ceiling of 3) is rejected', async () => {
      const { app } = buildTestApp();
      const res = await request(app).patch('/settings').set('Authorization', authHeader()).send({ maxActivePositions: 4 });
      expect(res.status).toBe(400);
    });

    it('PATCH maxActivePositions=50 is rejected', async () => {
      const { app } = buildTestApp();
      const res = await request(app).patch('/settings').set('Authorization', authHeader()).send({ maxActivePositions: 50 });
      expect(res.status).toBe(400);
    });

    it('PATCH positionSizePct=35 (exactly the ceiling) is accepted', async () => {
      const { app, deps } = buildTestApp();
      const res = await request(app).patch('/settings').set('Authorization', authHeader()).send({ positionSizePct: 35 });
      expect(res.status).toBe(200);
      expect(res.body.positionSizePct).toBeCloseTo(35);
      expect((await deps.settings.get()).positionSizePct).toBeCloseTo(0.35);
    });

    it('PATCH maxActivePositions=3 (exactly the ceiling) is accepted', async () => {
      const { app, deps } = buildTestApp();
      const res = await request(app).patch('/settings').set('Authorization', authHeader()).send({ maxActivePositions: 3 });
      expect(res.status).toBe(200);
      expect(res.body.maxActivePositions).toBe(3);
      expect((await deps.settings.get()).maxActivePositions).toBe(3);
    });

    it('lower values remain freely settable below the ceiling', async () => {
      const { app, deps } = buildTestApp();
      const sizeRes = await request(app).patch('/settings').set('Authorization', authHeader()).send({ positionSizePct: 5 });
      expect(sizeRes.status).toBe(200);
      const posRes = await request(app).patch('/settings').set('Authorization', authHeader()).send({ maxActivePositions: 1 });
      expect(posRes.status).toBe(200);
      const stored = await deps.settings.get();
      expect(stored.positionSizePct).toBeCloseTo(0.05);
      expect(stored.maxActivePositions).toBe(1);
    });
  });

  it('401s without a valid token', async () => {
    const { app } = buildTestApp();
    const res = await request(app).patch('/settings').send({ positionSizePct: 10 });
    expect(res.status).toBe(401);
  });

  /**
   * TIER 3 replaces Decision 3b's cross-field rule entirely. That rule
   * required `hardStopLossPct <= -8%`, on the premise that the stop had to
   * sit BELOW the (then) PNL-Protection arming threshold. Under the
   * Meridian-aligned ladder the stop is -6% and Safety Exit arms at -8%,
   * so the two deliberately sit the other way round: the stop is the
   * TIGHTER of the pair and fires FIRST (priority 1 vs priority 2), and
   * the old rule would now reject the product's own default value.
   *
   * The cross-field validator is therefore removed rather than inverted --
   * there is no longer any ordering constraint between the two numbers to
   * enforce, because the exit ladder's fixed priority order, not their
   * relative magnitudes, decides which one wins when both apply. The
   * per-field bounds in `settingsSchema.ts` remain the only validation,
   * and are re-asserted here so the field is still genuinely guarded.
   */
  describe('TIER 3: hardStopLossPct is bounded per-field only -- no cross-field ordering rule against the Safety Exit threshold', () => {
    it('accepts -5% (looser than the -8% Safety Exit arming threshold) -- legal now, and actually persisted', async () => {
      const { app, deps } = buildTestApp();
      const res = await request(app).patch('/settings').set('Authorization', authHeader()).send({ hardStopLossPct: -5 });

      expect(res.status).toBe(200);
      expect((await deps.settings.get()).hardStopLossPct).toBeCloseTo(-0.05);
    });

    it('accepts the product default -6% -- the value the OLD cross-field rule would have rejected outright', async () => {
      const { app, deps } = buildTestApp();
      const res = await request(app).patch('/settings').set('Authorization', authHeader()).send({ hardStopLossPct: -6 });
      expect(res.status).toBe(200);
      expect((await deps.settings.get()).hardStopLossPct).toBeCloseTo(-0.06);
    });

    it('accepts a value worse than -8% (e.g. -20%)', async () => {
      const { app, deps } = buildTestApp();
      const res = await request(app).patch('/settings').set('Authorization', authHeader()).send({ hardStopLossPct: -20 });
      expect(res.status).toBe(200);
      expect((await deps.settings.get()).hardStopLossPct).toBeCloseTo(-0.2);
    });

    it('still rejects a POSITIVE hardStopLossPct -- the per-field schema bound is intact, nothing was loosened wholesale', async () => {
      const { app, deps } = buildTestApp();
      const res = await request(app).patch('/settings').set('Authorization', authHeader()).send({ hardStopLossPct: 5 });
      expect(res.status).toBe(400);
      expect((await deps.settings.get()).hardStopLossPct).toBeCloseTo(-0.06); // unchanged DEFAULT_SETTINGS value
    });
  });
});

describe('GET /settings (Module 12)', () => {
  it('reads the current values (percent, API-boundary convention) including the frozen safetyExitTriggerPct', async () => {
    const { app } = buildTestApp();
    const res = await request(app).get('/settings').set('Authorization', authHeader());

    expect(res.status).toBe(200);
    expect(res.body.paused).toBe(false);
    expect(res.body.positionSizePct).toBeCloseTo(35); // DEFAULT_SETTINGS, as percent
    expect(res.body.maxActivePositions).toBe(3);
    // TIER 3 (Meridian-aligned) defaults, replacing -15% / +5%.
    expect(res.body.hardStopLossPct).toBeCloseTo(-6);
    expect(res.body.trailingTpTriggerPct).toBeCloseTo(6);
    // Renamed from pnlProtectionTriggerPct: still read-only and frozen
    // server-side, not settable via PATCH.
    expect(res.body.safetyExitTriggerPct).toBeCloseTo(-8);
  });

  it('reflects a value already changed via PATCH', async () => {
    const { app } = buildTestApp();
    // P0-2: 7 exceeds the new hard ceiling (3) -- 2 is a legal, below-default value.
    await request(app).patch('/settings').set('Authorization', authHeader()).send({ maxActivePositions: 2 });

    const res = await request(app).get('/settings').set('Authorization', authHeader());

    expect(res.body.maxActivePositions).toBe(2);
  });

  it('401s without a valid token', async () => {
    const { app } = buildTestApp();
    const res = await request(app).get('/settings');
    expect(res.status).toBe(401);
  });
});
