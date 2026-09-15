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

describe('buildRemoveLiquidityDeps.verifyOnChain -- P1: proceeds-read failure after a proven burn is resumable', () => {
  it('liquidity 0 and a readable receipt -> ok, with the exact measured proceeds', async () => {
    const { deps } = makeDeps(0n, vi.fn(async () => USDG(480)));
    const result = await deps.verifyOnChain(HASH);
    expect(result).toEqual({ ok: true, data: { liquidityZero: true, usdgProceedsRaw: USDG(480) } });
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
