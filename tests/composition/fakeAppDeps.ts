import { vi } from 'vitest';
import type { Address } from 'viem';
import type { AppDeps } from '../../src/composition/types';
import type { TxRequest, TxSafetyDeps } from '../../src/execution/types';
import type { CandidateToken } from '../../src/discovery/types';
import type { CooldownStatus } from '../../src/filters/types';
import type { V4PoolRef } from '../../src/pools/types';
import { InMemoryPositionRepository } from '../positions/inMemoryPositionRepository';
import { InMemoryTransactionAttemptRepository } from '../execution/inMemoryTransactionAttemptRepository';
import { InMemoryExitStateRepository } from '../exits/inMemoryExitStateRepository';
import { InMemorySettingsRepository } from '../settings/inMemorySettingsRepository';
import { PositionCapitalSnapshotProvider } from '../../src/positions/capitalSnapshotProvider';
import { InMemoryCanaryGuard } from '../../src/capital/canary';
import { createInMemoryLogger } from '../../src/composition/logger';
import { validPermit2Preflight } from '../positions/permit2Fixtures';

export const WALLET = '0x9999999999999999999999999999999999999999' as Address;
export const USDG = (n: number): bigint => BigInt(n) * 10n ** 18n;

const TX: TxRequest = { to: '0x1111111111111111111111111111111111111111', data: '0xabcdef', value: 0n };

export function fakeTxDeps<T>(data: T, overrides: Partial<TxSafetyDeps<T>> = {}): TxSafetyDeps<T> {
  return {
    buildTransaction: vi.fn(async () => TX),
    simulate: vi.fn(async () => ({ ok: true }) as const),
    estimateGas: vi.fn(async () => 100_000n),
    getGasPrice: vi.fn(async () => 1_000_000_000n),
    checkGasAffordable: vi.fn(async () => ({ ok: true }) as const),
    getNonce: vi.fn(async () => 1),
    signTransaction: vi.fn(async () => ({ raw: '0xdeadbeef' as `0x${string}`, hash: `0x${'ab'.repeat(32)}` as `0x${string}` })),
    broadcastRaw: vi.fn(async () => undefined),
    waitForReceipt: vi.fn(async () => ({ status: 'success' as const, blockNumber: 1n })),
    getReceiptIfAvailable: vi.fn(async () => null),
    verifyOnChain: vi.fn(async () => ({ ok: true as const, data })),
    ...overrides,
  };
}

export const POOL_REF: V4PoolRef = {
  poolId: '0xaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa',
  key: {
    currency0: '0x0000000000000000000000000000000000000002' as Address,
    currency1: '0x2222222222222222222222222222222222222222' as Address, // matches tests/setup.ts's fixture USDG address
    fee: 3000,
    tickSpacing: 60,
    hooks: '0x0000000000000000000000000000000000000000' as Address,
  },
};

export function makeCandidate(overrides: Partial<CandidateToken> = {}): CandidateToken {
  return {
    address: '0x0000000000000000000000000000000000000002',
    chainId: 4663,
    symbol: 'MEME',
    name: 'Meme Coin',
    assetType: 'Meme',
    marketCapUsd: 5_000_000,
    volumeUsd: 100_000,
    totalFeeEth: 1,
    createdAt: Date.now() - 10 * 24 * 60 * 60 * 1000,
    top10HolderConcentrationPct: 0.1,
    rank: 1,
    discoveredAt: Date.now(),
    source: 'GMGN',
    ...overrides,
  };
}

/**
 * A fully fake `AppDeps` -- in-memory repositories (real logic, no DB),
 * fake RPC/contract-facing ports (deliberately simple, deterministic
 * values), and fake tx-builders injected via `AppDeps`'s optional
 * override fields (see `composition/types.ts`'s doc comment on those --
 * this is the same "fake the contract at the tx-builder seam" pattern
 * every other smoke test in this project already uses). Real
 * orchestration/scheduling code (`composition/app.ts`,
 * `screeningCycle.ts`, `exitCycle.ts`) runs completely for real against
 * this -- only the actual on-chain calls are faked.
 */
export function createFakeAppDeps(overrides: Partial<AppDeps> = {}): AppDeps {
  const txAttempts = new InMemoryTransactionAttemptRepository();
  const cooldown: AppDeps['cooldown'] = {
    getCooldownStatus: vi.fn(async (): Promise<CooldownStatus> => ({ inCooldown: false, remainingMs: 0 })),
    recordExit: vi.fn(async () => undefined),
    findAllActive: vi.fn(async () => []),
  };
  // Cooldown crash-gap fix: exits record their cooldown inside markClosed (see the real repository).
  const positions = new InMemoryPositionRepository(txAttempts, cooldown);
  const exitStates = new InMemoryExitStateRepository();

  const base: AppDeps = {
    positions,
    txAttempts,
    exitStates,
    settings: new InMemorySettingsRepository(),
    cooldown,
    activePositionChecker: { hasActivePosition: vi.fn(async () => false) },
    // The REAL capital-accounting logic (Revisions 5-7-proven), operating
    // on the fake in-memory `positions` repository above -- not a
    // hardcoded fixed snapshot. A constant simulated on-chain balance
    // (1000 USDG) means the snapshot genuinely reflects whatever the
    // in-memory repository's actual position rows are at read time.
    capitalSnapshot: new PositionCapitalSnapshotProvider(positions, WALLET, async () => USDG(1000), txAttempts),
    canaryGuard: new InMemoryCanaryGuard(),
    discoveryService: { discoverTopCandidates: vi.fn(async () => []) } as unknown as AppDeps['discoveryService'],
    // Default fake: NON_STOCK, which is a no-op on `assetType` (see
    // `applyStockClassification`), so existing fixtures (`assetType: 'Meme'`)
    // pass through unchanged unless a test explicitly overrides this.
    stockClassifier: { classify: vi.fn(async () => 'NON_STOCK' as const) },
    poolDiscovery: { findPoolsForPair: vi.fn(async () => [POOL_REF]) },
    poolState: {
      getState: vi.fn(async () => ({
        sqrtPriceX96: 2n ** 96n,
        liquidity: 10n ** 24n,
        tickCurrent: 0,
        // A single, effectively-full-range liquidity position (standard
        // min/max usable ticks at spacing 60) so `estimateExitPriceImpact`'s
        // REAL swap simulation has real depth to walk -- an empty `ticks`
        // array makes ANY simulated swap look like 100% price impact
        // (verified against `pools/priceImpact.ts`'s own doc comment: "any
        // region beyond the supplied ticks [is] zero liquidity"), which
        // would make every fake candidate fail pool selection regardless
        // of what this integration test is actually trying to exercise.
        ticks: [
          { index: -887220, liquidityNet: 10n ** 24n, liquidityGross: 10n ** 24n },
          { index: 887220, liquidityNet: -(10n ** 24n), liquidityGross: 10n ** 24n },
        ],
      })),
    },
    poolVolume: { get6hVolumeUsd: vi.fn(async () => 500_000) },
    poolPrice: { getPriceState: vi.fn(async () => ({ sqrtPriceX96: 2n ** 96n, tickCurrent: 0 })) },
    livePositionState: { getLiveState: vi.fn(async () => ({ liquidity: 500n, tokensOwed0: 0n, tokensOwed1: 0n })) },
    // No persisted price series in the fake wiring -- `recentSamples` returning
    // an empty array is the honest "not enough history yet" state, which makes
    // BB %B unavailable (null) and the OVEREXTENDED rule correctly inert here.
    priceHistory: {
      recordSample: vi.fn(async () => undefined),
      recentSamples: vi.fn(async () => []),
      pruneOlderThan: vi.fn(async () => undefined),
    },
    swapExecutor: {
      getQuote: vi.fn(async () => ({ amountInRaw: USDG(1), expectedAmountOutRaw: USDG(1), minOutputAmountRaw: 0n, priceImpactPct: 0.001, slippageBps: 100, providerQuote: { fake: true } })),
      checkApproval: vi.fn(async () => ({ needsApproval: false, spender: null })),
      buildSwapTx: vi.fn(async () => TX),
    },
    readTokenDecimals: vi.fn(async () => 18),
    walletAddress: WALLET,
    logger: createInMemoryLogger(),
    ownedNftLister: { listOwnedTokenIds: vi.fn(async () => []) },
    nftOwnerChecker: { checkOwner: vi.fn(async () => ({ status: 'FOUND' as const, owner: WALLET })) },
    positionIdentityChecker: { checkIdentity: vi.fn(async () => ({ status: 'MATCH' as const })) },
    buildApproveDepsForOpen: vi.fn(() => fakeTxDeps({ allowanceRaw: USDG(1000) })),
    buildMintDeps: vi.fn(() => fakeTxDeps({ positionTokenId: String(Math.floor(Math.random() * 100000)), liquidity: 500n })),
    buildRemoveLiquidityDeps: vi.fn(() => fakeTxDeps({ liquidityZero: true as const, usdgProceedsRaw: USDG(90) })),
    buildSwapDeps: vi.fn(() => fakeTxDeps({ usdgIncreaseRaw: USDG(10), usdgProceedsRaw: USDG(10) })),
    buildApproveDepsForExit: vi.fn(() => fakeTxDeps({ allowanceRaw: USDG(1000) })),
    readAllowance: vi.fn(async () => USDG(1000)), // already sufficient -- approve legs skipped by default in tests unless a test overrides this
    permit2Preflight: validPermit2Preflight(), // Permit2 path valid by default -- never an RPC in tests
    readTokenBalanceForExit: vi.fn(async () => USDG(500)),
  };

  return { ...base, ...overrides };
}
