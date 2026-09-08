import { describe, expect, it } from 'vitest';
import request from 'supertest';
import { buildTestApp, authHeader } from './testApp';

describe('POST /control/pause + /control/resume', () => {
  it('pause flips paused to true, persisted', async () => {
    const { app, deps } = buildTestApp();
    const res = await request(app).post('/control/pause').set('Authorization', authHeader());
    expect(res.status).toBe(200);
    expect(res.body.paused).toBe(true);
    expect((await deps.settings.get()).paused).toBe(true);
  });

  it('resume flips paused back to false, persisted', async () => {
    const { app, deps } = buildTestApp();
    await deps.settings.pause();

    const res = await request(app).post('/control/resume').set('Authorization', authHeader());

    expect(res.status).toBe(200);
    expect(res.body.paused).toBe(false);
    expect((await deps.settings.get()).paused).toBe(false);
  });

  it('401s without a valid token', async () => {
    const { app } = buildTestApp();
    const res = await request(app).post('/control/pause');
    expect(res.status).toBe(401);
  });
});
