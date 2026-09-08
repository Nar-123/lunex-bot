import { describe, expect, it, vi } from 'vitest';
import type { Address } from 'viem';
import { buildApproveDeps, needsApproval } from '../../src/positions/approveTx';
import { config } from '../../src/config';

const WALLET = '0x9999999999999999999999999999999999999999' as Address;
const DUMMY_HASH = '0xaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa' as `0x${string}`;

describe('needsApproval', () => {
  it('true when current allowance is below the required amount', () => {
    expect(needsApproval(0n, 100n)).toBe(true);
  });

  it('false when current allowance exactly meets the required amount', () => {
    expect(needsApproval(100n, 100n)).toBe(false);
  });

  it('false when current allowance exceeds the required amount', () => {
    expect(needsApproval(1000n, 100n)).toBe(false);
  });
});

describe('buildApproveDeps (positions/ -- USDG to PositionManager)', () => {
  it('builds calldata targeting the USDG contract itself, approving the configured PositionManager', async () => {
    const deps = buildApproveDeps(500n, { readAllowance: vi.fn(async () => 500n), walletAddress: WALLET });
    const tx = await deps.buildTransaction();
    expect(tx.to).toBe(config.quoteAsset.ADDRESS.toLowerCase());
    expect(tx.value).toBe(0n);
    expect(tx.data.startsWith('0x095ea7b3')).toBe(true); // approve(address,uint256) selector
  });

  it('verifyOnChain checks allowance for (USDG, our wallet, the PositionManager)', async () => {
    const readAllowance = vi.fn(async () => 500n);
    const deps = buildApproveDeps(500n, { readAllowance, walletAddress: WALLET });
    await deps.verifyOnChain(DUMMY_HASH);
    expect(readAllowance).toHaveBeenCalledWith(config.quoteAsset.ADDRESS.toLowerCase(), WALLET, config.uniswap.v4.positionManager.toLowerCase());
  });

  it('verifyOnChain passes once on-chain allowance meets the requested amount', async () => {
    const deps = buildApproveDeps(500n, { readAllowance: vi.fn(async () => 500n), walletAddress: WALLET });
    const result = await deps.verifyOnChain(DUMMY_HASH);
    expect(result).toEqual({ ok: true, data: { allowanceRaw: 500n } });
  });

  it('verifyOnChain fails when on-chain allowance is still insufficient', async () => {
    const deps = buildApproveDeps(500n, { readAllowance: vi.fn(async () => 100n), walletAddress: WALLET });
    const result = await deps.verifyOnChain(DUMMY_HASH);
    expect(result.ok).toBe(false);
  });
});
