import { describe, expect, it, vi } from 'vitest';
import type { Address } from 'viem';
import { decodeFunctionData, parseAbi } from 'viem';
import { evaluatePermit2Preflight, isPermit2GrantExpired, runPermit2Preflight, type Permit2PreflightInput } from '../../src/positions/permit2Preflight';
import { buildApproveDeps as buildExitApproveDeps } from '../../src/exits/approveTx';
import { config } from '../../src/config';

const PERMIT2 = '0x000000000022D473030F116dDEE9F6B43aC78BA3' as Address;
const OTHER = '0x1111111111111111111111111111111111111111' as Address;
const WALLET = '0x9999999999999999999999999999999999999999' as Address;
const UINT160_MAX = 2n ** 160n - 1n;
const NOW = 1_789_843_938; // chain time of the first live mint's deadline window
const REQUIRED = 20_906_915n; // the first live entry, raw USDG

function input(o: Partial<Permit2PreflightInput> = {}): Permit2PreflightInput {
  return {
    configuredPermit2: PERMIT2,
    positionManagerPermit2: PERMIT2,
    erc20AllowanceToPermit2: 2n ** 256n - 1n - 20_959_499_978n, // live post-mint value
    grant: { amount: UINT160_MAX, expiration: 1_790_871_926, nonce: 2 }, // live grant
    requiredAmount: REQUIRED,
    chainTimestamp: NOW,
    minRemainingValiditySeconds: 1800,
    expiryWarningSeconds: 7 * 86_400,
    ...o,
  };
}

describe('isPermit2GrantExpired -- Permit2 contract semantics (reverts iff block.timestamp > expiration)', () => {
  it('exact expiry boundary: usable AT the expiration second, expired one second later', () => {
    expect(isPermit2GrantExpired(1000, 999)).toBe(false);
    expect(isPermit2GrantExpired(1000, 1000)).toBe(false);
    expect(isPermit2GrantExpired(1000, 1001)).toBe(true);
  });
});

describe('evaluatePermit2Preflight', () => {
  it('VALID: the live production state (uint160-max grant, ~12 days left, ample ERC20 allowance to Permit2)', () => {
    const r = evaluatePermit2Preflight(input());
    expect(r).toMatchObject({ status: 'VALID', deployable: true, needsErc20Approval: false, expiringSoon: false, grantNonce: 2 });
    expect(r.secondsUntilExpiry).toBe(1_790_871_926 - NOW);
  });

  it('near expiry: still deployable but flagged expiringSoon (inside the warning window)', () => {
    const r = evaluatePermit2Preflight(input({ grant: { amount: UINT160_MAX, expiration: NOW + 3 * 86_400, nonce: 2 } }));
    expect(r).toMatchObject({ status: 'VALID', deployable: true, expiringSoon: true });
  });

  it('warning window boundary: exactly expiryWarningSeconds left is flagged, one second more is not', () => {
    const w = 7 * 86_400;
    expect(evaluatePermit2Preflight(input({ grant: { amount: UINT160_MAX, expiration: NOW + w, nonce: 2 } })).expiringSoon).toBe(true);
    expect(evaluatePermit2Preflight(input({ grant: { amount: UINT160_MAX, expiration: NOW + w + 1, nonce: 2 } })).expiringSoon).toBe(false);
  });

  it('expired authorization -> EXPIRED, not deployable -- never silently treated as valid', () => {
    const r = evaluatePermit2Preflight(input({ grant: { amount: UINT160_MAX, expiration: NOW - 1, nonce: 2 } }));
    expect(r).toMatchObject({ status: 'EXPIRED', deployable: false, needsErc20Approval: false });
    expect(r.secondsUntilExpiry).toBe(-1);
    expect(r.reason).toMatch(/grant for the PositionManager expired at .*chain time/); // operator sees "already expired", not "about to"
  });

  it('about-to-expire (inside the minimum validity) is reported distinctly from already-expired', () => {
    expect(evaluatePermit2Preflight(input({ grant: { amount: UINT160_MAX, expiration: NOW + 60, nonce: 2 } })).reason).toMatch(/expires at .*within the 1800s/);
  });

  it('a grant expiring within the minimum remaining validity (could lapse before the mint) is refused as EXPIRED', () => {
    expect(evaluatePermit2Preflight(input({ grant: { amount: UINT160_MAX, expiration: NOW + 1799, nonce: 2 } })).status).toBe('EXPIRED');
    expect(evaluatePermit2Preflight(input({ grant: { amount: UINT160_MAX, expiration: NOW + 1800, nonce: 2 } })).status).toBe('VALID');
  });

  it('exact boundary with no validity margin: expiration == chain time is still usable (contract semantics)', () => {
    expect(evaluatePermit2Preflight(input({ minRemainingValiditySeconds: 0, grant: { amount: UINT160_MAX, expiration: NOW, nonce: 1 } })).status).toBe('VALID');
    expect(evaluatePermit2Preflight(input({ minRemainingValiditySeconds: 0, grant: { amount: UINT160_MAX, expiration: NOW - 1, nonce: 1 } })).status).toBe('EXPIRED');
  });

  it('clock handling: judged against CHAIN time, not the local clock', () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2030-01-01T00:00:00Z')); // local clock far past the expiry
    try {
      expect(evaluatePermit2Preflight(input()).status).toBe('VALID');
    } finally {
      vi.useRealTimers();
    }
  });

  it('WRONG_SPENDER: PositionManager bound to a different Permit2 than configured -> refused (cannot silently pass)', () => {
    expect(evaluatePermit2Preflight(input({ positionManagerPermit2: OTHER }))).toMatchObject({ status: 'WRONG_SPENDER', deployable: false });
  });

  it('address comparison is case-insensitive (checksummed vs lowercase is the same spender)', () => {
    expect(evaluatePermit2Preflight(input({ positionManagerPermit2: PERMIT2.toLowerCase() as Address })).status).toBe('VALID');
  });

  it('no grant at all -> INSUFFICIENT_PERMIT2_GRANT (not auto-created)', () => {
    expect(evaluatePermit2Preflight(input({ grant: { amount: 0n, expiration: 0, nonce: 0 } }))).toMatchObject({ status: 'INSUFFICIENT_PERMIT2_GRANT', deployable: false });
  });

  it('grant amount below the required amount -> INSUFFICIENT_PERMIT2_GRANT (not auto-raised)', () => {
    expect(evaluatePermit2Preflight(input({ grant: { amount: REQUIRED - 1n, expiration: NOW + 86_400 * 30, nonce: 3 } }))).toMatchObject({ status: 'INSUFFICIENT_PERMIT2_GRANT', deployable: false });
    expect(evaluatePermit2Preflight(input({ grant: { amount: REQUIRED, expiration: NOW + 86_400 * 30, nonce: 3 } })).status).toBe('VALID');
  });

  it('insufficient ERC20 allowance to Permit2 -> INSUFFICIENT_ALLOWANCE: deployable via the approve(Permit2) leg', () => {
    expect(evaluatePermit2Preflight(input({ erc20AllowanceToPermit2: REQUIRED - 1n }))).toMatchObject({ status: 'INSUFFICIENT_ALLOWANCE', deployable: true, needsErc20Approval: true });
    expect(evaluatePermit2Preflight(input({ erc20AllowanceToPermit2: REQUIRED })).status).toBe('VALID');
  });

  it('an allowance to the PositionManager is irrelevant: the old spender cannot make an unusable Permit2 path pass', () => {
    // the live leftover 20,906,915 PositionManager allowance is not an input at all -- only the Permit2 path counts
    expect(evaluatePermit2Preflight(input({ erc20AllowanceToPermit2: 0n })).needsErc20Approval).toBe(true);
  });

  it('priority: wrong spender > expired > insufficient grant > insufficient allowance', () => {
    const all = input({ positionManagerPermit2: OTHER, grant: { amount: 1n, expiration: NOW - 5, nonce: 0 }, erc20AllowanceToPermit2: 0n });
    expect(evaluatePermit2Preflight(all).status).toBe('WRONG_SPENDER');
    expect(evaluatePermit2Preflight({ ...all, positionManagerPermit2: PERMIT2 }).status).toBe('EXPIRED');
    expect(evaluatePermit2Preflight({ ...all, positionManagerPermit2: PERMIT2, grant: { amount: 1n, expiration: NOW + 99_999, nonce: 0 } }).status).toBe('INSUFFICIENT_PERMIT2_GRANT');
  });
});

describe('runPermit2Preflight -- reads the right (owner, token, spender) tuples', () => {
  it('ERC20 allowance is read for spender=Permit2; the grant for (wallet, USDG, PositionManager); PositionManager.permit2() cross-checked', async () => {
    const readPositionManagerPermit2 = vi.fn(async () => config.uniswap.v4.permit2 as Address);
    const readErc20Allowance = vi.fn(async () => REQUIRED);
    const readPermit2Grant = vi.fn(async () => ({ amount: UINT160_MAX, expiration: NOW + 30 * 86_400, nonce: 2 }));
    const readChainTimestamp = vi.fn(async () => NOW);
    const r = await runPermit2Preflight(REQUIRED, { readPositionManagerPermit2, readErc20Allowance, readPermit2Grant, readChainTimestamp, walletAddress: WALLET });

    expect(r.status).toBe('VALID');
    expect(readPositionManagerPermit2).toHaveBeenCalledWith(config.uniswap.v4.positionManager);
    expect(readErc20Allowance).toHaveBeenCalledWith(config.quoteAsset.ADDRESS, WALLET, config.uniswap.v4.permit2);
    expect(readPermit2Grant).toHaveBeenCalledWith(config.uniswap.v4.permit2, WALLET, config.quoteAsset.ADDRESS, config.uniswap.v4.positionManager);
  });

  it('uses the on-chain expiry and chain timestamp (no hard-coded date)', async () => {
    const r = await runPermit2Preflight(REQUIRED, {
      readPositionManagerPermit2: async () => config.uniswap.v4.permit2 as Address,
      readErc20Allowance: async () => REQUIRED,
      readPermit2Grant: async () => ({ amount: UINT160_MAX, expiration: 5_000, nonce: 1 }),
      readChainTimestamp: async () => 5_001,
      walletAddress: WALLET,
    });
    expect(r.status).toBe('EXPIRED');
  });

  it('the shipped configuration uses the canonical Permit2 address', () => {
    expect(config.uniswap.v4.permit2.toLowerCase()).toBe(PERMIT2.toLowerCase());
  });
});

describe('unrelated approval flows are unchanged', () => {
  it('exit swap approvals still target the Trading API allowance target passed in -- NOT Permit2 (that flow runs with Permit2 disabled)', async () => {
    const deps = buildExitApproveDeps(OTHER, WALLET, 500n, { readAllowance: vi.fn(async () => 500n), walletAddress: WALLET });
    const { args } = decodeFunctionData({ abi: parseAbi(['function approve(address,uint256) returns (bool)']), data: (await deps.buildTransaction()).data });
    expect(args[0].toLowerCase()).toBe(WALLET.toLowerCase());
    expect(args[0].toLowerCase()).not.toBe(PERMIT2.toLowerCase());
  });
});
