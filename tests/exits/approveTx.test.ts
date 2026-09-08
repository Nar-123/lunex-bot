import { describe, expect, it, vi } from 'vitest';
import type { Address } from 'viem';
import { buildApproveDeps, needsApproval } from '../../src/exits/approveTx';

const TOKEN = '0x0000000000000000000000000000000000000002' as Address;
const SPENDER = '0x3333333333333333333333333333333333333333' as Address;
const WALLET = '0x9999999999999999999999999999999999999999' as Address;

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

describe('buildApproveDeps', () => {
  it('builds calldata targeting the TOKEN contract itself (not the spender)', async () => {
    const deps = buildApproveDeps(TOKEN, SPENDER, 500n, { readAllowance: vi.fn(async () => 500n), walletAddress: WALLET });
    const tx = await deps.buildTransaction();
    expect(tx.to).toBe(TOKEN);
    expect(tx.value).toBe(0n);
    expect(tx.data.startsWith('0x095ea7b3')).toBe(true); // approve(address,uint256) selector
  });

  it('verifyOnChain passes once on-chain allowance meets the requested amount', async () => {
    const deps = buildApproveDeps(TOKEN, SPENDER, 500n, { readAllowance: vi.fn(async () => 500n), walletAddress: WALLET });
    const result = await deps.verifyOnChain('0xaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa' as `0x${string}`);
    expect(result).toEqual({ ok: true, data: { allowanceRaw: 500n } });
  });

  it('verifyOnChain fails when on-chain allowance is still insufficient', async () => {
    const deps = buildApproveDeps(TOKEN, SPENDER, 500n, { readAllowance: vi.fn(async () => 100n), walletAddress: WALLET });
    const result = await deps.verifyOnChain('0xaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa' as `0x${string}`);
    expect(result.ok).toBe(false);
  });

  it('verifyOnChain reads allowance for (token, our wallet, the given spender)', async () => {
    const readAllowance = vi.fn(async () => 500n);
    const deps = buildApproveDeps(TOKEN, SPENDER, 500n, { readAllowance, walletAddress: WALLET });
    await deps.verifyOnChain('0xaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa' as `0x${string}`);
    expect(readAllowance).toHaveBeenCalledWith(TOKEN, WALLET, SPENDER);
  });
});
