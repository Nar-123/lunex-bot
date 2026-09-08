import { describe, expect, it } from 'vitest';
import request from 'supertest';
import { buildTestApp, authHeader } from './testApp';
import { makeCreateInput } from '../positions/fixtures';

describe('GET /positions', () => {
  it('returns an empty list when nothing is ACTIVE', async () => {
    const { app } = buildTestApp();
    const res = await request(app).get('/positions').set('Authorization', authHeader());
    expect(res.status).toBe(200);
    expect(res.body.positions).toEqual([]);
  });

  it('returns price/PNL/fee/yield/range metrics and OOR status for each ACTIVE position', async () => {
    const { app, deps } = buildTestApp();
    const created = await deps.positions.create(makeCreateInput({ tokenAddress: '0x0000000000000000000000000000000000000002' }));
    await deps.positions.markActive(created.id, '1', new Date());

    const res = await request(app).get('/positions').set('Authorization', authHeader());

    expect(res.status).toBe(200);
    expect(res.body.positions).toHaveLength(1);
    const position = res.body.positions[0];
    expect(position.id).toBe(created.id);
    expect(position.metrics.ok).toBe(true);
    expect(typeof position.metrics.pnlPct).toBe('number');
    expect(typeof position.metrics.yieldPct).toBe('number');
    expect(typeof position.metrics.feesEarnedUsdgRaw).toBe('string');
    expect(typeof position.metrics.inRange).toBe('boolean');
    expect(position.oor.outOfRange).toBe(false);
  });

  it('reports OOR status once the exit state has an oorStartedAt', async () => {
    const { app, deps } = buildTestApp();
    const created = await deps.positions.create(makeCreateInput({ tokenAddress: '0x0000000000000000000000000000000000000002' }));
    await deps.positions.markActive(created.id, '1', new Date());
    await deps.exitStates.update(created.id, { oorStartedAt: new Date(Date.now() - 5 * 60 * 1000) });

    const res = await request(app).get('/positions').set('Authorization', authHeader());

    const position = res.body.positions[0];
    expect(position.oor.outOfRange).toBe(true);
    expect(position.oor.elapsedMs).toBeGreaterThan(0);
  });
});

describe('GET /positions?status=closed (Module 11)', () => {
  it('returns the scoped-down shape for a CLOSED position -- no PNL/fee numbers, honestly flagged as unavailable', async () => {
    const { app, deps } = buildTestApp();
    const created = await deps.positions.create(makeCreateInput({ tokenAddress: '0x0000000000000000000000000000000000000002' }));
    await deps.positions.markActive(created.id, '1', new Date());
    await deps.positions.markClosed(created.id, new Date(), 'HARD_STOP_LOSS');

    const res = await request(app).get('/positions?status=closed').set('Authorization', authHeader());

    expect(res.status).toBe(200);
    expect(res.body.positions).toHaveLength(1);
    const position = res.body.positions[0];
    expect(position.id).toBe(created.id);
    expect(position.closeReason).toBe('HARD_STOP_LOSS');
    expect(position.realizedPnlAvailable).toBe(false);
    expect(position.metrics).toBeUndefined(); // no computePositionMetrics call for a closed position
  });

  it('excludes ACTIVE positions from the closed listing', async () => {
    const { app, deps } = buildTestApp();
    const active = await deps.positions.create(makeCreateInput({ tokenAddress: '0x0000000000000000000000000000000000000003' }));
    await deps.positions.markActive(active.id, '1', new Date());
    const closed = await deps.positions.create(makeCreateInput({ tokenAddress: '0x0000000000000000000000000000000000000004' }));
    await deps.positions.markActive(closed.id, '2', new Date());
    await deps.positions.markClosed(closed.id, new Date(), 'TRAILING_TP');

    const res = await request(app).get('/positions?status=closed').set('Authorization', authHeader());

    expect(res.body.positions).toHaveLength(1);
    expect(res.body.positions[0].id).toBe(closed.id);
  });

  it('401s without a valid token', async () => {
    const { app } = buildTestApp();
    const res = await request(app).get('/positions?status=closed');
    expect(res.status).toBe(401);
  });
});
