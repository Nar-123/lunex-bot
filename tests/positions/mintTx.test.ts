import { describe, expect, it, vi } from 'vitest';
import type { Address } from 'viem';
import { buildMintDeps } from '../../src/positions/mintTx';
import { MintedTokenIdNotFoundError } from '../../src/blockchain/erc721';
import type { MintInput } from '../../src/positions/mintTx';
import { v3TickMathUtils } from '../../src/blockchain/uniswapSdk';
import type { LivePositionStateProvider, PoolPriceProvider } from '../../src/monitoring/types';

const { TickMath } = v3TickMathUtils;
const WALLET = '0x9999999999999999999999999999999999999999' as Address;
const DUMMY_HASH = '0xaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa' as `0x${string}`;
// Matches tests/setup.ts's fixture USDG address.
const USDG_ADDR = '0x2222222222222222222222222222222222222222';
const TOKEN_ADDR = '0x0000000000000000000000000000000000000002'; // sorts before USDG -> currency0=TOKEN

function sqrtAt(tick: number): bigint {
  return BigInt(TickMath.getSqrtRatioAtTick(tick).toString());
}

function makeMintInput(overrides: Partial<MintInput> = {}): MintInput {
  return {
    tokenAddress: TOKEN_ADDR as Address,
    tokenSymbol: 'MEME',
    tokenDecimals: 18,
    pool: {
      poolId: '0xaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa',
      currency0: TOKEN_ADDR as Address,
      currency1: USDG_ADDR as Address,
      fee: 30000,
      tickSpacing: 60,
      hooks: '0x0000000000000000000000000000000000000000' as Address,
    },
    tickLower: -6960,
    tickUpper: -60,
    entryUsdgRaw: 1_000n * 10n ** 18n,
    ...overrides,
  };
}

function makePoolPrice(tick = 0): PoolPriceProvider {
  return { getPriceState: vi.fn(async () => ({ sqrtPriceX96: sqrtAt(tick), tickCurrent: tick })) };
}

describe('buildMintDeps', () => {
  it('buildTransaction targets the configured PositionManager with nonzero calldata and zero value (USDG is never native)', async () => {
    const deps = buildMintDeps(makeMintInput(), { getLiveState: vi.fn() }, makePoolPrice(), {
      walletAddress: WALLET,
      ensureBinding: vi.fn(async () => undefined),
    });
    const tx = await deps.buildTransaction();
    expect(tx.value).toBe(0n);
    expect(tx.data.length).toBeGreaterThan(10);
    expect(tx.data.startsWith('0x')).toBe(true);
  });

  it('buildTransaction reads a FRESH live price every call, not a cached/stale one', async () => {
    const poolPrice = makePoolPrice(0);
    const deps = buildMintDeps(makeMintInput(), { getLiveState: vi.fn() }, poolPrice, {
      walletAddress: WALLET,
      ensureBinding: vi.fn(async () => undefined),
    });
    await deps.buildTransaction();
    expect(poolPrice.getPriceState).toHaveBeenCalledTimes(1);
  });

  it('buildTransaction runs the PositionManager binding self-check before building calldata, and fails loudly if it rejects', async () => {
    const ensureBinding = vi.fn(async () => { throw new Error('Config mismatch: PositionManager contract is bound to PoolManager 0xWRONG'); });
    const deps = buildMintDeps(makeMintInput(), { getLiveState: vi.fn() }, makePoolPrice(), { walletAddress: WALLET, ensureBinding });
    await expect(deps.buildTransaction()).rejects.toThrow(/Config mismatch/);
    expect(ensureBinding).toHaveBeenCalledTimes(1);
  });

  describe('verifyOnChain', () => {
    it('discovers the tokenId via the injected lookup and confirms it against live liquidity', async () => {
      const discoverTokenId = vi.fn(async () => 42n);
      const livePositionState: LivePositionStateProvider = { getLiveState: vi.fn(async () => ({ liquidity: 123n, tokensOwed0: 0n, tokensOwed1: 0n })) };
      const deps = buildMintDeps(makeMintInput(), livePositionState, makePoolPrice(), { walletAddress: WALLET, discoverTokenId });

      const result = await deps.verifyOnChain(DUMMY_HASH);

      expect(discoverTokenId).toHaveBeenCalledWith(DUMMY_HASH, expect.any(String), WALLET);
      expect(result).toEqual({ ok: true, data: { positionTokenId: '42', liquidity: 123n } });
    });

    it('passes the discovered tokenId through to the live-state read (as a string)', async () => {
      let receivedTokenId: string | null = null;
      const livePositionState: LivePositionStateProvider = {
        getLiveState: vi.fn(async (position) => {
          receivedTokenId = position.positionTokenId;
          return { liquidity: 1n, tokensOwed0: 0n, tokensOwed1: 0n };
        }),
      };
      const deps = buildMintDeps(makeMintInput(), livePositionState, makePoolPrice(), {
        walletAddress: WALLET,
        discoverTokenId: vi.fn(async () => 777n),
      });
      await deps.verifyOnChain(DUMMY_HASH);
      expect(receivedTokenId).toBe('777');
    });

    it('fails verification when liquidity reads 0 (mint technically confirmed on-chain but produced no real liquidity)', async () => {
      const livePositionState: LivePositionStateProvider = { getLiveState: vi.fn(async () => ({ liquidity: 0n, tokensOwed0: 0n, tokensOwed1: 0n })) };
      const deps = buildMintDeps(makeMintInput(), livePositionState, makePoolPrice(), {
        walletAddress: WALLET,
        discoverTokenId: vi.fn(async () => 1n),
      });
      const result = await deps.verifyOnChain(DUMMY_HASH);
      expect(result.ok).toBe(false);
    });

    it('fails verification DEFINITIVELY only for MintedTokenIdNotFoundError -- a genuine on-chain fact (receipt has no Transfer log for us)', async () => {
      const deps = buildMintDeps(makeMintInput(), { getLiveState: vi.fn() }, makePoolPrice(), {
        walletAddress: WALLET,
        discoverTokenId: vi.fn(async () => {
          throw new MintedTokenIdNotFoundError(DUMMY_HASH, '0x0000000000000000000000000000000000000009', WALLET);
        }),
      });
      const result = await deps.verifyOnChain(DUMMY_HASH);
      expect(result.ok).toBe(false);
      if (!result.ok) expect(result.reason).toMatch(/could not discover minted tokenId/);
    });

    describe('C2 regression: transient RPC/transport errors must NEVER be classified as a definitive verification failure', () => {
      const transientErrors = [
        ['RPC timeout', new Error('RPC timeout')],
        ['429 rate limited', new Error('HTTP 429: Too Many Requests')],
        ['500 server error', new Error('HTTP 500: Internal Server Error')],
        ['connection reset', new Error('ECONNRESET')],
        ['CALL_EXCEPTION from provider', Object.assign(new Error('missing revert data'), { code: 'CALL_EXCEPTION' })],
      ] as const;

      for (const [label, err] of transientErrors) {
        it(`${label}: verifyOnChain THROWS (never returns ok:false) -- receipt already confirmed the mint mined`, async () => {
          const deps = buildMintDeps(makeMintInput(), { getLiveState: vi.fn() }, makePoolPrice(), {
            walletAddress: WALLET,
            discoverTokenId: vi.fn(async () => { throw err; }),
          });
          // A propagated throw is exactly what lets executeCriticalTransaction's
          // outer catch treat this as ambiguous/resumable instead of
          // VERIFICATION_FAILED -- see executeCriticalTransaction.ts.
          await expect(deps.verifyOnChain(DUMMY_HASH)).rejects.toThrow();
        });
      }
    });
  });
});
