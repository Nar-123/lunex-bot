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
    const res = await request(app).patch('/settings').set('Authorization', authHeader()).send({ maxActivePositions: 5 });
    expect(res.status).toBe(200);
    expect(res.body.maxActivePositions).toBe(5);
    expect((await deps.settings.get()).maxActivePositions).toBe(5);
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

  it('401s without a valid token', async () => {
    const { app } = buildTestApp();
    const res = await request(app).patch('/settings').send({ positionSizePct: 10 });
    expect(res.status).toBe(401);
  });

  describe('Decision 3b: hardStopLossPct cross-validated against the frozen PNL Protection threshold (-8%)', () => {
    it('rejects a value looser than -8% (e.g. -5%), with an explicit message, and never touches the DB', async () => {
      const { app, deps } = buildTestApp();
      const res = await request(app).patch('/settings').set('Authorization', authHeader()).send({ hardStopLossPct: -5 });

      expect(res.status).toBe(400);
      expect(res.body.error).toMatch(/hardStopLossPct/);
      expect(res.body.error).toMatch(/PNL Protection/);
      expect((await deps.settings.get()).hardStopLossPct).toBeCloseTo(-0.15); // unchanged, still the DEFAULT_SETTINGS value
    });

    it('accepts a value worse than -8% (e.g. -20%)', async () => {
      const { app, deps } = buildTestApp();
      const res = await request(app).patch('/settings').set('Authorization', authHeader()).send({ hardStopLossPct: -20 });
      expect(res.status).toBe(200);
      expect((await deps.settings.get()).hardStopLossPct).toBeCloseTo(-0.2);
    });

    it('accepts the exact boundary, -8%, inclusive', async () => {
      const { app, deps } = buildTestApp();
      const res = await request(app).patch('/settings').set('Authorization', authHeader()).send({ hardStopLossPct: -8 });
      expect(res.status).toBe(200);
      expect((await deps.settings.get()).hardStopLossPct).toBeCloseTo(-0.08);
    });
  });
});

describe('GET /settings (Module 12)', () => {
  it('reads the current values (percent, API-boundary convention) including the frozen pnlProtectionTriggerPct', async () => {
    const { app } = buildTestApp();
    const res = await request(app).get('/settings').set('Authorization', authHeader());

    expect(res.status).toBe(200);
    expect(res.body.paused).toBe(false);
    expect(res.body.positionSizePct).toBeCloseTo(35); // DEFAULT_SETTINGS, as percent
    expect(res.body.maxActivePositions).toBe(3);
    expect(res.body.hardStopLossPct).toBeCloseTo(-15);
    expect(res.body.trailingTpTriggerPct).toBeCloseTo(5);
    expect(res.body.pnlProtectionTriggerPct).toBeCloseTo(-8); // read-only, frozen server threshold, not settable via PATCH
  });

  it('reflects a value already changed via PATCH', async () => {
    const { app } = buildTestApp();
    await request(app).patch('/settings').set('Authorization', authHeader()).send({ maxActivePositions: 7 });

    const res = await request(app).get('/settings').set('Authorization', authHeader());

    expect(res.body.maxActivePositions).toBe(7);
  });

  it('401s without a valid token', async () => {
    const { app } = buildTestApp();
    const res = await request(app).get('/settings');
    expect(res.status).toBe(401);
  });
});
