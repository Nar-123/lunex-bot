import { describe, expect, it, vi } from 'vitest';
import type { Address } from 'viem';
import { buildRemoveLiquidityDeps, buildV4Position } from '../../src/exits/removeLiquidityTx';
import { liveState, makeExitTestPosition, sqrtAt } from './positionFixture';
import { config } from '../../src/config';

const WALLET = '0x9999999999999999999999999999999999999999' as Address;
const HASH = '0xbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb' as `0x${string}`;
const USDG = (n: number): bigint => BigInt(n) * 10n ** 18n;

function makeDeps(liquidity: bigint, readUsdgTransfersTo: (hash: `0x${string}`, token: Address, wallet: Address) => Promise<bigint>) {
  const getLiveState = vi.fn(async () => liveState(liquidity));
  const deps = buildRemoveLiquidityDeps(makeExitTestPosition({ status: 'CLOSING' }), { getLiveState }, { getPriceState: vi.fn() }, { readUsdgTransfersTo, walletAddress: WALLET });
  return { deps, getLiveState };
}

describe('buildV4Position -- Phase 12G: USDG Token decimals must match config.quoteAsset.DECIMALS (6), symmetric with the mint path', () => {
  it('the constructed USDG-side Token carries exactly config.quoteAsset.DECIMALS (6, not 18)', () => {
    expect(config.quoteAsset.DECIMALS).toBe(6);
    // TOKEN_ADDR sorts before USDG_ADDR -> currency0=TOKEN, currency1=USDG (see positionFixture.ts).
    const position = buildV4Position(makeExitTestPosition(), 1_000_000n, sqrtAt(0), 0);
    expect(position.pool.currency1.decimals).toBe(config.quoteAsset.DECIMALS);
    expect(position.pool.currency1.decimals).toBe(6);
  });

  it('the OTHER (non-USDG) token keeps its own real decimals, unaffected by the USDG fix', () => {
    const position = buildV4Position(makeExitTestPosition({ tokenDecimals: 9 }), 1_000_000n, sqrtAt(0), 0);
    expect(position.pool.currency0.decimals).toBe(9);
    expect(position.pool.currency1.decimals).toBe(6);
  });

  it('the raw liquidity value is passed through untouched -- no decimals-based scaling of the burn amount', () => {
    const rawLiquidity = 123_456_789n;
    const position = buildV4Position(makeExitTestPosition(), rawLiquidity, sqrtAt(0), 0);
    expect(BigInt(position.liquidity.toString())).toBe(rawLiquidity);
  });
});

describe('P1-11: remove-liquidity slippage is bounded (100 bps), never 100% tolerance', () => {
  it('config.rules.exits.REMOVE_LIQUIDITY_SLIPPAGE_BPS is the tight, already-vetted 100 bps (1%) tier -- not 10_000 (100%)', () => {
    expect(config.rules.exits.REMOVE_LIQUIDITY_SLIPPAGE_BPS).toBe(100);
    expect(config.rules.exits.REMOVE_LIQUIDITY_SLIPPAGE_BPS).not.toBe(10_000);
    expect(config.rules.exits.REMOVE_LIQUIDITY_SLIPPAGE_BPS).toBe(config.rules.exits.SLIPPAGE_TIERS_BPS[0]);
  });

  it('the calldata for a bounded (100 bps) burn genuinely differs from the OLD 100%-tolerance encoding, at the SAME deadline -- proves the bound has real teeth', async () => {
    const { v4Sdk } = await import('../../src/blockchain/uniswapSdk');
    const { Percent } = await import('@uniswap/sdk-core');
    const position = buildV4Position(makeExitTestPosition(), 1_000_000n, sqrtAt(0), 0);
    const deadline = Math.floor(Date.now() / 1000) + 10 * 60;

    const bounded = v4Sdk.V4PositionManager.removeCallParameters(position, {
      tokenId: '1',
      liquidityPercentage: new Percent(1, 1),
      burnToken: true,
      slippageTolerance: new Percent(config.rules.exits.REMOVE_LIQUIDITY_SLIPPAGE_BPS, 10_000),
      deadline,
    });
    const oldStyle = v4Sdk.V4PositionManager.removeCallParameters(position, {
      tokenId: '1',
      liquidityPercentage: new Percent(1, 1),
      burnToken: true,
      slippageTolerance: new Percent(1, 1),
      deadline,
    });

    expect(bounded.calldata).not.toBe(oldStyle.calldata);
  });

  it('does not break the legitimate close flow -- buildRemoveLiquidityDeps.buildTransaction still succeeds end-to-end with the bounded slippage', async () => {
    const getLiveState = vi.fn(async () => liveState(1_000_000n));
    const deps = buildRemoveLiquidityDeps(makeExitTestPosition({ status: 'CLOSING' }), { getLiveState }, { getPriceState: vi.fn(async () => ({ sqrtPriceX96: sqrtAt(0), tickCurrent: 0 })) }, { walletAddress: WALLET });
    const tx = await deps.buildTransaction();
    expect(tx.data.length).toBeGreaterThan(10);
  });
});

describe('buildRemoveLiquidityDeps.verifyOnChain -- P1: proceeds-read failure after a proven burn is resumable', () => {
  it('liquidity 0 and a readable receipt -> ok, with the exact measured USDG AND TOKEN proceeds (H1: both from the SAME receipt)', async () => {
    const position = makeExitTestPosition({ status: 'CLOSING' });
    const reader = vi.fn(async (_hash: `0x${string}`, token: Address) =>
      token.toLowerCase() === config.quoteAsset.ADDRESS.toLowerCase() ? USDG(480) : 7n * 10n ** 17n,
    );
    const { deps } = makeDeps(0n, reader);
    const result = await deps.verifyOnChain(HASH);
    expect(result).toEqual({ ok: true, data: { liquidityZero: true, usdgProceedsRaw: USDG(480), tokenProceedsRaw: 7n * 10n ** 17n } });
    expect(reader).toHaveBeenCalledWith(HASH, config.quoteAsset.ADDRESS, WALLET);
    expect(reader).toHaveBeenCalledWith(HASH, position.tokenAddress, WALLET);
  });

  it('H1: a USDG-only burn (one-sided position never traded into range) records tokenProceedsRaw = 0n from the receipt -- proven, not inferred from a live balance', async () => {
    const reader = vi.fn(async (_hash: `0x${string}`, token: Address) => (token.toLowerCase() === config.quoteAsset.ADDRESS.toLowerCase() ? USDG(500) : 0n));
    const { deps } = makeDeps(0n, reader);
    const result = await deps.verifyOnChain(HASH);
    expect(result).toEqual({ ok: true, data: { liquidityZero: true, usdgProceedsRaw: USDG(500), tokenProceedsRaw: 0n } });
  });

  it('H1: a TOKEN-proceeds read failure after a proven burn is resumable too (never a definitive failure over a burned LP)', async () => {
    const reader = vi.fn(async (_hash: `0x${string}`, token: Address) => {
      if (token.toLowerCase() === config.quoteAsset.ADDRESS.toLowerCase()) return USDG(500);
      throw new Error('RPC timeout');
    });
    const { deps } = makeDeps(0n, reader);
    const result = await deps.verifyOnChain(HASH);
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.resumable).toBe(true);
  });

  it('liquidity 0 but the proceeds read throws -> ok:false with resumable:true (the burn is already proven)', async () => {
    const readUsdgTransfersTo = vi.fn(async () => { throw new Error('RPC timeout'); });
    const { deps } = makeDeps(0n, readUsdgTransfersTo);

    const result = await deps.verifyOnChain(HASH);

    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.resumable).toBe(true);
      expect(result.reason).toMatch(/burn verified but proceeds could not be measured: RPC timeout/);
    }
    expect(readUsdgTransfersTo).toHaveBeenCalledWith(HASH, expect.any(String), WALLET);
  });

  it('liquidity still non-zero -> definitive failure (no resumable flag), proceeds never read', async () => {
    const readUsdgTransfersTo = vi.fn(async () => USDG(480));
    const { deps } = makeDeps(5n, readUsdgTransfersTo);

    const result = await deps.verifyOnChain(HASH);

    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.resumable).toBeUndefined();
    expect(readUsdgTransfersTo).not.toHaveBeenCalled();
  });
});
