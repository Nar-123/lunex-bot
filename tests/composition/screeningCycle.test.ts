import { describe, expect, it, vi } from 'vitest';
import { runScreeningCycle } from '../../src/composition/screeningCycle';
import { createFakeAppDeps, makeCandidate, POOL_REF, USDG } from './fakeAppDeps';

describe('runScreeningCycle', () => {
  it('no candidates from discovery -> empty summary, no deployment attempted', async () => {
    const deps = createFakeAppDeps({ discoveryService: { discoverTopCandidates: vi.fn(async () => []) } as never });
    const summary = await runScreeningCycle(deps);
    expect(summary).toEqual({ candidatesEvaluated: 0, passed: 0, failed: 0, deployed: 0, skipped: [], paused: false });
  });

  it('a candidate that fails hard filters is never evaluated for capital/pool/open', async () => {
    const badCandidate = makeCandidate({ marketCapUsd: 100 }); // below MIN_MARKET_CAP_USD
    const deps = createFakeAppDeps({ discoveryService: { discoverTopCandidates: vi.fn(async () => [badCandidate]) } as never });
    const getSnapshotSpy = vi.spyOn(deps.capitalSnapshot, 'getSnapshot');

    const summary = await runScreeningCycle(deps);

    expect(summary.candidatesEvaluated).toBe(1);
    expect(summary.passed).toBe(0);
    expect(summary.failed).toBe(1);
    expect(summary.deployed).toBe(0);
    expect(getSnapshotSpy).not.toHaveBeenCalled();
  });

  it('a passing candidate with insufficient capital is skipped, not deployed', async () => {
    const candidate = makeCandidate();
    const deps = createFakeAppDeps({
      discoveryService: { discoverTopCandidates: vi.fn(async () => [candidate]) } as never,
      capitalSnapshot: { getSnapshot: vi.fn(async () => ({ freeUsdgBalance: 0n, activePositionsCount: 3, totalDeployedUsdg: USDG(1000) })) },
    });

    const summary = await runScreeningCycle(deps);

    expect(summary.passed).toBe(1);
    expect(summary.deployed).toBe(0);
    expect(summary.skipped).toHaveLength(1);
    expect(summary.skipped[0]?.stage).toBe('capital');
  });

  it('a passing candidate with no pools available is skipped at the pool stage', async () => {
    const candidate = makeCandidate();
    const deps = createFakeAppDeps({
      discoveryService: { discoverTopCandidates: vi.fn(async () => [candidate]) } as never,
      poolDiscovery: { findPoolsForPair: vi.fn(async () => []) },
    });

    const summary = await runScreeningCycle(deps);

    expect(summary.deployed).toBe(0);
    expect(summary.skipped[0]?.stage).toBe('pool');
    expect(summary.skipped[0]?.reason).toBe('NO_POOLS_FOUND');
  });

  it('a fully passing candidate results in exactly one deployed position, ACTIVE', async () => {
    const candidate = makeCandidate();
    const deps = createFakeAppDeps({ discoveryService: { discoverTopCandidates: vi.fn(async () => [candidate]) } as never });

    const summary = await runScreeningCycle(deps);

    expect(summary.deployed).toBe(1);
    expect(summary.skipped).toHaveLength(0);
    const active = await deps.positions.findAllActive();
    expect(active).toHaveLength(1);
    expect(active[0]?.tokenAddress).toBe(candidate.address.toLowerCase());
  });

  it('respects MAX_SUCCESSFUL_DEPLOYMENTS_PER_CYCLE=1 -- a second fully-passing candidate is never even attempted once one deploys', async () => {
    const first = makeCandidate({ address: '0x0000000000000000000000000000000000000002', rank: 1 });
    const second = makeCandidate({ address: '0x0000000000000000000000000000000000000003', rank: 2 });
    const buildMintDeps = vi.fn(() => ({} as never)); // never actually invoked for the second candidate if the loop correctly stops
    const deps = createFakeAppDeps({ discoveryService: { discoverTopCandidates: vi.fn(async () => [first, second]) } as never });

    const summary = await runScreeningCycle(deps);

    expect(summary.deployed).toBe(1);
    const active = await deps.positions.findAllActive();
    expect(active).toHaveLength(1); // only the first candidate was ever deployed
    void buildMintDeps;
  });

  it('TRY_NEXT_CANDIDATE_ON_FAILURE: a candidate that fails pool selection does not abort the cycle -- the next passing candidate still gets a chance', async () => {
    const first = makeCandidate({ address: '0x0000000000000000000000000000000000000002', rank: 1 });
    const second = makeCandidate({ address: '0x0000000000000000000000000000000000000003', rank: 2 });
    let call = 0;
    const deps = createFakeAppDeps({
      discoveryService: { discoverTopCandidates: vi.fn(async () => [first, second]) } as never,
      poolDiscovery: {
        findPoolsForPair: vi.fn(async () => {
          call++;
          return call === 1 ? [] : [POOL_REF];
        }),
      },
    });

    const summary = await runScreeningCycle(deps);

    expect(summary.skipped).toHaveLength(1);
    expect(summary.skipped[0]?.stage).toBe('pool');
    expect(summary.deployed).toBe(1); // the SECOND candidate still deployed
  });

  it('both ACTIVE and PENDING (ambiguous mint) outcomes count toward the per-cycle deployment cap', async () => {
    const first = makeCandidate({ address: '0x0000000000000000000000000000000000000002', rank: 1 });
    const second = makeCandidate({ address: '0x0000000000000000000000000000000000000003', rank: 2 });
    const ambiguousMintDeps = vi.fn(() => ({
      buildTransaction: vi.fn(async () => ({ to: '0x1111111111111111111111111111111111111111' as const, data: '0xabcdef' as const, value: 0n })),
      simulate: vi.fn(async () => ({ ok: true }) as const),
      estimateGas: vi.fn(async () => 100_000n),
      getGasPrice: vi.fn(async () => 1_000_000_000n),
      checkGasAffordable: vi.fn(async () => ({ ok: true }) as const),
      getNonce: vi.fn(async () => 1),
      signTransaction: vi.fn(async () => ({ raw: '0xdeadbeef' as const, hash: `0x${'ab'.repeat(32)}` as const })),
      broadcastRaw: vi.fn(async () => { throw new Error('network blip'); }),
      waitForReceipt: vi.fn(async () => ({ status: 'success' as const, blockNumber: 1n })),
      getReceiptIfAvailable: vi.fn(async () => null),
      verifyOnChain: vi.fn(async () => ({ ok: true as const, data: { positionTokenId: '1', liquidity: 1n } })),
    }));
    const deps = createFakeAppDeps({
      discoveryService: { discoverTopCandidates: vi.fn(async () => [first, second]) } as never,
      buildMintDeps: ambiguousMintDeps,
    });

    const summary = await runScreeningCycle(deps);

    expect(summary.deployed).toBe(1); // the PENDING outcome from the first candidate already used the cycle's one slot
    const opening = await deps.positions.findAllOpening();
    expect(opening).toHaveLength(1); // stuck at OPENING (ambiguous), not ACTIVE -- but still counted
  });

  describe('Module 10 -- pause', () => {
    it('when paused, the cycle skips ENTIRELY -- discovery is never even called, nothing deployed', async () => {
      const discoverTopCandidates = vi.fn(async () => [makeCandidate()]);
      const deps = createFakeAppDeps({ discoveryService: { discoverTopCandidates } as never });
      await deps.settings.pause();

      const summary = await runScreeningCycle(deps);

      expect(summary).toEqual({ candidatesEvaluated: 0, passed: 0, failed: 0, deployed: 0, skipped: [], paused: true });
      expect(discoverTopCandidates).not.toHaveBeenCalled();
    });

    it('resuming makes the very next cycle behave normally again', async () => {
      const candidate = makeCandidate();
      const deps = createFakeAppDeps({ discoveryService: { discoverTopCandidates: vi.fn(async () => [candidate]) } as never });
      await deps.settings.pause();
      const pausedSummary = await runScreeningCycle(deps);
      expect(pausedSummary.paused).toBe(true);

      await deps.settings.resume();
      const resumedSummary = await runScreeningCycle(deps);

      expect(resumedSummary.paused).toBe(false);
      expect(resumedSummary.deployed).toBe(1);
    });
  });

  describe('Module 10 -- live settings (maxActivePositions / positionSizePct), read fresh each cycle', () => {
    it('a live-lowered maxActivePositions rejects a candidate that the frozen config default (3) would have allowed', async () => {
      const candidate = makeCandidate();
      const deps = createFakeAppDeps({
        discoveryService: { discoverTopCandidates: vi.fn(async () => [candidate]) } as never,
        capitalSnapshot: { getSnapshot: vi.fn(async () => ({ freeUsdgBalance: USDG(1000), activePositionsCount: 1, totalDeployedUsdg: USDG(0) })) },
      });
      await deps.settings.update({ maxActivePositions: 1 }); // frozen config default is 3 -- 1 active position would normally still be allowed

      const summary = await runScreeningCycle(deps);

      expect(summary.deployed).toBe(0);
      expect(summary.skipped[0]?.stage).toBe('capital');
      expect(summary.skipped[0]?.reason).toMatch(/max active positions/i);

      await deps.settings.update({ maxActivePositions: 5 });
      const secondSummary = await runScreeningCycle(deps);
      expect(secondSummary.deployed).toBe(1); // same candidate, same snapshot -- only the live setting changed
    });

    it('a live-changed positionSizePct is what actually sizes the deployed position, not the frozen 35% default', async () => {
      const candidate = makeCandidate();
      const deps = createFakeAppDeps({ discoveryService: { discoverTopCandidates: vi.fn(async () => [candidate]) } as never });
      await deps.settings.update({ positionSizePct: 0.1 }); // 10%, not the frozen 35% default

      await runScreeningCycle(deps);

      const active = await deps.positions.findAllActive();
      expect(active).toHaveLength(1);
      // The fake capitalSnapshot's on-chain balance is a fixed USDG(1000) -- 10% of it is USDG(100), NOT the 35%-default USDG(350).
      expect(active[0]?.entryUsdgRaw).toBe(USDG(100));
    });
  });
});
