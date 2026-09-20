import { describe, expect, it, vi } from 'vitest';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import type { Address } from 'viem';
import { evaluatePermit2Preflight, runPermit2Preflight, type Permit2PreflightInput } from '../../src/positions/permit2Preflight';
import { config } from '../../src/config';

/**
 * Permit2 expiry/authorization audit (required cases 17-30).
 *
 * Every judgement is made against CHAIN time supplied by the caller, never the
 * local clock, and every unusable answer fails closed. Nothing here sends,
 * signs or renews anything -- there is no write path to test.
 */
const PERMIT2 = config.uniswap.v4.permit2 as Address;
const POSITION_MANAGER = config.uniswap.v4.positionManager as Address;
const USDG = config.quoteAsset.ADDRESS as Address;
const WALLET = '0x65299018ABAaa6bD89aabF689dbEf21Be99ef1Ea' as Address;
const OTHER = '0x1111111111111111111111111111111111111111' as Address;
const UINT160_MAX = 2n ** 160n - 1n;
const NOW = 1_789_900_000; // chain time (unix seconds)
const REQUIRED = 20_906_915n;
const WARN = config.rules.execution.PERMIT2_EXPIRY_WARNING_SECONDS; // 7 days
const BLOCK = config.rules.execution.PERMIT2_MIN_REMAINING_VALIDITY_SECONDS; // 30 min

function input(o: Partial<Permit2PreflightInput> = {}): Permit2PreflightInput {
  return {
    configuredPermit2: PERMIT2,
    positionManagerPermit2: PERMIT2,
    positionManagerPermit2Spender: POSITION_MANAGER,
    readFor: { owner: WALLET, token: USDG, spender: POSITION_MANAGER },
    expectedOwner: WALLET,
    expectedToken: USDG,
    erc20AllowanceToPermit2: 2n ** 200n,
    grant: { amount: UINT160_MAX, expiration: NOW + 30 * 86_400, nonce: 2 },
    requiredAmount: REQUIRED,
    chainTimestamp: NOW,
    minRemainingValiditySeconds: BLOCK,
    expiryWarningSeconds: WARN,
    ...o,
  };
}
const at = (secondsLeft: number) => input({ grant: { amount: UINT160_MAX, expiration: NOW + secondsLeft, nonce: 2 } });

describe('Permit2 authorization states (17-20, 24-27)', () => {
  it('17. a valid grant is deployable with no approval needed', () => {
    expect(evaluatePermit2Preflight(input())).toMatchObject({ status: 'VALID', deployable: true, needsErc20Approval: false });
  });

  it('18. insufficient ERC20 allowance to Permit2 -> deployable via the approve leg', () => {
    expect(evaluatePermit2Preflight(input({ erc20AllowanceToPermit2: REQUIRED - 1n }))).toMatchObject({ status: 'INSUFFICIENT_ALLOWANCE', deployable: true, needsErc20Approval: true });
  });

  it('19. insufficient Permit2 grant -> blocked (never auto-raised)', () => {
    expect(evaluatePermit2Preflight(input({ grant: { amount: REQUIRED - 1n, expiration: NOW + 86_400, nonce: 1 } }))).toMatchObject({ status: 'INSUFFICIENT_PERMIT2_GRANT', deployable: false });
  });

  it('20. an expired grant is blocked (never treated as valid)', () => {
    expect(evaluatePermit2Preflight(at(-1))).toMatchObject({ status: 'EXPIRED', deployable: false });
  });

  it('24. a PositionManager bound to a different Permit2 is blocked', () => {
    expect(evaluatePermit2Preflight(input({ positionManagerPermit2: OTHER }))).toMatchObject({ status: 'WRONG_SPENDER', deployable: false });
  });

  it('24b. a grant read for a DIFFERENT spender than the settlement uses is blocked', () => {
    const r = evaluatePermit2Preflight(input({ readFor: { owner: WALLET, token: USDG, spender: OTHER } }));
    expect(r).toMatchObject({ status: 'WRONG_SPENDER', deployable: false });
    expect(r.reason).toMatch(/read for spender/);
  });

  it('25. state read for the WRONG TOKEN is never trusted', () => {
    const r = evaluatePermit2Preflight(input({ readFor: { owner: WALLET, token: OTHER, spender: POSITION_MANAGER } }));
    expect(r).toMatchObject({ status: 'UNAVAILABLE', deployable: false });
    expect(r.reason).toMatch(/token .* != expected/);
  });

  it('26. state read for the WRONG OWNER is never trusted', () => {
    const r = evaluatePermit2Preflight(input({ readFor: { owner: OTHER, token: USDG, spender: POSITION_MANAGER } }));
    expect(r).toMatchObject({ status: 'UNAVAILABLE', deployable: false });
    expect(r.reason).toMatch(/owner .* != expected/);
  });

  it('27. a read failure rejects -- it is never silently treated as valid or as "no grant"', async () => {
    for (const failing of ['readPositionManagerPermit2', 'readErc20Allowance', 'readPermit2Grant', 'readChainTimestamp'] as const) {
      const readers = {
        readPositionManagerPermit2: vi.fn(async () => PERMIT2),
        readErc20Allowance: vi.fn(async () => 2n ** 200n),
        readPermit2Grant: vi.fn(async () => ({ amount: UINT160_MAX, expiration: NOW + 86_400, nonce: 1 })),
        readChainTimestamp: vi.fn(async () => NOW),
        walletAddress: WALLET,
      };
      (readers as Record<string, unknown>)[failing] = vi.fn(async () => { throw new Error('rpc down'); });
      await expect(runPermit2Preflight(REQUIRED, readers)).rejects.toThrow('rpc down');
    }
  });
});

describe('expiry window boundaries (21-23, 28)', () => {
  it('1. far from expiry: valid, no warning', () => {
    const r = evaluatePermit2Preflight(at(30 * 86_400));
    expect(r.status).toBe('VALID');
    expect(r.expiringSoon).toBe(false);
  });

  it('2/3. exactly at the warning boundary warns; one second more does not', () => {
    expect(evaluatePermit2Preflight(at(WARN)).expiringSoon).toBe(true);
    expect(evaluatePermit2Preflight(at(WARN + 1)).expiringSoon).toBe(false);
    expect(evaluatePermit2Preflight(at(WARN - 1)).expiringSoon).toBe(true); // just inside
    expect(evaluatePermit2Preflight(at(WARN - 1)).deployable).toBe(true); // warning never blocks
  });

  it('4/5. exactly at the block window blocks; one second more still deploys', () => {
    expect(evaluatePermit2Preflight(at(BLOCK - 1))).toMatchObject({ status: 'EXPIRED', deployable: false });
    expect(evaluatePermit2Preflight(at(BLOCK))).toMatchObject({ status: 'VALID', deployable: true });
    expect(evaluatePermit2Preflight(at(60))).toMatchObject({ status: 'EXPIRED', deployable: false }); // just before expiry
  });

  it('6/7. the exact expiry second and just after (with no margin) follow the contract: usable AT, dead AFTER', () => {
    const noMargin = { minRemainingValiditySeconds: 0 };
    expect(evaluatePermit2Preflight({ ...at(0), ...noMargin }).status).toBe('VALID');
    expect(evaluatePermit2Preflight({ ...at(-1), ...noMargin }).status).toBe('EXPIRED');
  });

  it('28. judged on CHAIN time: the local clock cannot make an expired grant look valid, or a valid one look expired', () => {
    vi.useFakeTimers();
    try {
      vi.setSystemTime(new Date('2000-01-01T00:00:00Z')); // local clock far in the past
      expect(evaluatePermit2Preflight(at(-1)).status).toBe('EXPIRED');
      vi.setSystemTime(new Date('2999-01-01T00:00:00Z')); // local clock far in the future
      expect(evaluatePermit2Preflight(at(30 * 86_400)).status).toBe('VALID');
    } finally {
      vi.useRealTimers();
    }
  });

  it('a chain timestamp that moves forward flips the same grant from valid to blocked', () => {
    const grant = { amount: UINT160_MAX, expiration: NOW + 3600, nonce: 2 };
    expect(evaluatePermit2Preflight(input({ grant, chainTimestamp: NOW })).status).toBe('VALID');
    expect(evaluatePermit2Preflight(input({ grant, chainTimestamp: NOW + 3600 - BLOCK + 1 })).status).toBe('EXPIRED');
  });
});

describe('30. no automatic renewal exists anywhere in the Permit2 path', () => {
  const root = path.resolve(__dirname, '../..');
  /** Comments explain what the operator must do by hand; only executable code is audited here. */
  const stripComments = (t: string): string => t.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');
  const sources = ['src/positions/permit2Preflight.ts', 'src/blockchain/permit2.ts'].map((f) => ({ f, text: stripComments(readFileSync(path.join(root, f), 'utf8')) }));

  it('the Permit2 modules contain no approve/permit encoding and no transaction construction', () => {
    for (const { f, text } of sources) {
      expect(text, f).not.toMatch(/encodeFunctionData|encodeErc20Approve|writeContract|sendTransaction|signTypedData|permitTransferFrom|\.approve\(/);
    }
  });

  it('their ABIs are read-only views', () => {
    for (const { f, text } of sources) {
      const nonView = text.match(/stateMutability:\s*'(nonpayable|payable)'/g);
      expect(nonView, f).toBeNull();
    }
  });

  it('a grant that is expired or too small is REPORTED, never repaired', () => {
    for (const r of [evaluatePermit2Preflight(at(-1)), evaluatePermit2Preflight(input({ grant: { amount: 1n, expiration: NOW + 86_400, nonce: 1 } }))]) {
      expect(r.deployable).toBe(false);
      expect(r.needsErc20Approval).toBe(false); // the only approval this flow can ever request is the ERC20 one to Permit2
      expect(r.reason).toMatch(/operator must/);
    }
  });
});
