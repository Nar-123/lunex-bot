import { describe, expect, it, vi } from 'vitest';
import request from 'supertest';
import { buildTestApp, authHeader } from './testApp';

describe('GET /cooldowns', () => {
  it('returns an empty list when nothing is in cooldown', async () => {
    const { app } = buildTestApp();
    const res = await request(app).get('/cooldowns').set('Authorization', authHeader());
    expect(res.status).toBe(200);
    expect(res.body.cooldowns).toEqual([]);
  });

  it('lists every token currently in cooldown with its remaining time', async () => {
    const { app } = buildTestApp({
      cooldown: {
        getCooldownStatus: vi.fn(),
        recordExit: vi.fn(async () => undefined),
        findAllActive: vi.fn(async () => [{ tokenAddress: '0xabc', remainingMs: 3_600_000, cooldownEndsAt: Date.now() + 3_600_000 }]),
      },
    });

    const res = await request(app).get('/cooldowns').set('Authorization', authHeader());

    expect(res.body.cooldowns).toEqual([{ tokenAddress: '0xabc', remainingMs: 3_600_000, cooldownEndsAt: expect.any(Number) }]);
  });

  it('401s without a valid token', async () => {
    const { app } = buildTestApp();
    const res = await request(app).get('/cooldowns');
    expect(res.status).toBe(401);
  });
});
