import { describe, expect, it, beforeAll } from 'vitest';
import bcrypt from 'bcrypt';
import request from 'supertest';
import jwt from 'jsonwebtoken';
import { config } from '../../src/config';
import { buildTestApp } from './testApp';

const REAL_PASSWORD = 'correct-horse-battery-staple';

describe('POST /auth/login + JWT middleware', () => {
  beforeAll(() => {
    // tests/setup.ts's fixture AUTH_ADMIN_PASSWORD_HASH is shape-valid but
    // not a genuine hash of any real password (needed only to satisfy
    // env.ts's zod validation at import time) -- replaced here with a real
    // bcrypt hash of a KNOWN password so the success path is testable.
    // `config` is a module-level singleton, not runtime-frozen (`as const`
    // is TS-only), and vitest isolates modules per test file by default,
    // so this mutation never leaks into other test files.
    (config.auth as { adminPasswordHash: string }).adminPasswordHash = bcrypt.hashSync(REAL_PASSWORD, 4);
  });

  it('rejects a missing body', async () => {
    const { app } = buildTestApp();
    const res = await request(app).post('/auth/login').send({});
    expect(res.status).toBe(400);
  });

  it('rejects a wrong username', async () => {
    const { app } = buildTestApp();
    const res = await request(app).post('/auth/login').send({ username: 'not-the-admin', password: REAL_PASSWORD });
    expect(res.status).toBe(401);
  });

  it('rejects a wrong password', async () => {
    const { app } = buildTestApp();
    const res = await request(app).post('/auth/login').send({ username: config.auth.adminUsername, password: 'wrong-password' });
    expect(res.status).toBe(401);
  });

  it('accepts correct credentials and returns a usable JWT', async () => {
    const { app } = buildTestApp();
    const res = await request(app).post('/auth/login').send({ username: config.auth.adminUsername, password: REAL_PASSWORD });
    expect(res.status).toBe(200);
    expect(typeof res.body.token).toBe('string');

    const protectedRes = await request(app).get('/status').set('Authorization', `Bearer ${res.body.token}`);
    expect(protectedRes.status).toBe(200);
  });

  describe('every protected endpoint requires a valid JWT', () => {
    it('401s with no Authorization header at all', async () => {
      const { app } = buildTestApp();
      const res = await request(app).get('/status');
      expect(res.status).toBe(401);
    });

    it('401s with a malformed header (no Bearer prefix)', async () => {
      const { app } = buildTestApp();
      const res = await request(app).get('/status').set('Authorization', 'not-a-bearer-token');
      expect(res.status).toBe(401);
    });

    it('401s with a syntactically invalid token', async () => {
      const { app } = buildTestApp();
      const res = await request(app).get('/status').set('Authorization', 'Bearer not.a.real.jwt');
      expect(res.status).toBe(401);
    });

    it('401s with an expired token', async () => {
      const { app } = buildTestApp();
      const expired = jwt.sign({ sub: config.auth.adminUsername }, config.auth.jwtSecret, { expiresIn: -10 });
      const res = await request(app).get('/status').set('Authorization', `Bearer ${expired}`);
      expect(res.status).toBe(401);
    });

    it('401s with a token signed by the wrong secret', async () => {
      const { app } = buildTestApp();
      const wrongSecret = jwt.sign({ sub: config.auth.adminUsername }, 'a-completely-different-secret-value');
      const res = await request(app).get('/status').set('Authorization', `Bearer ${wrongSecret}`);
      expect(res.status).toBe(401);
    });
  });

  describe('login rate limiting -- only FAILED attempts count', () => {
    it('locks out after maxAttempts consecutive failures, even with correct credentials on the next try, then resets after the window', async () => {
      const { app } = buildTestApp(); // testApp.ts configures windowMs: 200, maxAttempts: 3

      for (let i = 0; i < 3; i++) {
        const res = await request(app).post('/auth/login').send({ username: config.auth.adminUsername, password: 'wrong' });
        expect(res.status).toBe(401);
      }

      const lockedOut = await request(app).post('/auth/login').send({ username: config.auth.adminUsername, password: REAL_PASSWORD });
      expect(lockedOut.status).toBe(429);

      await new Promise((resolve) => setTimeout(resolve, 250)); // past the 200ms test window

      const afterReset = await request(app).post('/auth/login').send({ username: config.auth.adminUsername, password: REAL_PASSWORD });
      expect(afterReset.status).toBe(200);
    });

    it('a successful login does NOT count toward the failure limit', async () => {
      const { app } = buildTestApp();

      for (let i = 0; i < 5; i++) {
        const res = await request(app).post('/auth/login').send({ username: config.auth.adminUsername, password: REAL_PASSWORD });
        expect(res.status).toBe(200);
      }
    });
  });
});
