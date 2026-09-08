import { describe, expect, it } from 'vitest';
import request from 'supertest';
import { buildTestApp, authHeader } from './testApp';
import { makeCreateInput } from '../positions/fixtures';

describe('GET /positions/stuck', () => {
  it('returns empty arrays when nothing is stuck', async () => {
    const { app } = buildTestApp();
    const res = await request(app).get('/positions/stuck').set('Authorization', authHeader());
    expect(res.status).toBe(200);
    expect(res.body.stuckTransactionAttempts).toEqual([]);
    expect(res.body.stuckSwapRetryPositionIds).toEqual([]);
  });

  it('surfaces a stuck TransactionAttempt (Module 6) via the existing isStuckAttempt/findNonTerminal primitives', async () => {
    const { app, deps } = buildTestApp();
    const attempt = await deps.txAttempts.create('deploy:stuck:1', 'test');
    await deps.txAttempts.update(attempt.id, {
      status: 'SENT',
      attemptCount: 10,
      firstAttemptedAt: new Date(Date.now() - 20 * 60 * 1000),
    });

    const res = await request(app).get('/positions/stuck').set('Authorization', authHeader());

    expect(res.body.stuckTransactionAttempts.map((a: { id: string }) => a.id)).toContain(attempt.id);
  });

  it('surfaces a stuck swap retry (Module 8) via the existing findStuckSwapRetries primitive', async () => {
    const { app, deps } = buildTestApp();
    const closing = await deps.positions.create(makeCreateInput({ tokenAddress: '0x0000000000000000000000000000000000000004' }));
    await deps.exitStates.update(closing.id, { swapAttemptCount: 5 });

    const res = await request(app).get('/positions/stuck').set('Authorization', authHeader());

    expect(res.body.stuckSwapRetryPositionIds).toContain(closing.id);
  });

  it('401s without a valid token', async () => {
    const { app } = buildTestApp();
    const res = await request(app).get('/positions/stuck');
    expect(res.status).toBe(401);
  });
});
