import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { execSync } from 'node:child_process';
import { existsSync, rmSync } from 'node:fs';
import path from 'node:path';
import { PrismaClient } from '@prisma/client';
import { PrismaBetterSqlite3 } from '@prisma/adapter-better-sqlite3';
import { PrismaSettingsRepository } from '../../src/settings/settingsRepository';
import { PrismaPositionRepository } from '../../src/positions/positionRepository';
import type { CapitalRules } from '../../src/capital/types';
import { makeCreateInput } from '../positions/fixtures';

/**
 * Real SQLite + real migrations: the AI entry-control compare-and-set and the
 * in-transaction reservation gate (checked under the CapitalLock write).
 */
const PROJECT_ROOT = path.resolve(__dirname, '../..');
const TEST_DB_PATH = path.resolve(PROJECT_ROOT, 'data', 'test-ai-entry-control.db');
const TEST_DB_URL = `file:${TEST_DB_PATH}`;

function cleanupDbFiles(): void {
  for (const suffix of ['', '-journal', '-wal', '-shm']) {
    const file = TEST_DB_PATH + suffix;
    if (existsSync(file)) rmSync(file);
  }
}

let prisma: PrismaClient;
let settings: PrismaSettingsRepository;
let positions: PrismaPositionRepository;

beforeAll(() => {
  cleanupDbFiles();
  execSync('npx prisma migrate deploy', { cwd: PROJECT_ROOT, env: { ...process.env, DATABASE_URL: TEST_DB_URL }, stdio: 'pipe' });
  prisma = new PrismaClient({ adapter: new PrismaBetterSqlite3({ url: TEST_DB_URL }) });
  settings = new PrismaSettingsRepository(prisma);
  positions = new PrismaPositionRepository(prisma);
}, 60_000);

afterAll(async () => {
  await prisma.$disconnect();
  cleanupDbFiles();
});

const RULES: CapitalRules = {
  MAX_ACTIVE_POSITIONS: 3,
  POSITION_SIZE_PCT_OF_FREE_BALANCE: 0.35,
  MAX_TOTAL_DEPLOYED_PCT_OF_PORTFOLIO: 0.95,
  ETH_GAS_RESERVE_ENABLED: false,
  ETH_GAS_RESERVE_MIN: 0,
};
const BASE = 1000n * 10n ** 18n;
const TARGET = 350n * 10n ** 18n;

describe('AI entry control (real SQLite)', () => {
  it('migration defaults: not AI-paused, no audit fields', async () => {
    const e = await settings.getEntryState();
    expect(e).toMatchObject({ aiEntryPaused: false, operatorPaused: false, entryPaused: false, aiEntryChangedAt: null, aiEntryRequestId: null });
  });

  it('pause/resume are atomic compare-and-set transitions; repeats are NOOPs', async () => {
    const p1 = await settings.aiPauseEntry('p1');
    const p2 = await settings.aiPauseEntry('p2');
    expect(p1).toMatchObject({ changed: true, previous: { aiEntryPaused: false }, current: { aiEntryPaused: true, aiEntryRequestId: 'p1' } });
    expect(p2).toMatchObject({ changed: false, current: { aiEntryPaused: true, aiEntryRequestId: 'p1' } });

    const r1 = await settings.aiResumeEntry('r1');
    const r2 = await settings.aiResumeEntry('r2');
    expect(r1).toMatchObject({ changed: true, previous: { aiEntryPaused: true }, current: { aiEntryPaused: false, aiEntryRequestId: 'r1' } });
    expect(r2).toMatchObject({ changed: false, current: { aiEntryRequestId: 'r1' } });
  });

  it('AI transitions never touch the operator flag or any other setting', async () => {
    const before = await settings.get();
    await settings.aiPauseEntry('x');
    await settings.aiResumeEntry('y');
    const after = await settings.get();
    const { aiEntryPaused: _a, aiEntryChangedAt: _b, aiEntryRequestId: _c, updatedAt: _u, ...restAfter } = after as typeof after & { updatedAt?: unknown };
    const { aiEntryPaused: _d, aiEntryChangedAt: _e, aiEntryRequestId: _f, updatedAt: _v, ...restBefore } = before as typeof before & { updatedAt?: unknown };
    expect(restAfter).toEqual(restBefore);
  });

  it('12. concurrent pause/resume storm: exactly alternating effective transitions, final state consistent', async () => {
    await settings.aiResumeEntry('reset');
    const ops = Array.from({ length: 30 }, (_, i) => (i % 2 === 0 ? settings.aiPauseEntry(`s${i}`) : settings.aiResumeEntry(`s${i}`)));
    const results = await Promise.all(ops);
    for (const t of results) {
      expect(t.changed).toBe(t.previous.aiEntryPaused !== t.current.aiEntryPaused);
      expect(t.current.entryPaused).toBe(t.current.aiEntryPaused || t.current.operatorPaused);
    }
    const final = await settings.getEntryState();
    const winner = results.find((t) => t.changed && t.current.aiEntryRequestId === final.aiEntryRequestId);
    expect(winner?.current.aiEntryPaused).toBe(final.aiEntryPaused);
  });

  it('the reservation transaction refuses under the CapitalLock while AI-paused, and succeeds once resumed', async () => {
    await settings.aiPauseEntry('gate');
    const blocked = await positions.createIfCapitalAllows(makeCreateInput({ tokenAddress: '0x00000000000000000000000000000000000000d1', entryUsdgRaw: TARGET, openIdempotencyKey: 'deploy:d1:1' }), async () => BASE, RULES);
    expect(blocked).toMatchObject({ ok: false, entryPausedBy: 'AI' });
    expect(await prisma.position.count()).toBe(0);

    await settings.aiResumeEntry('gate-off');
    const ok = await positions.createIfCapitalAllows(makeCreateInput({ tokenAddress: '0x00000000000000000000000000000000000000d1', entryUsdgRaw: TARGET, openIdempotencyKey: 'deploy:d1:2' }), async () => BASE, RULES);
    expect(ok.ok).toBe(true);
  });

  it('the reservation gate also honours the OPERATOR pause (reported as OPERATOR)', async () => {
    await settings.pause();
    const r = await positions.createIfCapitalAllows(makeCreateInput({ tokenAddress: '0x00000000000000000000000000000000000000d2', entryUsdgRaw: TARGET, openIdempotencyKey: 'deploy:d2:1' }), async () => BASE, RULES);
    expect(r).toMatchObject({ ok: false, entryPausedBy: 'OPERATOR' });
    await settings.resume();
  });

  it('a pause racing reservations: no reservation commits after the pause commits', async () => {
    await settings.aiResumeEntry('race-reset'); // one slot is held by d1 from the previous test; 2 racers + d1 = MAX_ACTIVE_POSITIONS, so only the pause can refuse
    const tokens = ['e1', 'e2'].map((s) => `0x00000000000000000000000000000000000000${s}` as const);
    let pauseAt = 0;
    const [pauseResult, ...resv] = await Promise.all([
      settings.aiPauseEntry('race').then((t) => { pauseAt = Date.now(); return t; }),
      ...tokens.map((t, i) => positions.createIfCapitalAllows(makeCreateInput({ tokenAddress: t, entryUsdgRaw: 10n ** 18n, openIdempotencyKey: `deploy:${t}:${i}` }), async () => BASE, RULES)),
    ]);
    expect(pauseResult.changed).toBe(true);
    const committedAfter = await prisma.position.findMany({ where: { tokenAddress: { in: tokens } }, select: { createdAt: true } });
    // every successful reservation was serialized BEFORE the pause; everything later was refused
    for (const p of committedAfter) expect(p.createdAt.getTime()).toBeLessThanOrEqual(pauseAt);
    // every reservation that lost the race to the pause was refused BY the pause (not some unrelated reason)
    expect(resv.length - committedAfter.length).toBe(resv.filter((r) => !r.ok && r.entryPausedBy === 'AI').length);
    // and after the pause, any new reservation is refused
    const after = await positions.createIfCapitalAllows(makeCreateInput({ tokenAddress: '0x00000000000000000000000000000000000000f1', entryUsdgRaw: 10n ** 18n, openIdempotencyKey: 'deploy:f1:1' }), async () => BASE, RULES);
    expect(after).toMatchObject({ ok: false, entryPausedBy: 'AI' });
  });
});
