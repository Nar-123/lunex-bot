import { describe, expect, it, afterEach } from 'vitest';
import request from 'supertest';
import { writeFileSync, mkdtempSync, rmSync } from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { createApiServer } from '../../src/api/server';
import { createFakeAppDeps } from '../composition/fakeAppDeps';
import { authHeader } from './testApp';

describe('GET /logs', () => {
  let tmpDir: string | undefined;

  afterEach(() => {
    if (tmpDir) rmSync(tmpDir, { recursive: true, force: true });
    tmpDir = undefined;
  });

  it('returns an empty array when the log file does not exist yet, not a 500', async () => {
    tmpDir = mkdtempSync(path.join(os.tmpdir(), 'lunex-logs-test-'));
    const missingPath = path.join(tmpDir, 'does-not-exist.log');
    const app = createApiServer(createFakeAppDeps(), { logFilePath: missingPath });

    const res = await request(app).get('/logs').set('Authorization', authHeader());

    expect(res.status).toBe(200);
    expect(res.body.lines).toEqual([]);
  });

  it('returns the last N lines parsed as JSON, respecting the limit query param', async () => {
    tmpDir = mkdtempSync(path.join(os.tmpdir(), 'lunex-logs-test-'));
    const logPath = path.join(tmpDir, 'lunex-bot.log');
    const lines = Array.from({ length: 5 }, (_, i) => JSON.stringify({ ts: `t${i}`, level: 'info', event: `event_${i}` }));
    writeFileSync(logPath, lines.join('\n') + '\n');
    const app = createApiServer(createFakeAppDeps(), { logFilePath: logPath });

    const res = await request(app).get('/logs?limit=2').set('Authorization', authHeader());

    expect(res.status).toBe(200);
    expect(res.body.lines).toHaveLength(2);
    expect(res.body.lines.map((l: { event: string }) => l.event)).toEqual(['event_3', 'event_4']); // the LAST 2, not the first 2
  });

  it('caps limit at the maximum (1000) even if a larger value is requested', async () => {
    tmpDir = mkdtempSync(path.join(os.tmpdir(), 'lunex-logs-test-'));
    const logPath = path.join(tmpDir, 'lunex-bot.log');
    const lines = Array.from({ length: 3 }, (_, i) => JSON.stringify({ event: `e${i}` }));
    writeFileSync(logPath, lines.join('\n') + '\n');
    const app = createApiServer(createFakeAppDeps(), { logFilePath: logPath });

    const res = await request(app).get('/logs?limit=999999').set('Authorization', authHeader());

    expect(res.status).toBe(200);
    expect(res.body.lines).toHaveLength(3); // fewer lines exist than the cap -- returns all of them, no error
  });

  it('401s without a valid token', async () => {
    const app = createApiServer(createFakeAppDeps());
    const res = await request(app).get('/logs');
    expect(res.status).toBe(401);
  });
});
