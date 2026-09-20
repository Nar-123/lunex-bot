import { describe, expect, it, vi } from 'vitest';
import type { Address } from 'viem';
import { openPosition, type OpenPositionDeps, type OpenPositionInput } from '../../src/positions/openPosition';
import { runScreeningCycle } from '../../src/composition/screeningCycle';
import type { createInMemoryLogger } from '../../src/composition/logger';
import type { AppDeps } from '../../src/composition/types';
import type { Permit2PreflightResult } from '../../src/positions/permit2Preflight';
import type { CapitalRules } from '../../src/capital/types';
import { config } from '../../src/config';
import { InMemoryPositionRepository } from './inMemoryPositionRepository';
import { InMemoryTransactionAttemptRepository } from '../execution/inMemoryTransactionAttemptRepository';
import { POOL } from './fixtures';
import { validPermit2 } from './permit2Fixtures';
import { createFakeAppDeps, fakeTxDeps, makeCandidate } from '../composition/fakeAppDeps';

const WALLET = '0x9999999999999999999999999999999999999999' as Address;
const TOKEN = '0x0000000000000000000000000000000000000002' as Address;
const U = (n: number): bigint => BigInt(n) * 10n ** 18n;
const RULES: CapitalRules = { MAX_ACTIVE_POSITIONS: 3, POSITION_SIZE_PCT_OF_FREE_BALANCE: 0.35, MAX_TOTAL_DEPLOYED_PCT_OF_PORTFOLIO: 0.95, ETH_GAS_RESERVE_ENABLED: false, ETH_GAS_RESERVE_MIN: 0 };

function input(): OpenPositionInput {
  return { tokenAddress: TOKEN, tokenSymbol: 'MEME', tokenDecimals: 18, pool: POOL, tickLower: -6960, tickUpper: -60, entryUsdgRaw: U(350), entryTick: 0, entrySqrtPriceX96: 2n ** 96n, readOnChainUsdgBalance: async () => U(1000), capitalRules: RULES };
}

function blocked(status: Permit2PreflightResult['status']): Permit2PreflightResult {
  return validPermit2({ status, deployable: false, reason: `test: ${status}` });
}

function setup(preflight: OpenPositionDeps['permit2Preflight'], extra: Partial<OpenPositionDeps> = {}) {
  const positions = new InMemoryPositionRepository();
  const txAttempts = new InMemoryTransactionAttemptRepository();
  const reserve = vi.spyOn(positions, 'createIfCapitalAllows');
  const buildApproveDeps = vi.fn(() => fakeTxDeps({ allowanceRaw: U(350) }));
  const buildMintDeps = vi.fn(() => fakeTxDeps({ positionTokenId: '7', liquidity: 1n }));
  const deps: OpenPositionDeps = {
    positions, txAttempts, livePositionState: { getLiveState: vi.fn() }, poolPrice: { getPriceState: vi.fn() },
    readAllowance: vi.fn(async () => U(1000)), walletAddress: WALLET, permit2Preflight: preflight, buildApproveDeps, buildMintDeps, ...extra,
  };
  return { deps, positions, txAttempts, reserve, buildApproveDeps, buildMintDeps };
}

describe('Permit2 pre-flight blocks an entry BEFORE any capital reservation', () => {
  it.each(['EXPIRED', 'WRONG_SPENDER', 'INSUFFICIENT_PERMIT2_GRANT'] as const)('%s -> FAILED; no reservation, no position, no approve/mint built, no tx attempt', async (status) => {
    const ctx = setup(vi.fn(async () => blocked(status)));
    const r = await openPosition(input(), ctx.deps);

    expect(r).toMatchObject({ outcome: 'FAILED' });
    expect(r.outcome === 'FAILED' && r.blockedByPermit2?.status).toBe(status);
    expect(r.outcome === 'FAILED' && r.reason).toMatch(new RegExp(`^\\[PERMIT2_${status}\\]`));
    expect(ctx.reserve).not.toHaveBeenCalled();
    expect(await ctx.positions.findAllOpening()).toHaveLength(0);
    expect(await ctx.positions.findAllActive()).toHaveLength(0);
    expect(ctx.buildApproveDeps).not.toHaveBeenCalled();
    expect(ctx.buildMintDeps).not.toHaveBeenCalled();
    expect(await ctx.txAttempts.findNonTerminal()).toHaveLength(0);
  });

  it('pre-flight RPC failure fails CLOSED (UNAVAILABLE): nothing reserved or attempted', async () => {
    const ctx = setup(vi.fn(async () => { throw new Error('HTTP request failed. URL: https://rpc.example/v2/KEY123456789'); }));
    const r = await openPosition(input(), ctx.deps);
    expect(r.outcome === 'FAILED' && r.blockedByPermit2?.status).toBe('UNAVAILABLE');
    expect(r.outcome === 'FAILED' && r.reason).not.toContain('KEY123456789');
    expect(ctx.reserve).not.toHaveBeenCalled();
    expect(ctx.buildMintDeps).not.toHaveBeenCalled();
  });

  it('pre-flight is evaluated for the exact entry amount', async () => {
    const preflight = vi.fn(async () => validPermit2());
    await openPosition(input(), setup(preflight).deps);
    expect(preflight).toHaveBeenCalledWith(U(350));
  });

  it('VALID -> reserves and deploys as before (no approve when the Permit2 allowance suffices)', async () => {
    const ctx = setup(vi.fn(async () => validPermit2()));
    expect((await openPosition(input(), ctx.deps)).outcome).toBe('ACTIVE');
    expect(ctx.reserve).toHaveBeenCalledTimes(1);
    expect(ctx.buildApproveDeps).not.toHaveBeenCalled();
  });

  it('INSUFFICIENT_ALLOWANCE -> deployable: the approve leg runs, and the allowance checked is the one to PERMIT2 (not the PositionManager)', async () => {
    const readAllowance = vi.fn(async () => 0n);
    const ctx = setup(vi.fn(async () => validPermit2({ status: 'INSUFFICIENT_ALLOWANCE', needsErc20Approval: true })), { readAllowance });
    expect((await openPosition(input(), ctx.deps)).outcome).toBe('ACTIVE');
    expect(ctx.buildApproveDeps).toHaveBeenCalledWith(U(350));
    expect(readAllowance).toHaveBeenCalledWith(config.quoteAsset.ADDRESS, WALLET, config.uniswap.v4.permit2);
    expect(readAllowance).not.toHaveBeenCalledWith(expect.anything(), expect.anything(), config.uniswap.v4.positionManager);
  });

  it('a leftover PositionManager allowance can no longer skip the approve: only the Permit2 allowance counts', async () => {
    const readAllowance = vi.fn(async (_t: Address, _o: Address, spender: Address) => (spender === config.uniswap.v4.positionManager ? U(10_000) : 0n));
    const ctx = setup(vi.fn(async () => validPermit2()), { readAllowance });
    await openPosition(input(), ctx.deps);
    expect(ctx.buildApproveDeps).toHaveBeenCalledTimes(1);
  });
});

describe('screening cycle with a blocking Permit2 pre-flight', () => {
  function lines(deps: AppDeps) {
    return (deps.logger as ReturnType<typeof createInMemoryLogger>).lines;
  }

  it('stops the cycle at the first candidate (wallet-level condition), deploys nothing, logs entry_blocked_permit2', async () => {
    const permit2Preflight = vi.fn(async () => blocked('EXPIRED'));
    const deps = createFakeAppDeps({
      discoveryService: { discoverTopCandidates: vi.fn(async () => [makeCandidate({ address: '0x00000000000000000000000000000000000000a1' }), makeCandidate({ address: '0x00000000000000000000000000000000000000b2', symbol: 'BBB' })]) } as never,
      permit2Preflight,
    });

    const summary = await runScreeningCycle(deps);

    expect(summary.deployed).toBe(0);
    expect(summary.skipped).toEqual([expect.objectContaining({ stage: 'permit2' })]);
    expect(permit2Preflight).toHaveBeenCalledTimes(1); // not repeated for the next candidate
    expect(await deps.positions.findAllOpening()).toHaveLength(0);
    expect(lines(deps).find((l) => l.event === 'entry_blocked_permit2')?.data).toMatchObject({ status: 'EXPIRED' });
  });

  it('a grant expiring soon still deploys but emits permit2_grant_expiring_soon (with the on-chain expiry)', async () => {
    const deps = createFakeAppDeps({
      discoveryService: { discoverTopCandidates: vi.fn(async () => [makeCandidate()]) } as never,
      permit2Preflight: vi.fn(async () => validPermit2({ expiringSoon: true, grantExpiration: 1_790_871_926, secondsUntilExpiry: 3600 * 24 })),
    });
    const summary = await runScreeningCycle(deps);
    expect(summary.deployed).toBe(1);
    expect(lines(deps).find((l) => l.event === 'permit2_grant_expiring_soon')?.data).toMatchObject({ expiresAt: '2026-10-01T16:25:26.000Z', grantNonce: 1 });
  });
});
