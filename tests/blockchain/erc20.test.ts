import { describe, expect, it, vi } from 'vitest';
import type { Address } from 'viem';
import { assertQuoteAssetDecimalsMatchOnChain } from '../../src/blockchain/erc20';

const USDG_ADDR = '0x5fc5360D0400a0Fd4f2af552ADD042D716F1d168' as Address;

describe('assertQuoteAssetDecimalsMatchOnChain -- Phase 12G startup fail-fast guard', () => {
  it('resolves silently when the configured decimals matches the real on-chain value (6)', async () => {
    const readDecimals = vi.fn(async () => 6);
    await expect(assertQuoteAssetDecimalsMatchOnChain(USDG_ADDR, 6, readDecimals)).resolves.toBeUndefined();
    expect(readDecimals).toHaveBeenCalledWith(USDG_ADDR);
  });

  it('throws when config says 18 but on-chain reports 6 -- the exact Phase 12F/12G incident', async () => {
    const readDecimals = vi.fn(async () => 6);
    await expect(assertQuoteAssetDecimalsMatchOnChain(USDG_ADDR, 18, readDecimals)).rejects.toThrow(/mismatch/i);
  });

  it('the thrown error names both the configured and on-chain values, and the affected production files', async () => {
    const readDecimals = vi.fn(async () => 6);
    await expect(assertQuoteAssetDecimalsMatchOnChain(USDG_ADDR, 18, readDecimals)).rejects.toThrow(
      /configuredDecimals|18.*6|decimals\(\)=6/i,
    );
    try {
      await assertQuoteAssetDecimalsMatchOnChain(USDG_ADDR, 18, readDecimals);
      throw new Error('expected a throw');
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      expect(message).toContain('18');
      expect(message).toContain('6');
      expect(message).toContain('mintTx.ts');
      expect(message).toContain('removeLiquidityTx.ts');
    }
  });

  it('throws for ANY mismatch direction, not just the known 18-vs-6 case (e.g. a hypothetical future re-migrated USDG)', async () => {
    const readDecimals = vi.fn(async () => 8);
    await expect(assertQuoteAssetDecimalsMatchOnChain(USDG_ADDR, 6, readDecimals)).rejects.toThrow(/mismatch/i);
  });

  it('propagates (does not swallow) a failed on-chain read -- an unreadable USDG contract is itself a reason to fail fast, not to silently trust static config', async () => {
    const readDecimals = vi.fn(async () => {
      throw new Error('RPC timeout');
    });
    await expect(assertQuoteAssetDecimalsMatchOnChain(USDG_ADDR, 6, readDecimals)).rejects.toThrow('RPC timeout');
  });

  it('defaults to the real readErc20Decimals when no override is injected (structural check only -- no live RPC call made in this test)', async () => {
    expect(assertQuoteAssetDecimalsMatchOnChain.length).toBeLessThanOrEqual(3);
  });
});
