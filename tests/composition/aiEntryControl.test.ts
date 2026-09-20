import { describe, expect, it, vi } from 'vitest';
import type { InMemoryExitStateRepository } from '../exits/inMemoryExitStateRepository';
import { runScreeningCycle } from '../../src/composition/screeningCycle';
import { runExitAndOpenResumeCycle } from '../../src/composition/exitCycle';
import { runMonitoringLoggingCycle } from '../../src/composition/monitoringCycle';
import type { createInMemoryLogger } from '../../src/composition/logger';
import type { AppDeps } from '../../src/composition/types';
import { createFakeAppDeps, makeCandidate } from './fakeAppDeps';
import { makeCreateInput } from '../positions/fixtures';

function lines(deps: AppDeps) {
  return (deps.logger as ReturnType<typeof createInMemoryLogger>).lines;
}

const TOKEN_A = '0x00000000000000000000000000000000000000a1' as const;
const TOKEN_B = '0x00000000000000000000000000000000000000b2' as const;

describe('AI entry pause -- screening/deployment enforcement', () => {
  it('5. AI-paused state blocks deployment: cycle skips, nothing reserved, AI_ENTRY_BLOCKED_BY_PAUSE logged', async () => {
    const discoverTopCandidates = vi.fn(async () => [makeCandidate()]);
    const deps = createFakeAppDeps({ discoveryService: { discoverTopCandidates } as never });
    await deps.settings.aiPauseEntry('rid-5');

    const summary = await runScreeningCycle(deps);

    expect(summary.paused).toBe(true);
    expect(summary.deployed).toBe(0);
    expect(discoverTopCandidates).not.toHaveBeenCalled();
    expect(await deps.positions.findAllOpening()).toHaveLength(0);
    const blocked = lines(deps).find((l) => l.event === 'AI_ENTRY_BLOCKED_BY_PAUSE');
    expect(blocked?.level).toBe('warn');
    expect(blocked?.data).toMatchObject({ actor: 'ai-supervisor', requestId: 'rid-5', stage: 'cycle-start', newState: { aiEntryPaused: true, entryPaused: true } });
  });

  it('5b. the reservation itself refuses while AI-paused (defence in depth, independent of the screening loop)', async () => {
    const deps = createFakeAppDeps();
    await deps.settings.aiPauseEntry('rid-5b');
    const r = await deps.positions.createIfCapitalAllows(makeCreateInput({ tokenAddress: TOKEN_A }), async () => 10n ** 30n, {
      MAX_ACTIVE_POSITIONS: 3,
      POSITION_SIZE_PCT_OF_FREE_BALANCE: 0.35,
      MAX_TOTAL_DEPLOYED_PCT_OF_PORTFOLIO: 0.95,
      ETH_GAS_RESERVE_ENABLED: false,
      ETH_GAS_RESERVE_MIN: 0,
    });
    expect(r).toMatchObject({ ok: false, entryPausedBy: 'AI' });
  });

  it('6. AI resume allows normal screening on the very next cycle', async () => {
    const deps = createFakeAppDeps({ discoveryService: { discoverTopCandidates: vi.fn(async () => [makeCandidate()]) } as never });
    await deps.settings.aiPauseEntry('p');
    expect((await runScreeningCycle(deps)).deployed).toBe(0);

    await deps.settings.aiResumeEntry('r');
    const summary = await runScreeningCycle(deps);

    expect(summary.paused).toBe(false);
    expect(summary.deployed).toBe(1);
  });

  it('7a. a pause landing mid-cycle (after discovery, before the candidate loop) prevents the next deployment', async () => {
    const deps = createFakeAppDeps();
    deps.discoveryService = {
      discoverTopCandidates: vi.fn(async () => {
        await deps.settings.aiPauseEntry('mid-cycle');
        return [makeCandidate({ address: TOKEN_A }), makeCandidate({ address: TOKEN_B, symbol: 'BBB' })];
      }),
    } as never;

    const summary = await runScreeningCycle(deps);

    expect(summary.deployed).toBe(0);
    expect(summary.skipped[0]).toMatchObject({ stage: 'entry' });
    expect(await deps.positions.findAllOpening()).toHaveLength(0);
    expect(lines(deps).find((l) => l.event === 'AI_ENTRY_BLOCKED_BY_PAUSE')?.data).toMatchObject({ stage: 'before-candidate', requestId: 'mid-cycle' });
  });

  it('7b. a pause landing after the candidate passed screening but before reservation is caught UNDER the capital lock', async () => {
    const deps = createFakeAppDeps({ discoveryService: { discoverTopCandidates: vi.fn(async () => [makeCandidate({ address: TOKEN_A })]) } as never });
    const realSnapshot = deps.capitalSnapshot.getSnapshot.bind(deps.capitalSnapshot);
    vi.spyOn(deps.capitalSnapshot, 'getSnapshot').mockImplementation(async (...args) => {
      const snap = await realSnapshot(...args);
      await deps.settings.aiPauseEntry('late-pause'); // lands after the per-candidate check
      return snap;
    });

    const summary = await runScreeningCycle(deps);

    expect(summary.deployed).toBe(0);
    expect(await deps.positions.findAllOpening()).toHaveLength(0);
    expect(await deps.positions.findAllActive()).toHaveLength(0);
    const blocked = lines(deps).filter((l) => l.event === 'AI_ENTRY_BLOCKED_BY_PAUSE');
    expect(blocked.map((l) => l.data.stage)).toContain('reservation');
  });

  it('operator pause keeps its existing behaviour and does NOT emit AI_ENTRY_BLOCKED_BY_PAUSE', async () => {
    const deps = createFakeAppDeps({ discoveryService: { discoverTopCandidates: vi.fn(async () => [makeCandidate()]) } as never });
    await deps.settings.pause();
    const summary = await runScreeningCycle(deps);
    expect(summary).toEqual({ candidatesEvaluated: 0, passed: 0, failed: 0, deployed: 0, skipped: [], paused: true });
    expect(lines(deps).some((l) => l.event === 'AI_ENTRY_BLOCKED_BY_PAUSE')).toBe(false);
  });
});

describe('AI entry pause never affects existing positions or exits', () => {
  it('8. ACTIVE positions remain ACTIVE and untouched by pause/resume', async () => {
    const deps = createFakeAppDeps();
    const created = await deps.positions.create(makeCreateInput({ tokenAddress: TOKEN_A }));
    await deps.positions.markActive(created.id, '1', new Date());
    const before = await deps.positions.findById(created.id);

    await deps.settings.aiPauseEntry('p8');
    await runScreeningCycle(deps);
    await deps.settings.aiResumeEntry('r8');

    expect(await deps.positions.findById(created.id)).toEqual(before);
    const monitoring = await runMonitoringLoggingCycle(deps);
    expect(monitoring.map((m) => m.positionId)).toEqual([created.id]);
  });

  it('9. exit logic continues normally while AI-paused', async () => {
    const deps = createFakeAppDeps();
    await deps.settings.aiPauseEntry('p9');
    const created = await deps.positions.create(makeCreateInput({ tokenAddress: TOKEN_A }));
    await deps.positions.markActive(created.id, '1', new Date());
    await deps.positions.markClosing(created.id, `exit:${created.id}:1`);
    await (deps.exitStates as InMemoryExitStateRepository).update(created.id, { pendingCloseReason: 'HARD_STOP_LOSS' });

    const exitSummary = await runExitAndOpenResumeCycle(deps);

    expect(exitSummary.closedCount).toBe(1);
    expect((await deps.positions.findById(created.id))?.status).toBe('CLOSED');
    expect((await deps.settings.get()).aiEntryPaused).toBe(true);
  });
});
