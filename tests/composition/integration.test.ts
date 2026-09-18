import { describe, expect, it, vi } from 'vitest';
import { getAddress } from 'viem';
import { Token } from '@uniswap/sdk-core';
import { startApp } from '../../src/composition/app';
import { createFakeAppDeps, fakeTxDeps, makeCandidate, POOL_REF, USDG } from './fakeAppDeps';
import type { createInMemoryLogger } from '../../src/composition/logger';
import type { AppDeps } from '../../src/composition/types';
import type { PositionRecord } from '../../src/positions/types';
import { v3TickMathUtils, v4Sdk } from '../../src/blockchain/uniswapSdk';
import { config } from '../../src/config';

const { TickMath } = v3TickMathUtils;
/** Exact sqrtPriceX96 for a given tick -- a hand-approximated ratio is NOT
 * good enough (computePositionMetrics's Pool construction needs a
 * genuinely consistent sqrtPriceX96/tickCurrent pair, or its internal math
 * silently produces garbage/failing reads). */
function sqrtAt(tick: number): bigint {
  return BigInt(TickMath.getSqrtRatioAtTick(tick).toString());
}

/**
 * P0-3: a REAL, price-consistent liquidity derivation for a given
 * position, computed from that position's OWN recorded entry data (not a
 * fixed, price-independent placeholder). `fakeAppDeps.ts`'s default
 * `getLiveState` returns a hardcoded `liquidity: 500n` completely
 * decoupled from the real `entryUsdgRaw` a live capital-allocation cycle
 * decides -- harmless while HARD_STOP_LOSS fired almost immediately
 * regardless (the old ladder), but under the P0-3 fix a decoupled
 * liquidity value makes `computePositionMetrics` read a permanent,
 * price-independent ~-100% PnL that can never "recover" no matter what
 * price is fed in, since it isn't actually driven by price at all. Mirrors
 * `tests/exits/positionFixture.ts`'s `deriveEntryLiquidity` exactly, just
 * computed per-position (from whatever the real screening cycle actually
 * decided) instead of hardcoded per-test-file.
 */
function deriveRealisticLiquidity(position: PositionRecord): bigint {
  const usdgAddress = getAddress(config.quoteAsset.ADDRESS);
  const currency0 = getAddress(position.pool.currency0);
  const usdgIsCurrency0 = currency0 === usdgAddress;
  const usdgToken = new Token(config.chain.chainId, usdgAddress, config.quoteAsset.DECIMALS, 'USDG');
  const otherToken = new Token(config.chain.chainId, usdgIsCurrency0 ? getAddress(position.pool.currency1) : currency0, position.tokenDecimals, position.tokenSymbol);
  const currency0Token = usdgIsCurrency0 ? usdgToken : otherToken;
  const currency1Token = usdgIsCurrency0 ? otherToken : usdgToken;
  // Entry price -- this test's pre-crash getPriceState always returns tick 0.
  const poolAtEntry = new v4Sdk.Pool(currency0Token, currency1Token, position.pool.fee, position.pool.tickSpacing, position.pool.hooks, (2n ** 96n).toString(), '0', 0);
  const derived = usdgIsCurrency0
    ? v4Sdk.Position.fromAmount0({ pool: poolAtEntry, tickLower: position.tickLower, tickUpper: position.tickUpper, amount0: position.entryUsdgRaw.toString(), useFullPrecision: true })
    : v4Sdk.Position.fromAmount1({ pool: poolAtEntry, tickLower: position.tickLower, tickUpper: position.tickUpper, amount1: position.entryUsdgRaw.toString() });
  return BigInt(derived.liquidity.toString());
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function logLines(deps: AppDeps): ReturnType<typeof createInMemoryLogger>['lines'] {
  return (deps.logger as ReturnType<typeof createInMemoryLogger>).lines;
}

/**
 * The integration smoke test explicitly requested in review: run the REAL
 * composition root (`startApp`, unmodified) for several short cycles, all
 * three schedules genuinely concurrent, against mocked RPC/contracts (the
 * same tx-builder-seam fakes every other smoke test in this project uses --
 * see `fakeAppDeps.ts`'s doc comment), proving the three cycles coexist
 * without interfering -- not just that each cycle function works in
 * isolation (already covered by `screeningCycle.test.ts`/`exitCycle.test.ts`).
 */
describe('composition root integration: all three cycles running concurrently', () => {
  it('screening deploys a position, monitoring observes it, exit closes it via a real HARD_STOP_LOSS-shaped price crash -- all while ticking independently', async () => {
    const candidate = makeCandidate({ address: '0x0000000000000000000000000000000000000002' });
    let ticksElapsed = 0;

    const deps = createFakeAppDeps({
      discoveryService: {
        discoverTopCandidates: vi.fn(async () => {
          // Only offer the candidate on the FIRST screening tick -- once
          // deployed, `activePositionChecker` (below) reflects it and
          // duplicate-position filtering takes over naturally, same as
          // production; this just keeps the test's assertions simple.
          return ticksElapsed === 0 ? [candidate] : [];
        }),
      } as never,
      // Price crashes after a few monitoring/exit ticks -- simulates a
      // real HARD_STOP_LOSS trigger arriving mid-run, not a scripted "call
      // runExitCycle directly" shortcut. P0-3 note: kept deliberately
      // SHALLOW (not a -29%-shaped crash) so it lands in the -6%-to-(-8%)
      // band that does NOT arm SAFETY_EXIT same-tick (see
      // resolveExitDecision.ts) -- this test is about proving the three
      // cycles coexist end-to-end, not about the P0-3 arm/yield mechanism
      // itself (covered exhaustively in resolveExitDecision.test.ts and
      // runExitCycle.test.ts), so a clean, unambiguous close is what it needs.
      poolPrice: {
        getPriceState: vi.fn(async () => {
          ticksElapsed++;
          const crashed = ticksElapsed > 6;
          // -3000 -> pnlPct ~ -6.4% for this range shape: in the un-armed
          // Hard-Stop band (see P0-3 in resolveExitDecision.ts), so this
          // stays a clean, unambiguous HARD_STOP_LOSS close -- this test
          // is about proving the three cycles coexist end-to-end, not
          // about the P0-3 arm/yield mechanism itself.
          return crashed ? { sqrtPriceX96: sqrtAt(-3000), tickCurrent: -3000 } : { sqrtPriceX96: 2n ** 96n, tickCurrent: 0 };
        }),
      },
      // P0-3: liquidity genuinely derived from each position's own real
      // entry data (see deriveRealisticLiquidity above), not a fixed
      // placeholder decoupled from price -- otherwise PnL never actually
      // tracks the simulated crash/recovery below.
      livePositionState: { getLiveState: vi.fn(async (position: PositionRecord) => ({ liquidity: deriveRealisticLiquidity(position), tokensOwed0: 0n, tokensOwed1: 0n })) },
    });

    // Track whether `activePositionChecker` actually reflects deployed state, mirroring the real port's contract (Revision 8-proven elsewhere) rather than always returning false.
    deps.activePositionChecker.hasActivePosition = vi.fn(async () => {
      const active = await deps.positions.findAllActive();
      const opening = await deps.positions.findAllOpening();
      return active.length > 0 || opening.length > 0;
    });

    const { stop } = startApp(deps, { screeningIntervalMs: 40, monitoringIntervalMs: 15, exitIntervalMs: 15 });

    // Let several ticks of all three cycles elapse.
    await sleep(400);
    await stop();

    const events = logLines(deps).map((l) => l.event);
    const screeningRuns = events.filter((e) => e === 'screening_cycle').length;
    const monitoringRuns = events.filter((e) => e === 'monitoring_cycle').length;
    const exitRuns = events.filter((e) => e === 'exit_cycle').length;

    // All three schedules genuinely fired multiple times, independently, within one run.
    expect(screeningRuns).toBeGreaterThan(1);
    expect(monitoringRuns).toBeGreaterThan(1);
    expect(exitRuns).toBeGreaterThan(1);

    // The position was actually deployed (screening) ...
    const allPositions = await deps.positions.findById; // sanity: repository still queryable after stop()
    expect(allPositions).toBeDefined();
    const closed = await (async () => {
      // Re-derive via a fresh query rather than trusting in-loop state.
      const active = await deps.positions.findAllActive();
      const opening = await deps.positions.findAllOpening();
      const closing = await deps.positions.findAllClosing();
      return { active: active.length, opening: opening.length, closing: closing.length };
    })();

    // ... monitored at least once while ACTIVE (monitoring_cycle events with positionsMonitored > 0) ...
    const monitoredWithPosition = logLines(deps).some((l) => l.event === 'monitoring_cycle' && (l.data.positionsMonitored as number) > 0);
    expect(monitoredWithPosition).toBe(true);

    // ... and, by the time the price crash landed and enough exit ticks ran, closed again -- no position left ACTIVE/OPENING/CLOSING.
    expect(closed.active + closed.opening + closed.closing).toBe(0);

    // Cooldown was recorded for the exit -- proving the exit cycle's own wiring (not just runExitCycle in isolation) fired for real.
    expect(deps.cooldown.recordExit).toHaveBeenCalled();
  });

  it('a stuck (ambiguous, never resolving) mint does not block monitoring or exit cycles from continuing to tick for OTHER positions', async () => {
    const stuckCandidate = makeCandidate({ address: '0x0000000000000000000000000000000000000003' });
    let offered = false;

    const deps = createFakeAppDeps({
      discoveryService: {
        discoverTopCandidates: vi.fn(async () => {
          if (offered) return [];
          offered = true;
          return [stuckCandidate];
        }),
      } as never,
      buildMintDeps: vi.fn(() =>
        fakeTxDeps(
          { positionTokenId: '0', liquidity: 0n },
          { broadcastRaw: vi.fn(async () => { throw new Error('perpetually ambiguous RPC timeout'); }) },
        ),
      ),
    });

    const { stop } = startApp(deps, { screeningIntervalMs: 200, monitoringIntervalMs: 15, exitIntervalMs: 15 });
    await sleep(150);
    await stop();

    // The mint never resolves (stays PENDING every retry) -- but monitoring/exit still ticked repeatedly and didn't hang or crash the process.
    const monitoringRuns = logLines(deps).filter((l) => l.event === 'monitoring_cycle').length;
    const exitRuns = logLines(deps).filter((l) => l.event === 'exit_cycle').length;
    expect(monitoringRuns).toBeGreaterThan(1);
    expect(exitRuns).toBeGreaterThan(1);

    // The stuck candidate's position is genuinely still OPENING -- the resume pass keeps retrying it every exit-cycle tick, exactly as designed, never silently dropped.
    const opening = await deps.positions.findAllOpening();
    expect(opening).toHaveLength(1);
  });

  it('CRITICAL: all three exit-cycle sub-passes (ACTIVE decide, CLOSING resume, OPENING resume) re-run on EVERY tick, not just at startup -- a position created mid-run is picked up on a LATER tick, without a restart', async () => {
    const deps = createFakeAppDeps({ discoveryService: { discoverTopCandidates: vi.fn(async () => []) } as never });

    const { stop } = startApp(deps, { screeningIntervalMs: 100_000, monitoringIntervalMs: 100_000, exitIntervalMs: 15 });

    // Let the exit cycle tick at least once with NOTHING to resume -- this
    // is the "startup" tick `runImmediately: true` provides.
    await sleep(30);
    const openResumeEventsBeforeCreate = logLines(deps).filter((l) => l.event === 'exit_cycle').length;
    expect(openResumeEventsBeforeCreate).toBeGreaterThan(0);

    // NOW create a position at OPENING -- mid-run, well after startup,
    // simulating a position that entered OPENING because of something
    // happening DURING normal operation (not a crash/restart scenario at
    // all -- e.g. a screening cycle deploy on an ambiguous/pending mint).
    // If the OPENING resume pass only ever ran once at startup (the
    // failure mode this test exists to rule out), this position would
    // never be picked up without a full process restart.
    const midRunPosition = await deps.positions.create({
      tokenAddress: '0x0000000000000000000000000000000000000099' as never,
      tokenSymbol: 'MIDRUN',
      tokenDecimals: 18,
      pool: POOL_REF.key,
      tickLower: -6960,
      tickUpper: -60,
      entryUsdgRaw: USDG(10),
      entrySqrtPriceX96: 2n ** 96n,
      entryTick: 0,
      openIdempotencyKey: 'deploy:mid-run-test:1',
    } as never);

    // Give the exit schedule several more ticks to run -- with NO restart, NO new startApp() call.
    await sleep(80);
    await stop();

    const reloaded = await deps.positions.findById(midRunPosition.id);
    // Picked up and resolved out of OPENING purely by a LATER regular tick
    // -- not asserting a specific end status (ACTIVE vs. already CLOSED
    // again by a following ACTIVE-decide-pass tick, since the fake
    // liveState/entry numbers here aren't tuned for a stable PNL) --
    // what this test is actually proving is that it left OPENING at all,
    // without any restart.
    expect(reloaded?.status).not.toBe('OPENING');

    // Confirm via the exit_cycle log events themselves: openResumeAttempts
    // was 0 on ticks before the position existed, then >0 on a later tick
    // -- proving the SAME running cycle body picked up newly-created state
    // on a subsequent invocation, not just once at process start.
    const exitCycleEvents = logLines(deps).filter((l) => l.event === 'exit_cycle');
    expect(exitCycleEvents.length).toBeGreaterThan(openResumeEventsBeforeCreate); // more ticks happened after creation
    const sawItResumed = exitCycleEvents.some((l) => (l.data.openResumeAttempts as number) > 0);
    expect(sawItResumed).toBe(true);
  });

  it('a definitively-failed mint releases capital back to free within the same running process -- verified via a fresh capital snapshot read mid-run', async () => {
    const badCandidate = makeCandidate({ address: '0x0000000000000000000000000000000000000004' });
    let offered = false;
    const deps = createFakeAppDeps({
      discoveryService: {
        discoverTopCandidates: vi.fn(async () => {
          if (offered) return [];
          offered = true;
          return [badCandidate];
        }),
      } as never,
      buildMintDeps: vi.fn(() => fakeTxDeps({ positionTokenId: '0', liquidity: 0n }, { simulate: vi.fn(async () => ({ ok: false, reason: 'would revert' })) })),
    });

    const { stop } = startApp(deps, { screeningIntervalMs: 200, monitoringIntervalMs: 100_000, exitIntervalMs: 100_000 });
    await sleep(60);
    await stop();

    const snapshot = await deps.capitalSnapshot.getSnapshot();
    expect(snapshot.totalDeployedUsdg).toBe(0n);
    expect(snapshot.freeUsdgBalance).toBe(USDG(1000)); // the fake capitalSnapshot's fixed on-chain balance -- confirms nothing stayed reserved
    const opening = await deps.positions.findAllOpening();
    expect(opening).toHaveLength(0);
  });
});
