import { describe, expect, it, vi } from 'vitest';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { decodeFunctionData, getAddress, type Address } from 'viem';
import { assessTokenGrant, exitSwapSpender, tokenGrantIdempotencyKey, type TokenGrantInput } from '../../src/exits/permit2TokenGrant';
import { buildTokenGrantDeps, runTokenGrantPreflight } from '../../src/exits/permit2GrantTx';
import { PERMIT2_APPROVE_ABI, renewalIdempotencyKey } from '../../src/positions/permit2Renewal';
import { config } from '../../src/config';
import { EXECUTION_TARGETS } from '../../src/config/constants';

/**
 * The exit-side Permit2 grant: (executor wallet, position TOKEN, approved
 * Universal Router). Distinct from -- and never allowed to touch -- the
 * operator-only USDG -> PositionManager grant.
 */
const UR = getAddress('0x8876789976dEcBfCbBbe364623C63652db8C0904');
const TARGETS = { chainId: 4663, universalRouters: [...EXECUTION_TARGETS[4663]!.universalRouters], swapProxies: [...EXECUTION_TARGETS[4663]!.swapProxies] };
const WALLET = getAddress('0x65299018ABAaa6bD89aabF689dbEf21Be99ef1Ea');
const TOKEN = getAddress('0x39dBED3a2bd333467115dE45665cC57F813C4571');
const OTHER = getAddress('0x1111111111111111111111111111111111111111');
const USDG = getAddress(config.quoteAsset.ADDRESS);
const PM = getAddress(config.uniswap.v4.positionManager);
const LEGACY = getAddress('0x02E5be68D46DAc0B524905bfF209cf47EE6dB2a9');
const NOW = 1_789_900_000;
const NEED = 14467199568916222n;
const G = config.rules.exits.PERMIT2_TOKEN_GRANT;

const input = (o: Partial<TokenGrantInput> = {}): TokenGrantInput => ({
  readFor: { owner: WALLET, token: TOKEN, spender: UR },
  expectedOwner: WALLET,
  expectedToken: TOKEN,
  spender: UR,
  targets: TARGETS,
  grant: { amount: 0n, expiration: 0, nonce: 0 }, // production today: no PONS -> UR grant exists
  requiredAmount: NEED,
  chainTimestamp: NOW,
  ...o,
});

describe('12-14. grant state decides whether an approval leg is needed', () => {
  it('12. an INSUFFICIENT grant produces an approval leg', () => {
    const r = assessTokenGrant(input({ grant: { amount: NEED - 1n, expiration: NOW + 86_400, nonce: 0 } }));
    expect(r).toMatchObject({ status: 'INSUFFICIENT', needsApproval: true });
    expect(r.approval).not.toBeNull();
  });

  it('12b. production today (no grant at all) produces an approval leg', () => {
    const r = assessTokenGrant(input());
    expect(r.needsApproval).toBe(true);
  });

  it('13. a VALID grant skips the approval entirely -- no calldata is built', () => {
    const r = assessTokenGrant(input({ grant: { amount: NEED, expiration: NOW + 86_400, nonce: 0 } }));
    expect(r).toMatchObject({ status: 'VALID', needsApproval: false, approval: null });
  });

  it('14. an EXPIRED grant produces an approval leg', () => {
    const r = assessTokenGrant(input({ grant: { amount: NEED * 10n, expiration: NOW - 1, nonce: 0 } }));
    expect(r).toMatchObject({ status: 'EXPIRED', needsApproval: true });
  });

  it('14b. a grant inside the minimum-validity margin counts as expired (never raced)', () => {
    const r = assessTokenGrant(input({ grant: { amount: NEED, expiration: NOW + G.MIN_REMAINING_VALIDITY_SECONDS - 1, nonce: 0 } }));
    expect(r.status).toBe('EXPIRED');
    expect(assessTokenGrant(input({ grant: { amount: NEED, expiration: NOW + G.MIN_REMAINING_VALIDITY_SECONDS, nonce: 0 } })).status).toBe('VALID');
  });
});

describe('15-17. identity: every mismatch fails closed, with no approval built', () => {
  it('15. a grant read for a DIFFERENT spender is refused', () => {
    const r = assessTokenGrant(input({ readFor: { owner: WALLET, token: TOKEN, spender: OTHER } }));
    expect(r).toMatchObject({ status: 'WRONG_SPENDER', needsApproval: false, approval: null });
  });

  it('15b. a spender NOT on the Universal Router allowlist is refused, even if the read matches', () => {
    for (const bad of [LEGACY, OTHER]) {
      const r = assessTokenGrant(input({ spender: bad, readFor: { owner: WALLET, token: TOKEN, spender: bad } }));
      expect(r).toMatchObject({ status: 'WRONG_SPENDER', approval: null });
      expect(r.reason).toMatch(/not an approved Universal Router/);
    }
  });

  it('16. a grant read for a DIFFERENT owner is refused', () => {
    const r = assessTokenGrant(input({ readFor: { owner: OTHER, token: TOKEN, spender: UR } }));
    expect(r).toMatchObject({ status: 'WRONG_OWNER', approval: null });
  });

  it('17. a grant read for a DIFFERENT token is refused', () => {
    const r = assessTokenGrant(input({ readFor: { owner: WALLET, token: OTHER, spender: UR } }));
    expect(r).toMatchObject({ status: 'WRONG_TOKEN', approval: null });
  });

  it('a non-positive required amount is UNAVAILABLE', () => {
    expect(assessTokenGrant(input({ requiredAmount: 0n })).status).toBe('UNAVAILABLE');
  });

  it('the live pre-flight refuses to run against an ambiguous router allowlist (the test env merges a second router)', async () => {
    // A genuine read failure is covered where it matters -- in executeExit,
    // which must turn it into PENDING rather than "no grant" (exitPermit2Flow.test.ts).
    await expect(
      runTokenGrantPreflight(TOKEN, NEED, { walletAddress: WALLET, readPermit2Grant: vi.fn(async () => ({ amount: 0n, expiration: 0, nonce: 0 })), readChainTimestamp: async () => NOW }),
    ).rejects.toThrow(/ambiguous/);
  });
});

describe('27. the D5 USDG -> PositionManager grant is never touched', () => {
  it('a USDG token is refused outright', () => {
    const r = assessTokenGrant(input({ expectedToken: USDG, readFor: { owner: WALLET, token: USDG, spender: UR } }));
    expect(r).toMatchObject({ status: 'WRONG_TOKEN', approval: null });
    expect(r.reason).toMatch(/operator-only renewal path/);
  });

  it('the PositionManager as spender is refused outright', () => {
    const r = assessTokenGrant(input({ spender: PM, readFor: { owner: WALLET, token: TOKEN, spender: PM }, targets: { ...TARGETS, universalRouters: [...TARGETS.universalRouters, PM] } }));
    expect(r).toMatchObject({ status: 'WRONG_SPENDER', approval: null });
  });

  it('a distinct idempotency namespace: permit2:exit: never collides with permit2:renew:', () => {
    const exitKey = tokenGrantIdempotencyKey('exit:pos:k', 4663, TOKEN, UR, NOW + 86_400);
    const renewKey = renewalIdempotencyKey(4663, USDG, PM, NOW + 86_400);
    expect(exitKey.startsWith('permit2:exit:')).toBe(true);
    expect(renewKey.startsWith('permit2:renew:')).toBe(true);
    expect(exitKey).not.toBe(renewKey);
  });

  it('the exit modules never import or call the renewal action', () => {
    const root = path.resolve(__dirname, '../..');
    for (const f of ['src/exits/permit2TokenGrant.ts', 'src/exits/permit2GrantTx.ts', 'src/exits/executeExit.ts']) {
      const text = readFileSync(path.join(root, f), 'utf8');
      expect(text, f).not.toMatch(/renewPermit2Grant|runPermit2RenewalPreflight|buildPermit2RenewalDeps/);
    }
  });
});

describe('approval calldata is exact and bounded', () => {
  it('encodes Permit2.approve(TOKEN, UR, exact amount, chain time + lifetime)', () => {
    const r = assessTokenGrant(input());
    const a = r.approval!;
    expect(a.to).toBe(getAddress(config.uniswap.v4.permit2));
    const d = decodeFunctionData({ abi: PERMIT2_APPROVE_ABI, data: a.data });
    expect(d.args).toEqual([TOKEN, UR, NEED, NOW + G.LIFETIME_SECONDS]);
    expect(G.APPROVE_EXACT_AMOUNT).toBe(true); // exact, not uint160 max
  });

  it('the lifetime is bounded; beyond the ceiling is refused', () => {
    expect(assessTokenGrant(input({ requestedLifetimeSeconds: G.MAX_LIFETIME_SECONDS + 1 })).status).toBe('UNAVAILABLE');
    expect(assessTokenGrant(input({ requestedLifetimeSeconds: G.MAX_LIFETIME_SECONDS })).needsApproval).toBe(true);
  });

  it('a lifetime pushing the expiration to uint48 max is refused', () => {
    expect(assessTokenGrant(input({ chainTimestamp: 2 ** 48 - 100, grant: { amount: 0n, expiration: 0, nonce: 0 } })).status).toBe('UNAVAILABLE');
  });

  it('exitSwapSpender refuses an ambiguous or empty router allowlist', () => {
    expect(exitSwapSpender(TARGETS)).toBe(UR);
    expect(() => exitSwapSpender({ ...TARGETS, universalRouters: [] })).toThrow(/ambiguous/);
    expect(() => exitSwapSpender({ ...TARGETS, universalRouters: [UR, OTHER] })).toThrow(/ambiguous/);
  });
});

describe('20. approval verification is by re-read, never by receipt', () => {
  const approval = () => assessTokenGrant(input()).approval!;

  it('a grant that really covers the swap verifies', async () => {
    const a = approval();
    const deps = buildTokenGrantDeps(a, NEED, { walletAddress: WALLET, readPermit2Grant: async () => ({ amount: NEED, expiration: a.expiration, nonce: 0 }), readChainTimestamp: async () => NOW });
    expect((await deps.verifyOnChain('0x' as `0x${string}`)).ok).toBe(true);
  });

  it.each([
    ['amount short', (a: { expiration: number }) => ({ amount: NEED - 1n, expiration: a.expiration, nonce: 0 }), /below the/],
    ['wrong expiration', (a: { expiration: number }) => ({ amount: NEED, expiration: a.expiration - 1, nonce: 0 }), /not the intended/],
    ['unchanged (receipt said success, nothing landed)', () => ({ amount: 0n, expiration: 0, nonce: 0 }), /below the/],
  ])('%s is a verification FAILURE', async (_l, grant, re) => {
    const a = approval();
    const deps = buildTokenGrantDeps(a, NEED, { walletAddress: WALLET, readPermit2Grant: async () => grant(a), readChainTimestamp: async () => NOW });
    const v = await deps.verifyOnChain('0x' as `0x${string}`);
    expect(v.ok).toBe(false);
    if (!v.ok) expect(v.reason).toMatch(re);
  });

  it('the approval leg reuses the existing executor steps -- no private gas strategy', () => {
    const text = readFileSync(path.resolve(__dirname, '../../src/exits/permit2GrantTx.ts'), 'utf8');
    for (const step of ['simulateTx', 'estimateGasForTx', 'getCurrentGasPrice', 'checkGasAffordableOnChain', 'getCurrentNonce', 'signTx', 'broadcastRawTx', 'waitForTxReceipt', 'getReceiptIfAvailable']) {
      expect(text).toContain(`txSteps.${step}`);
    }
  });
});
