import { describe, expect, it, vi } from 'vitest';
import { runScreeningCycle } from '../../src/composition/screeningCycle';
import { createFakeAppDeps, makeCandidate, POOL_REF, USDG } from './fakeAppDeps';
import type { createInMemoryLogger } from '../../src/composition/logger';
import type { AppDeps } from '../../src/composition/types';

function logLines(deps: AppDeps): ReturnType<typeof createInMemoryLogger>['lines'] {
  return (deps.logger as ReturnType<typeof createInMemoryLogger>).lines;
}

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

  describe('ASSET_TYPE -- restored fail-closed default, on-chain stock classifier', () => {
    it('does NOT warn under the real config default (ASSET_TYPE.ENABLED is true again)', async () => {
      const deps = createFakeAppDeps({ discoveryService: { discoverTopCandidates: vi.fn(async () => []) } as never });

      await runScreeningCycle(deps);

      const warnLines = logLines(deps).filter((l) => l.event === 'asset_type_filter_disabled');
      expect(warnLines).toHaveLength(0);
    });

    it('a candidate the on-chain classifier confirms as an official Robinhood Stock Token is rejected before capital/pool/open, even with every other metric excellent', async () => {
      const stockCandidate = makeCandidate({
        symbol: 'NVDA',
        marketCapUsd: 100_000_000,
        totalFeeEth: 50,
      }); // GMGN gives assetType 'Unknown' in production; the fixture defaults to 'Meme' so the classifier is what must do the rejecting here
      const deps = createFakeAppDeps({
        discoveryService: { discoverTopCandidates: vi.fn(async () => [stockCandidate]) } as never,
        stockClassifier: { classify: vi.fn(async () => 'ROBINHOOD_OFFICIAL_STOCK' as const) },
      });
      const getSnapshotSpy = vi.spyOn(deps.capitalSnapshot, 'getSnapshot');

      const summary = await runScreeningCycle(deps);

      expect(summary.passed).toBe(0);
      expect(summary.failed).toBe(1);
      expect(summary.deployed).toBe(0);
      expect(getSnapshotSpy).not.toHaveBeenCalled(); // never even reached capital allocation
      const active = await deps.positions.findAllActive();
      expect(active).toHaveLength(0);
    });

    it('a candidate the classifier resolves as NON_STOCK is NOT thereby treated as Meme/Project (assetType stays untouched), but DOES now legitimately pass ASSET_TYPE under Phase 12 STOCK_ONLY mode', async () => {
      const unknownCandidate = makeCandidate({ symbol: 'PONS', assetType: 'Unknown' });
      const deps = createFakeAppDeps({
        discoveryService: { discoverTopCandidates: vi.fn(async () => [unknownCandidate]) } as never,
        stockClassifier: { classify: vi.fn(async () => 'NON_STOCK' as const) },
      });

      const summary = await runScreeningCycle(deps);

      // Phase 12: NON_STOCK is a legitimate ALLOW under STOCK_ONLY mode --
      // this is a deliberate, operator-approved change from the prior
      // ALLOW_LIST-era expectation (NON_STOCK used to still be rejected
      // because assetType stayed 'Unknown', which ALLOW_LIST always
      // rejected). `applyStockClassification` itself is UNCHANGED: it
      // still never rewrites assetType to 'Meme'/'Project' for NON_STOCK
      // -- confirmed structurally in `robinhoodStockClassifier.test.ts`.
      expect(summary.passed).toBe(1);
    });

    it('a classifier read failure (UNKNOWN) never opens a position either', async () => {
      const unknownCandidate = makeCandidate({ symbol: 'MYSTERY', assetType: 'Unknown' });
      const deps = createFakeAppDeps({
        discoveryService: { discoverTopCandidates: vi.fn(async () => [unknownCandidate]) } as never,
        stockClassifier: { classify: vi.fn(async () => { throw new Error('RPC timeout'); }) },
      });

      const summary = await runScreeningCycle(deps);

      expect(summary.passed).toBe(0);
      expect(summary.deployed).toBe(0);
    });
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

describe('runScreeningCycle -- Phase 12D: screening_rejection diagnostic logging', () => {
  it('1. candidate failing MARKET_CAP logs MARKET_CAP as failedRule', async () => {
    const candidate = makeCandidate({ marketCapUsd: 100 }); // below MIN_MARKET_CAP_USD, everything else passes
    const deps = createFakeAppDeps({ discoveryService: { discoverTopCandidates: vi.fn(async () => [candidate]) } as never });
    await runScreeningCycle(deps);
    const rejections = logLines(deps).filter((l) => l.event === 'screening_rejection');
    expect(rejections).toHaveLength(1);
    expect(rejections[0]?.data.failedRule).toBe('MARKET_CAP');
    expect(rejections[0]?.data.address).toBe(candidate.address);
    expect(rejections[0]?.data.symbol).toBe(candidate.symbol);
    expect(typeof rejections[0]?.data.reason).toBe('string');
  });

  it('2. candidate failing TOKEN_AGE logs TOKEN_AGE (MARKET_CAP passes)', async () => {
    const candidate = makeCandidate({ createdAt: Date.now() }); // too young; marketCapUsd stays at the passing default
    const deps = createFakeAppDeps({ discoveryService: { discoverTopCandidates: vi.fn(async () => [candidate]) } as never });
    await runScreeningCycle(deps);
    const rejections = logLines(deps).filter((l) => l.event === 'screening_rejection');
    expect(rejections).toHaveLength(1);
    expect(rejections[0]?.data.failedRule).toBe('TOKEN_AGE');
  });

  it('3. candidate failing VOLUME logs VOLUME (MARKET_CAP/TOKEN_AGE pass)', async () => {
    const candidate = makeCandidate({ volumeUsd: 0 }); // must be strictly > 0
    const deps = createFakeAppDeps({ discoveryService: { discoverTopCandidates: vi.fn(async () => [candidate]) } as never });
    await runScreeningCycle(deps);
    const rejections = logLines(deps).filter((l) => l.event === 'screening_rejection');
    expect(rejections).toHaveLength(1);
    expect(rejections[0]?.data.failedRule).toBe('VOLUME');
  });

  it('4. candidate failing ASSET_TYPE (confirmed Stock) logs ASSET_TYPE (all static filters pass)', async () => {
    const candidate = makeCandidate();
    const deps = createFakeAppDeps({
      discoveryService: { discoverTopCandidates: vi.fn(async () => [candidate]) } as never,
      stockClassifier: { classify: vi.fn(async () => 'ROBINHOOD_OFFICIAL_STOCK' as const) },
    });
    await runScreeningCycle(deps);
    const rejections = logLines(deps).filter((l) => l.event === 'screening_rejection');
    expect(rejections).toHaveLength(1);
    expect(rejections[0]?.data.failedRule).toBe('ASSET_TYPE');
    expect(rejections[0]?.data.reason).toMatch(/Stock/i);
  });

  it('5. candidate failing DUPLICATE_POSITION logs DUPLICATE_POSITION (asset gate passes -- confirmed NON_STOCK)', async () => {
    const candidate = makeCandidate();
    const deps = createFakeAppDeps({
      discoveryService: { discoverTopCandidates: vi.fn(async () => [candidate]) } as never,
      activePositionChecker: { hasActivePosition: vi.fn(async () => true) },
    });
    await runScreeningCycle(deps);
    const rejections = logLines(deps).filter((l) => l.event === 'screening_rejection');
    expect(rejections).toHaveLength(1);
    expect(rejections[0]?.data.failedRule).toBe('DUPLICATE_POSITION');
  });

  it('6. candidate failing COOLDOWN logs COOLDOWN', async () => {
    const candidate = makeCandidate();
    const deps = createFakeAppDeps({
      discoveryService: { discoverTopCandidates: vi.fn(async () => [candidate]) } as never,
      cooldown: {
        getCooldownStatus: vi.fn(async () => ({ inCooldown: true, remainingMs: 60_000 })),
        recordExit: vi.fn(async () => undefined),
        findAllActive: vi.fn(async () => []),
      },
    });
    await runScreeningCycle(deps);
    const rejections = logLines(deps).filter((l) => l.event === 'screening_rejection');
    expect(rejections).toHaveLength(1);
    expect(rejections[0]?.data.failedRule).toBe('COOLDOWN');
  });

  it('7. a candidate passing every screening rule produces NO screening_rejection log', async () => {
    const candidate = makeCandidate(); // default fixture is fully-passing, per the existing "results in exactly one deployed position" test above
    const deps = createFakeAppDeps({ discoveryService: { discoverTopCandidates: vi.fn(async () => [candidate]) } as never });
    const summary = await runScreeningCycle(deps);
    expect(summary.passed).toBe(1);
    const rejections = logLines(deps).filter((l) => l.event === 'screening_rejection');
    expect(rejections).toHaveLength(0);
  });

  it('8. multiple candidates produce independent, correctly-attributed rejection records', async () => {
    const failsMarketCap = makeCandidate({ address: '0x0000000000000000000000000000000000000010', symbol: 'LOWCAP', marketCapUsd: 100 });
    const failsVolume = makeCandidate({ address: '0x0000000000000000000000000000000000000011', symbol: 'NOVOLUME', volumeUsd: 0 });
    const passes = makeCandidate({ address: '0x0000000000000000000000000000000000000012', symbol: 'GOODONE' });
    const deps = createFakeAppDeps({
      discoveryService: { discoverTopCandidates: vi.fn(async () => [failsMarketCap, failsVolume, passes]) } as never,
    });

    const summary = await runScreeningCycle(deps);

    expect(summary.candidatesEvaluated).toBe(3);
    expect(summary.passed).toBe(1);
    expect(summary.failed).toBe(2);

    const rejections = logLines(deps).filter((l) => l.event === 'screening_rejection');
    expect(rejections).toHaveLength(2);
    const bySymbol = Object.fromEntries(rejections.map((r) => [r.data.symbol, r.data.failedRule]));
    expect(bySymbol.LOWCAP).toBe('MARKET_CAP');
    expect(bySymbol.NOVOLUME).toBe('VOLUME');
    expect(bySymbol.GOODONE).toBeUndefined(); // the passing candidate never appears in rejection records
  });

  it('9. the existing summary shape/fields are completely unchanged by the new diagnostic logging', async () => {
    const passing = makeCandidate();
    const failing = makeCandidate({ address: '0x0000000000000000000000000000000000000020', marketCapUsd: 100 });
    const deps = createFakeAppDeps({ discoveryService: { discoverTopCandidates: vi.fn(async () => [passing, failing]) } as never });

    const summary = await runScreeningCycle(deps);

    expect(Object.keys(summary).sort()).toEqual(['candidatesEvaluated', 'deployed', 'failed', 'passed', 'paused', 'skipped'].sort());
    expect(summary.candidatesEvaluated).toBe(2);
    expect(summary.passed).toBe(1);
    expect(summary.failed).toBe(1);
  });

  it('10. a logging failure (logger.info throws) cannot change the screening result', async () => {
    const failing = makeCandidate({ address: '0x0000000000000000000000000000000000000030', marketCapUsd: 100 });
    const deps = createFakeAppDeps({ discoveryService: { discoverTopCandidates: vi.fn(async () => [failing]) } as never });
    const originalInfo = deps.logger.info.bind(deps.logger);
    deps.logger.info = ((event: string, data: Record<string, unknown>) => {
      if (event === 'screening_rejection') throw new Error('simulated logger failure');
      return originalInfo(event, data);
    }) as typeof deps.logger.info;

    const summary = await runScreeningCycle(deps);

    // The screening result itself is completely unaffected by the logger throwing.
    expect(summary.candidatesEvaluated).toBe(1);
    expect(summary.passed).toBe(0);
    expect(summary.failed).toBe(1);
    expect(summary.deployed).toBe(0);
  });
});
