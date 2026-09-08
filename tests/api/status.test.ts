import { describe, expect, it } from 'vitest';
import request from 'supertest';
import { buildTestApp, authHeader } from './testApp';
import { makeCreateInput } from '../positions/fixtures';

describe('GET /status', () => {
  it('reports free/deployed capital, per-status position counts, and paused state', async () => {
    const { app, deps } = buildTestApp();
    const created = await deps.positions.create(makeCreateInput({ tokenAddress: '0x0000000000000000000000000000000000000002' }));
    await deps.positions.markActive(created.id, '1', new Date());

    const res = await request(app).get('/status').set('Authorization', authHeader());

    expect(res.status).toBe(200);
    expect(res.body.paused).toBe(false);
    expect(res.body.positions.active).toBe(1);
    expect(res.body.positions.opening).toBe(0);
    expect(res.body.positions.closing).toBe(0);
    expect(typeof res.body.capital.freeUsdgBalance).toBe('string');
    expect(typeof res.body.capital.totalDeployedUsdg).toBe('string');
  });

  it('reflects paused: true after the bot has been paused', async () => {
    const { app, deps } = buildTestApp();
    await deps.settings.pause();

    const res = await request(app).get('/status').set('Authorization', authHeader());

    expect(res.body.paused).toBe(true);
  });
});
