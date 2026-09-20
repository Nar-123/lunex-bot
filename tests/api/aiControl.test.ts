import { describe, expect, it } from 'vitest';
import request from 'supertest';
import { createHash } from 'node:crypto';
import { createApiServer } from '../../src/api/server';
import type { AiControlOptions } from '../../src/api/routes/aiControl';
import type { createInMemoryLogger } from '../../src/composition/logger';
import type { AppDeps } from '../../src/composition/types';
import { createFakeAppDeps } from '../composition/fakeAppDeps';
import { authHeader } from './testApp';

const AI_TOKEN = 'test-ai-supervisor-token-0123456789abcdef';
const AI_TOKEN_SHA256 = createHash('sha256').update(AI_TOKEN).digest('hex');
const AI = { 'X-AI-Supervisor-Token': AI_TOKEN };

function build(aiControl: Partial<AiControlOptions> = {}) {
  const deps = createFakeAppDeps();
  // supertest connects over loopback, so the default raw-socket check is exercised for real unless overridden
  const app = createApiServer(deps, { aiControl: { tokenSha256: AI_TOKEN_SHA256, ...aiControl } });
  return { app, deps };
}

function lines(deps: AppDeps) {
  return (deps.logger as ReturnType<typeof createInMemoryLogger>).lines;
}

describe('AI Supervisor entry control API', () => {
  it('1. AI pause succeeds -- flag set, audit event emitted, operator pause untouched', async () => {
    const { app, deps } = build();
    const res = await request(app).post('/internal/ai/pause-entry').set(AI).set('X-Request-Id', 'req-pause-1');

    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({
      action: 'pause-entry',
      event: 'AI_ENTRY_PAUSED',
      changed: true,
      previousState: { entryPaused: false, aiEntryPaused: false, operatorPaused: false },
      newState: { entryPaused: true, aiEntryPaused: true, operatorPaused: false, aiEntryRequestId: 'req-pause-1' },
      requestId: 'req-pause-1',
    });
    expect(res.headers['x-request-id']).toBe('req-pause-1');
    const s = await deps.settings.get();
    expect(s.aiEntryPaused).toBe(true);
    expect(s.paused).toBe(false);

    const audit = lines(deps).find((l) => l.event === 'AI_ENTRY_PAUSED');
    expect(audit?.data).toMatchObject({
      action: 'pause-entry',
      actor: 'ai-supervisor',
      previousState: { entryPaused: false, aiEntryPaused: false, operatorPaused: false },
      newState: { entryPaused: true, aiEntryPaused: true, operatorPaused: false },
      requestId: 'req-pause-1',
    });
    expect(typeof audit?.data.timestamp).toBe('string');
  });

  it('2. AI resume succeeds', async () => {
    const { app, deps } = build();
    await request(app).post('/internal/ai/pause-entry').set(AI);
    const res = await request(app).post('/internal/ai/resume-entry').set(AI).set('X-Request-Id', 'req-resume-1');

    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({
      event: 'AI_ENTRY_RESUMED',
      changed: true,
      previousState: { aiEntryPaused: true, entryPaused: true },
      newState: { aiEntryPaused: false, entryPaused: false },
    });
    expect(res.body.note).toBeUndefined();
    expect((await deps.settings.get()).aiEntryPaused).toBe(false);
    expect(lines(deps).find((l) => l.event === 'AI_ENTRY_RESUMED')?.data).toMatchObject({ actor: 'ai-supervisor', requestId: 'req-resume-1' });
  });

  it('2b. AI resume can never lift the OPERATOR pause', async () => {
    const { app, deps } = build();
    await deps.settings.pause();
    await request(app).post('/internal/ai/pause-entry').set(AI);
    const res = await request(app).post('/internal/ai/resume-entry').set(AI);

    expect(res.body.newState).toMatchObject({ aiEntryPaused: false, operatorPaused: true, entryPaused: true });
    expect(res.body.note).toMatch(/operator pause is still active/);
    expect((await deps.settings.get()).paused).toBe(true);
  });

  it('3. repeated pause is idempotent -- second call is a NOOP and does not overwrite the audit fields', async () => {
    const { app, deps } = build();
    await request(app).post('/internal/ai/pause-entry').set(AI).set('X-Request-Id', 'first');
    const before = await deps.settings.get();
    const res = await request(app).post('/internal/ai/pause-entry').set(AI).set('X-Request-Id', 'second');

    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({ event: 'AI_ENTRY_PAUSE_NOOP', changed: false, previousState: { aiEntryPaused: true }, newState: { aiEntryPaused: true } });
    const after = await deps.settings.get();
    expect(after.aiEntryRequestId).toBe('first');
    expect(after.aiEntryChangedAt).toEqual(before.aiEntryChangedAt);
    expect(lines(deps).filter((l) => l.event === 'AI_ENTRY_PAUSE_NOOP')).toHaveLength(1);
  });

  it('4. repeated resume is idempotent (including resume when never paused)', async () => {
    const { app, deps } = build();
    const r1 = await request(app).post('/internal/ai/resume-entry').set(AI);
    const r2 = await request(app).post('/internal/ai/resume-entry').set(AI);

    for (const r of [r1, r2]) expect(r.body).toMatchObject({ event: 'AI_ENTRY_RESUME_NOOP', changed: false, newState: { aiEntryPaused: false } });
    expect((await deps.settings.get()).aiEntryChangedAt).toBeNull();
    expect(lines(deps).filter((l) => l.event === 'AI_ENTRY_RESUME_NOOP')).toHaveLength(2);
  });

  it('GET /entry-state reports flags and position counts', async () => {
    const { app } = build();
    await request(app).post('/internal/ai/pause-entry').set(AI);
    const res = await request(app).get('/internal/ai/entry-state').set(AI);
    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({ entryPaused: true, aiEntryPaused: true, operatorPaused: false, positions: { active: 0, opening: 0, closing: 0 } });
    expect(typeof res.body.requestId).toBe('string');
  });

  it('an invalid X-Request-Id is replaced by a generated one', async () => {
    const { app } = build();
    const res = await request(app).get('/internal/ai/entry-state').set(AI).set('X-Request-Id', 'bad id with spaces/<script>');
    expect(res.body.requestId).toMatch(/^[0-9a-f-]{36}$/);
  });

  describe('10. unauthorized AI control requests are rejected', () => {
    const routes: Array<['get' | 'post', string]> = [
      ['get', '/internal/ai/entry-state'],
      ['post', '/internal/ai/pause-entry'],
      ['post', '/internal/ai/resume-entry'],
    ];

    it.each(routes)('%s %s without a token -> 401, state unchanged', async (method, path) => {
      const { app, deps } = build();
      const res = await request(app)[method](path);
      expect(res.status).toBe(401);
      expect((await deps.settings.get()).aiEntryPaused).toBe(false);
    });

    it('wrong token -> 401, and the presented token is never logged', async () => {
      const { app, deps } = build();
      const res = await request(app).post('/internal/ai/pause-entry').set('X-AI-Supervisor-Token', 'wrong-token-value');
      expect(res.status).toBe(401);
      expect((await deps.settings.get()).aiEntryPaused).toBe(false);
      const logged = JSON.stringify(lines(deps));
      expect(logged).toContain('ai_control_rejected');
      expect(logged).not.toContain('wrong-token-value');
    });

    it('the correct token is never logged on success either', async () => {
      const { app, deps } = build();
      await request(app).post('/internal/ai/pause-entry').set(AI);
      expect(JSON.stringify(lines(deps))).not.toContain(AI_TOKEN);
    });

    it('non-local peer -> 403 even with the correct token', async () => {
      const { app, deps } = build({ isLocalPeer: () => false });
      const res = await request(app).post('/internal/ai/pause-entry').set(AI);
      expect(res.status).toBe(403);
      expect((await deps.settings.get()).aiEntryPaused).toBe(false);
    });

    it.each(['X-Forwarded-For', 'X-Forwarded-Host', 'X-Forwarded-Proto', 'X-Real-IP', 'Forwarded', 'Via'])(
      'request relayed by a reverse proxy (%s header) -> 403 even from loopback with the correct token',
      async (header) => {
        const { app, deps } = build();
        const res = await request(app).post('/internal/ai/pause-entry').set(AI).set(header, '127.0.0.1');
        expect(res.status).toBe(403);
        expect((await deps.settings.get()).aiEntryPaused).toBe(false);
      },
    );

    it('control disabled (no AI_SUPERVISOR_TOKEN_SHA256 configured) -> 503 for every request', async () => {
      const { app, deps } = build({ tokenSha256: null });
      const res = await request(app).post('/internal/ai/pause-entry').set(AI);
      expect(res.status).toBe(503);
      expect((await deps.settings.get()).aiEntryPaused).toBe(false);
    });
  });

  describe('11. admin credentials are never required by AI (and the two credentials never cross)', () => {
    it('the AI token alone works -- no Authorization header, no admin password involved', async () => {
      const { app } = build();
      const res = await request(app).post('/internal/ai/pause-entry').set(AI);
      expect(res.status).toBe(200);
    });

    it('a valid admin JWT does NOT grant AI control', async () => {
      const { app, deps } = build();
      const res = await request(app).post('/internal/ai/pause-entry').set('Authorization', authHeader());
      expect(res.status).toBe(401);
      expect((await deps.settings.get()).aiEntryPaused).toBe(false);
    });

    it('the AI token does NOT open any admin route', async () => {
      const { app, deps } = build();
      for (const [method, path] of [['post', '/control/pause'], ['post', '/control/resume'], ['get', '/status'], ['patch', '/settings']] as const) {
        const res = await request(app)[method](path).set(AI).set('Authorization', `Bearer ${AI_TOKEN}`);
        expect(res.status, `${method} ${path}`).toBe(401);
      }
      expect((await deps.settings.get()).paused).toBe(false);
    });
  });

  it('12. concurrent pause/resume storms never corrupt state -- every request gets a consistent answer and final state matches the last CAS winner', async () => {
    const { app, deps } = build();
    const ops = Array.from({ length: 40 }, (_, i) => (i % 3 === 0 ? 'resume-entry' : 'pause-entry'));
    const results = await Promise.all(ops.map((op, i) => request(app).post(`/internal/ai/${op}`).set(AI).set('X-Request-Id', `c-${i}`)));

    for (const r of results) {
      expect(r.status).toBe(200);
      // every response is internally consistent
      expect(r.body.newState.aiEntryPaused).toBe(r.body.action === 'pause-entry');
      expect(r.body.changed).toBe(r.body.previousState.aiEntryPaused !== r.body.newState.aiEntryPaused);
      expect(r.body.newState.entryPaused).toBe(r.body.newState.aiEntryPaused || r.body.newState.operatorPaused);
    }
    const changed = results.filter((r) => r.body.changed);
    // Transitions strictly alternate, so the final state equals the last effective transition
    const s = await deps.settings.get();
    const last = changed.find((r) => r.body.requestId === s.aiEntryRequestId);
    expect(last).toBeDefined();
    expect(s.aiEntryPaused).toBe(last?.body.action === 'pause-entry');
    expect(s.paused).toBe(false); // the operator flag is never touched
  });
});
