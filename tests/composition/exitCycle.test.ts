import { describe, expect, it, vi } from 'vitest';
import { runExitAndOpenResumeCycle } from '../../src/composition/exitCycle';
import { runMonitoringLoggingCycle } from '../../src/composition/monitoringCycle';
import { createFakeAppDeps, fakeTxDeps, makeCandidate, USDG } from './fakeAppDeps';
import { runScreeningCycle } from '../../src/composition/screeningCycle';
import { makeCreateInput } from '../positions/fixtures';

describe('runExitAndOpenResumeCycle', () => {
  it('no positions at all -- empty, harmless summary', async () => {
    const deps = createFakeAppDeps();
    const summary = await runExitAndOpenResumeCycle(deps);
    expect(summary.exitResults).toEqual([]);
    expect(summary.closedCount).toBe(0);
    expect(summary.openResumeResults).toEqual([]);
  });

  it('records a cooldown exit for every position that CLOSED this cycle', async () => {
    const deps = createFakeAppDeps();
    const created = await deps.positions.create(makeCreateInput({ tokenAddress: '0x0000000000000000000000000000000000000002', entryUsdgRaw: USDG(300) }));
    await deps.positions.markActive(created.id, '1', new Date());
    await deps.positions.markClosing(created.id, `exit:${created.id}:1`);
    await deps.exitStates.update(created.id, { pendingCloseReason: 'HARD_STOP_LOSS' });

    const summary = await runExitAndOpenResumeCycle(deps);

    expect(summary.closedCount).toBe(1);
    expect(deps.cooldown.recordExit).toHaveBeenCalledWith('0x0000000000000000000000000000000000000002');
  });

  it('resumes every OPENING position independently of the exit decide/resume passes -- "dua resume pass, bukan satu"', async () => {
    const deps = createFakeAppDeps();
    const opening = await deps.positions.create(makeCreateInput({ tokenAddress: '0x0000000000000000000000000000000000000003' }));

    const summary = await runExitAndOpenResumeCycle(deps);

    expect(summary.openResumeResults).toHaveLength(1);
    expect(summary.openResumeResults[0]?.positionId).toBe(opening.id);
    expect(summary.openResumeResults[0]?.outcome.outcome).toBe('ACTIVE'); // the fake mint deps succeed by default
  });

  it('surfaces stuck TransactionAttempts (Module 6) and stuck swap retries (Module 8) in the summary and logs a warning', async () => {
    const deps = createFakeAppDeps();
    // A non-terminal, old-enough-to-be-flagged attempt.
    const attempt = await deps.txAttempts.create('deploy:stuck:1', 'test');
    await deps.txAttempts.update(attempt.id, {
      status: 'SENT',
      attemptCount: 10,
      firstAttemptedAt: new Date(Date.now() - 20 * 60 * 1000), // 20 minutes ago -- past EXECUTION.STUCK_ATTEMPT_MAX_AGE_MS
    });
    const closingPosition = await deps.positions.create(makeCreateInput({ tokenAddress: '0x0000000000000000000000000000000000000004' }));
    await deps.exitStates.update(closingPosition.id, { swapAttemptCount: 5 }); // at the configured STUCK_THRESHOLD

    const summary = await runExitAndOpenResumeCycle(deps);

    expect(summary.stuckTransactionAttemptIds).toContain(attempt.id);
    expect(summary.stuckSwapRetryPositionIds).toContain(closingPosition.id);
    const logger = deps.logger as ReturnType<typeof import('../../src/composition/logger').createInMemoryLogger>;
    expect(logger.lines.some((l) => l.event === 'stuck_transaction_attempts')).toBe(true);
    expect(logger.lines.some((l) => l.event === 'stuck_swap_retries')).toBe(true);
  });

  it('does NOT warn-log when nothing is stuck', async () => {
    const deps = createFakeAppDeps();
    await runExitAndOpenResumeCycle(deps);
    const logger = deps.logger as ReturnType<typeof import('../../src/composition/logger').createInMemoryLogger>;
    expect(logger.lines.some((l) => l.event === 'stuck_transaction_attempts')).toBe(false);
    expect(logger.lines.some((l) => l.event === 'stuck_swap_retries')).toBe(false);
  });

  it('a definitive mint failure during open-resume does not crash the cycle -- other work still completes', async () => {
    const deps = createFakeAppDeps({
      buildMintDeps: vi.fn(() => fakeTxDeps({ positionTokenId: '0', liquidity: 0n }, { simulate: vi.fn(async () => ({ ok: false, reason: 'would revert' })) })),
    });
    await deps.positions.create(makeCreateInput({ tokenAddress: '0x0000000000000000000000000000000000000005' }));

    const summary = await runExitAndOpenResumeCycle(deps);

    expect(summary.openResumeResults[0]?.outcome.outcome).toBe('FAILED');
    const opening = await deps.positions.findAllOpening();
    expect(opening).toHaveLength(0); // released, not stuck
  });

  it('end-to-end with runScreeningCycle: a position opened this tick, closed via a hard-stop-loss-shaped exit next tick, records cooldown', async () => {
    const deps = createFakeAppDeps({ discoveryService: { discoverTopCandidates: vi.fn(async () => [makeCandidate()]) } as never });

    await runScreeningCycle(deps);
    const [active] = await deps.positions.findAllActive();
    expect(active).toBeDefined();

    // Manually drive it to CLOSING the way runExitCycle would, to isolate this test to the cooldown-recording behavior.
    if (!active) throw new Error('unreachable');
    await deps.positions.markClosing(active.id, `exit:${active.id}:1`);
    await deps.exitStates.update(active.id, { pendingCloseReason: 'HARD_STOP_LOSS' });

    const summary = await runExitAndOpenResumeCycle(deps);

    expect(summary.closedCount).toBe(1);
    expect(deps.cooldown.recordExit).toHaveBeenCalledWith(active.tokenAddress);
  });

  describe('Module 10 -- pause NEVER affects monitoring or exit (explicit, dual proof, not assumed)', () => {
    it('while paused, monitoring still reports an ACTIVE position, and the exit cycle still evaluates/closes it normally', async () => {
      const deps = createFakeAppDeps();
      await deps.settings.pause();
      expect((await deps.settings.get()).paused).toBe(true);

      const created = await deps.positions.create(makeCreateInput({ tokenAddress: '0x0000000000000000000000000000000000000002' }));
      await deps.positions.markActive(created.id, '1', new Date());

      // Half 1: monitoring keeps operating normally while paused.
      const monitoringResults = await runMonitoringLoggingCycle(deps);
      expect(monitoringResults).toHaveLength(1);
      expect(monitoringResults[0]?.positionId).toBe(created.id);

      // Half 2: the exit cycle (decide + CLOSING resume + OPENING resume, all three sub-passes) still runs normally too -- forcing a definitive close via a pre-set CLOSING state to prove the resume pass isn't skipped either.
      await deps.positions.markClosing(created.id, `exit:${created.id}:1`);
      await deps.exitStates.update(created.id, { pendingCloseReason: 'HARD_STOP_LOSS' });

      const exitSummary = await runExitAndOpenResumeCycle(deps);

      expect(exitSummary.closedCount).toBe(1);
      const reloaded = await deps.positions.findById(created.id);
      expect(reloaded?.status).toBe('CLOSED'); // exit fully completed while the bot was paused the entire time
    });
  });
});
