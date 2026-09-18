import { describe, expect, it, vi } from 'vitest';
import type { Address } from 'viem';
import { buildMintDeps, buildMintV4Position, validateMintPriceFreshness } from '../../src/positions/mintTx';
import { MintedTokenIdNotFoundError } from '../../src/blockchain/erc721';
import type { MintInput } from '../../src/positions/mintTx';
import { v3TickMathUtils } from '../../src/blockchain/uniswapSdk';
import type { LivePositionStateProvider, PoolPriceProvider } from '../../src/monitoring/types';
import { config } from '../../src/config';

const { TickMath } = v3TickMathUtils;
const WALLET = '0x9999999999999999999999999999999999999999' as Address;
const DUMMY_HASH = '0xaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa' as `0x${string}`;
// Matches tests/setup.ts's fixture USDG address.
const USDG_ADDR = '0x2222222222222222222222222222222222222222';
const TOKEN_ADDR = '0x0000000000000000000000000000000000000002'; // sorts before USDG -> currency0=TOKEN
const TOKEN_ADDR_HIGH = '0xffffffffffffffffffffffffffffffffffffffff'; // sorts after USDG -> currency1=TOKEN, currency0=USDG

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

/** P1-9: a `getPoolAndPositionInfo` stub whose PoolKey matches `makeMintInput()`'s default pool exactly -- the "identity confirmed" case every pre-existing verifyOnChain test wants, so the identity check added in this fix never interferes with what those tests are actually asserting. */
function matchingPoolKey(input: MintInput = makeMintInput()) {
  return { currency0: input.pool.currency0, currency1: input.pool.currency1, fee: input.pool.fee, tickSpacing: input.pool.tickSpacing, hooks: input.pool.hooks };
}

describe('buildMintV4Position -- Phase 12G: USDG Token decimals must match config.quoteAsset.DECIMALS (6), never a hardcoded/stale value', () => {
  it('the constructed USDG-side Token carries exactly config.quoteAsset.DECIMALS (6, not 18)', () => {
    expect(config.quoteAsset.DECIMALS).toBe(6);
    // TOKEN_ADDR sorts before USDG_ADDR -> currency0=TOKEN, currency1=USDG (see makeMintInput's pool fixture).
    const position = buildMintV4Position(makeMintInput(), sqrtAt(0), 0);
    expect(position.pool.currency1.decimals).toBe(config.quoteAsset.DECIMALS);
    expect(position.pool.currency1.decimals).toBe(6);
  });

  it('the OTHER (non-USDG) token keeps its own real decimals, unaffected by the USDG fix -- token ordering/decimals independence', () => {
    const position = buildMintV4Position(makeMintInput({ tokenDecimals: 9 }), sqrtAt(0), 0);
    expect(position.pool.currency0.decimals).toBe(9);
    expect(position.pool.currency1.decimals).toBe(6);
  });

  it('raw entryUsdgRaw drives the SDK liquidity math at its own raw magnitude -- decimals never multiplies/divides it into a 10^12-off amount', () => {
    // usdgIsCurrency0 is false in this fixture (TOKEN sorts first), so the
    // USDG-only deposit goes through fromAmount1. The v3-sdk liquidity
    // round-trip (raw amount -> liquidity -> amount1) can legitimately
    // round DOWN by a few wei -- asserted with a small tolerance, not exact
    // equality -- but a decimals-driven bug here would be off by a factor
    // of 10^12 (~1_000_000_000_000x), impossible to mistake for rounding.
    const rawAmount = 1_000_000n * 10n ** 6n; // 1,000,000 USDG at the REAL 6-decimal scale
    const position = buildMintV4Position(makeMintInput({ entryUsdgRaw: rawAmount }), sqrtAt(0), 0);
    const resultRaw = BigInt(position.amount1.quotient.toString());
    const diff = resultRaw > rawAmount ? resultRaw - rawAmount : rawAmount - resultRaw;
    expect(diff).toBeLessThan(1_000_000n); // generous rounding tolerance, still 15+ orders of magnitude below a 10^12 scaling bug
  });
});

describe('validateMintPriceFreshness -- P0-4: pure function, both range orientations, both movement directions', () => {
  describe('Case A (usdgIsCurrency0=false): one-sided range sits AT/BELOW the T1 tick -- valid only while fresh tick stays AT/ABOVE tickUpper', () => {
    const tickLower = -6960;
    const tickUpper = -60;

    it('fresh tick unchanged (still far above tickUpper) -> compatible', () => {
      expect(validateMintPriceFreshness({ freshTickCurrent: 0, tickLower, tickUpper, usdgIsCurrency0: false })).toEqual({ ok: true });
    });

    it('fresh tick at exactly tickUpper (boundary, inclusive) -> still compatible', () => {
      expect(validateMintPriceFreshness({ freshTickCurrent: tickUpper, tickLower, tickUpper, usdgIsCurrency0: false })).toEqual({ ok: true });
    });

    it('fresh tick one below tickUpper (price fell into the range) -> INCOMPATIBLE', () => {
      const result = validateMintPriceFreshness({ freshTickCurrent: tickUpper - 1, tickLower, tickUpper, usdgIsCurrency0: false });
      expect(result.ok).toBe(false);
      if (!result.ok) expect(result.reason).toMatch(/stale/i);
    });

    it('fresh tick has risen further away (positive movement, still compatible)', () => {
      expect(validateMintPriceFreshness({ freshTickCurrent: 5000, tickLower, tickUpper, usdgIsCurrency0: false })).toEqual({ ok: true });
    });

    it('fresh tick fell deep past tickLower too (large negative movement) -> INCOMPATIBLE', () => {
      expect(validateMintPriceFreshness({ freshTickCurrent: -8000, tickLower, tickUpper, usdgIsCurrency0: false }).ok).toBe(false);
    });
  });

  describe('Case B (usdgIsCurrency0=true): one-sided range sits AT/ABOVE the T1 tick -- valid only while fresh tick stays BELOW tickLower', () => {
    const tickLower = 60;
    const tickUpper = 6960;

    it('fresh tick unchanged (still far below tickLower) -> compatible', () => {
      expect(validateMintPriceFreshness({ freshTickCurrent: 0, tickLower, tickUpper, usdgIsCurrency0: true })).toEqual({ ok: true });
    });

    it('fresh tick one below tickLower (boundary -1, still compatible)', () => {
      expect(validateMintPriceFreshness({ freshTickCurrent: tickLower - 1, tickLower, tickUpper, usdgIsCurrency0: true })).toEqual({ ok: true });
    });

    it('fresh tick at exactly tickLower (price rose into the range) -> INCOMPATIBLE', () => {
      const result = validateMintPriceFreshness({ freshTickCurrent: tickLower, tickLower, tickUpper, usdgIsCurrency0: true });
      expect(result.ok).toBe(false);
    });

    it('fresh tick has fallen further away (negative movement, still compatible)', () => {
      expect(validateMintPriceFreshness({ freshTickCurrent: -5000, tickLower, tickUpper, usdgIsCurrency0: true })).toEqual({ ok: true });
    });

    it('fresh tick rose deep past tickUpper too (large positive movement) -> INCOMPATIBLE', () => {
      expect(validateMintPriceFreshness({ freshTickCurrent: 8000, tickLower, tickUpper, usdgIsCurrency0: true }).ok).toBe(false);
    });
  });
});

describe('buildMintV4Position -- P0-4: end-to-end, aborts (throws) rather than minting a stale/incompatible one-sided range', () => {
  it('acceptance #1: fresh compatible price -> mint continues (no throw)', () => {
    expect(() => buildMintV4Position(makeMintInput(), sqrtAt(0), 0)).not.toThrow();
  });

  it('acceptance #2/#3: stale price that has moved into the range -> mint rejected (throws), never silently proceeds', () => {
    // Case A fixture (tickLower=-6960, tickUpper=-60): a fresh tick of -100 has fallen past tickUpper into the range.
    expect(() => buildMintV4Position(makeMintInput(), sqrtAt(-100), -100)).toThrow(/stale/i);
  });

  it('acceptance #5 (negative movement): a large fresh negative move past both boundaries is rejected', () => {
    expect(() => buildMintV4Position(makeMintInput(), sqrtAt(-8000), -8000)).toThrow(/stale/i);
  });

  it('acceptance #5 (positive movement, Case B orientation): a fresh price that rose into a Case B range is rejected', () => {
    const caseBInput = makeMintInput({
      pool: {
        poolId: '0xaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa',
        currency0: USDG_ADDR as Address,
        currency1: TOKEN_ADDR_HIGH as Address,
        fee: 30000,
        tickSpacing: 60,
        hooks: '0x0000000000000000000000000000000000000000' as Address,
      },
      tickLower: 60,
      tickUpper: 6960,
    });
    expect(() => buildMintV4Position(caseBInput, sqrtAt(100), 100)).toThrow(/stale/i);
    // A fresh price that stayed on the correct side still mints fine.
    expect(() => buildMintV4Position(caseBInput, sqrtAt(0), 0)).not.toThrow();
  });

  it('position cannot silently become two-sided because of price drift: an incompatible price never reaches Position construction at all', () => {
    // If the check were bypassed, `Position.fromAmount1` would still run
    // (proving the guard, not the SDK, is what stops this) -- asserted by
    // confirming the throw happens with the SAME message the pure
    // validator produces, i.e. genuinely from the freshness check.
    expect(() => buildMintV4Position(makeMintInput(), sqrtAt(-100), -100)).toThrow(
      /fresh tick -100 < tickUpper -60/,
    );
  });
});

describe('P1-10: mint slippage is bounded (100 bps), never 100% tolerance', () => {
  it('config.rules.lpStrategy.MINT_SLIPPAGE_BPS is the tight, already-vetted 100 bps (1%) tier -- not 10_000 (100%)', () => {
    expect(config.rules.lpStrategy.MINT_SLIPPAGE_BPS).toBe(100);
    expect(config.rules.lpStrategy.MINT_SLIPPAGE_BPS).not.toBe(10_000);
    // Matches EXITS.SLIPPAGE_TIERS_BPS's own tightest tier -- reused, not invented.
    expect(config.rules.lpStrategy.MINT_SLIPPAGE_BPS).toBe(config.rules.exits.SLIPPAGE_TIERS_BPS[0]);
  });

  it('the calldata for a bounded (100 bps) mint genuinely differs from the OLD 100%-tolerance encoding, at the SAME deadline -- proves the bound has real teeth, not just an unused constant', async () => {
    const { v4Sdk } = await import('../../src/blockchain/uniswapSdk');
    const { Percent } = await import('@uniswap/sdk-core');
    const sdkPosition = buildMintV4Position(makeMintInput(), sqrtAt(0), 0);
    const deadline = Math.floor(Date.now() / 1000) + 10 * 60; // held fixed for both calls -- isolates the comparison to slippageTolerance alone

    const bounded = v4Sdk.V4PositionManager.addCallParameters(sdkPosition, {
      recipient: WALLET,
      slippageTolerance: new Percent(config.rules.lpStrategy.MINT_SLIPPAGE_BPS, 10_000),
      deadline,
    });
    const oldStyle = v4Sdk.V4PositionManager.addCallParameters(sdkPosition, { recipient: WALLET, slippageTolerance: new Percent(1, 1), deadline });

    expect(bounded.calldata).not.toBe(oldStyle.calldata);
  });
});

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
      const deps = buildMintDeps(makeMintInput(), livePositionState, makePoolPrice(), { walletAddress: WALLET, discoverTokenId, getPoolAndPositionInfo: vi.fn(async () => matchingPoolKey()) });

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
        getPoolAndPositionInfo: vi.fn(async () => matchingPoolKey()),
      });
      await deps.verifyOnChain(DUMMY_HASH);
      expect(receivedTokenId).toBe('777');
    });

    it('fails verification when liquidity reads 0 (mint technically confirmed on-chain but produced no real liquidity)', async () => {
      const livePositionState: LivePositionStateProvider = { getLiveState: vi.fn(async () => ({ liquidity: 0n, tokensOwed0: 0n, tokensOwed1: 0n })) };
      const deps = buildMintDeps(makeMintInput(), livePositionState, makePoolPrice(), {
        walletAddress: WALLET,
        discoverTokenId: vi.fn(async () => 1n),
        getPoolAndPositionInfo: vi.fn(async () => matchingPoolKey()),
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
        getPoolAndPositionInfo: vi.fn(async () => matchingPoolKey()),
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
            getPoolAndPositionInfo: vi.fn(async () => matchingPoolKey()),
          });
          // A propagated throw is exactly what lets executeCriticalTransaction's
          // outer catch treat this as ambiguous/resumable instead of
          // VERIFICATION_FAILED -- see executeCriticalTransaction.ts.
          await expect(deps.verifyOnChain(DUMMY_HASH)).rejects.toThrow();
        });
      }

      it("getPoolAndPositionInfo itself throwing (RPC failure) THROWS (never returns ok:false) -- same discipline as discoverTokenId's transport failures", async () => {
        const deps = buildMintDeps(makeMintInput(), { getLiveState: vi.fn() }, makePoolPrice(), {
          walletAddress: WALLET,
          discoverTokenId: vi.fn(async () => 1n),
          getPoolAndPositionInfo: vi.fn(async () => { throw new Error('RPC timeout'); }),
        });
        await expect(deps.verifyOnChain(DUMMY_HASH)).rejects.toThrow();
      });
    });

    describe('P1-9: on-chain position identity (PoolKey) must match the pool this mint was built against', () => {
      it('succeeds when the on-chain PoolKey matches input.pool exactly', async () => {
        const livePositionState: LivePositionStateProvider = { getLiveState: vi.fn(async () => ({ liquidity: 5n, tokensOwed0: 0n, tokensOwed1: 0n })) };
        const deps = buildMintDeps(makeMintInput(), livePositionState, makePoolPrice(), {
          walletAddress: WALLET,
          discoverTokenId: vi.fn(async () => 9n),
          getPoolAndPositionInfo: vi.fn(async () => matchingPoolKey()),
        });
        const result = await deps.verifyOnChain(DUMMY_HASH);
        expect(result.ok).toBe(true);
      });

      it('fails DEFINITIVELY when the on-chain currency0/currency1 do not match input.pool -- never checked before this fix', async () => {
        const input = makeMintInput();
        const wrongKey = { ...matchingPoolKey(input), currency1: '0x999999999999999999999999999999999999999a' as Address };
        const deps = buildMintDeps(input, { getLiveState: vi.fn() }, makePoolPrice(), {
          walletAddress: WALLET,
          discoverTokenId: vi.fn(async () => 9n),
          getPoolAndPositionInfo: vi.fn(async () => wrongKey),
        });
        const result = await deps.verifyOnChain(DUMMY_HASH);
        expect(result.ok).toBe(false);
        if (!result.ok) expect(result.reason).toMatch(/pool currencies/);
      });

      it('fails DEFINITIVELY when the on-chain fee tier does not match input.pool', async () => {
        const input = makeMintInput();
        const wrongKey = { ...matchingPoolKey(input), fee: 500 };
        const deps = buildMintDeps(input, { getLiveState: vi.fn() }, makePoolPrice(), {
          walletAddress: WALLET,
          discoverTokenId: vi.fn(async () => 9n),
          getPoolAndPositionInfo: vi.fn(async () => wrongKey),
        });
        const result = await deps.verifyOnChain(DUMMY_HASH);
        expect(result.ok).toBe(false);
        if (!result.ok) expect(result.reason).toMatch(/pool fee/);
      });

      it('fails DEFINITIVELY when the on-chain hooks address does not match input.pool', async () => {
        const input = makeMintInput();
        const wrongKey = { ...matchingPoolKey(input), hooks: '0x1234567890123456789012345678901234567890' as Address };
        const deps = buildMintDeps(input, { getLiveState: vi.fn() }, makePoolPrice(), {
          walletAddress: WALLET,
          discoverTokenId: vi.fn(async () => 9n),
          getPoolAndPositionInfo: vi.fn(async () => wrongKey),
        });
        const result = await deps.verifyOnChain(DUMMY_HASH);
        expect(result.ok).toBe(false);
        if (!result.ok) expect(result.reason).toMatch(/pool hooks/);
      });

      it('the identity check runs BEFORE the liquidity read -- a mismatched identity is rejected even if liquidity would have read > 0', async () => {
        const input = makeMintInput();
        const wrongKey = { ...matchingPoolKey(input), tickSpacing: 10 };
        const getLiveState = vi.fn(async () => ({ liquidity: 999n, tokensOwed0: 0n, tokensOwed1: 0n }));
        const deps = buildMintDeps(input, { getLiveState }, makePoolPrice(), {
          walletAddress: WALLET,
          discoverTokenId: vi.fn(async () => 9n),
          getPoolAndPositionInfo: vi.fn(async () => wrongKey),
        });
        const result = await deps.verifyOnChain(DUMMY_HASH);
        expect(result.ok).toBe(false);
        if (!result.ok) expect(result.reason).toMatch(/tickSpacing/);
        expect(getLiveState).not.toHaveBeenCalled();
      });
    });
  });
});
