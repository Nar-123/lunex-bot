import { describe, expect, it } from 'vitest';
import {
  classifyApprovalSpender,
  classifyExecutionTarget,
  decodeSwapProxyExecute,
  ExecutionTargetError,
  isApprovedUniversalRouter,
  normalizeAddress,
  SWAP_PROXY_EXECUTE_SELECTOR,
  type ExecutionTargetPolicy,
} from '../../src/swap/executionTargets';
import { config } from '../../src/config';
import { APPROVED_PROXY, APPROVED_ROUTER, LEGACY_PROXY, POLICY, proxyCalldata, TOKEN, UNVERIFIED_ROUTER } from './executionTargetFixtures';

describe('normalizeAddress', () => {
  it('compares case-insensitively: checksummed, lowercase and uppercase forms are the same address', () => {
    expect(normalizeAddress(APPROVED_ROUTER)).toBe(APPROVED_ROUTER.toLowerCase());
    expect(normalizeAddress(APPROVED_ROUTER.toLowerCase())).toBe(normalizeAddress(APPROVED_ROUTER.toUpperCase().replace('0X', '0x')));
  });

  it('rejects anything that is not a well-formed EVM address (never silently "matches nothing")', () => {
    for (const bad of ['', '0x', '0x1234', 'not-an-address', `${APPROVED_ROUTER}00`]) {
      expect(() => normalizeAddress(bad)).toThrow(ExecutionTargetError);
    }
  });
});

describe('classifyExecutionTarget', () => {
  it('approved Universal Router -> UNIVERSAL_ROUTER, in any case form', () => {
    expect(classifyExecutionTarget(APPROVED_ROUTER, POLICY)).toEqual({ kind: 'UNIVERSAL_ROUTER', address: APPROVED_ROUTER.toLowerCase() });
    expect(classifyExecutionTarget(APPROVED_ROUTER.toLowerCase(), POLICY)?.kind).toBe('UNIVERSAL_ROUTER');
    expect(classifyExecutionTarget(APPROVED_ROUTER.toUpperCase().replace('0X', '0x'), POLICY)?.kind).toBe('UNIVERSAL_ROUTER');
  });

  it('approved SwapProxy -> SWAP_PROXY, and is NOT reported as a router', () => {
    const match = classifyExecutionTarget(APPROVED_PROXY, POLICY);
    expect(match?.kind).toBe('SWAP_PROXY');
    expect(isApprovedUniversalRouter(APPROVED_PROXY, POLICY)).toBe(false);
  });

  it('the DEPRECATED legacy proxy is not approved', () => {
    expect(classifyExecutionTarget(LEGACY_PROXY, POLICY)).toBeNull();
  });

  it('the unverified router the API embeds is not approved', () => {
    expect(classifyExecutionTarget(UNVERIFIED_ROUTER, POLICY)).toBeNull();
    expect(isApprovedUniversalRouter(UNVERIFIED_ROUTER, POLICY)).toBe(false);
  });

  it('FAIL CLOSED: an empty router allowlist authorises nothing at all, even an address in the proxy list', () => {
    const empty = { ...POLICY, universalRouters: [] };
    expect(() => classifyExecutionTarget(APPROVED_ROUTER, empty)).toThrow(/no approved Universal Router is configured/);
    expect(() => classifyExecutionTarget(APPROVED_PROXY, empty)).toThrow(ExecutionTargetError);
  });

  it('an empty proxy allowlist still allows a direct router but approves no proxy', () => {
    const noProxies = { ...POLICY, swapProxies: [] };
    expect(classifyExecutionTarget(APPROVED_ROUTER, noProxies)?.kind).toBe('UNIVERSAL_ROUTER');
    expect(classifyExecutionTarget(APPROVED_PROXY, noProxies)).toBeNull();
  });

  it('a malformed allowlist entry throws rather than being skipped', () => {
    expect(() => classifyExecutionTarget(APPROVED_ROUTER, { ...POLICY, universalRouters: ['0xnope'] })).toThrow(ExecutionTargetError);
  });
});

describe('decodeSwapProxyExecute', () => {
  it('decodes the real payload shape (router, token, amount, commands, inputs, deadline)', () => {
    const decoded = decodeSwapProxyExecute(proxyCalldata());
    expect(decoded.router.toLowerCase()).toBe(APPROVED_ROUTER.toLowerCase());
    expect(decoded.token.toLowerCase()).toBe(TOKEN.toLowerCase());
    expect(decoded.amount).toBe(500n);
    expect(decoded.commands).toBe('0x00');
    expect(decoded.inputsCount).toBe(1);
    expect(decoded.deadline).toBe(1_789_880_588n);
  });

  it('rejects a wrong selector', () => {
    const wrong = `0xdeadbeef${proxyCalldata().slice(10)}`;
    expect(() => decodeSwapProxyExecute(wrong)).toThrow(/selector 0xdeadbeef is not/);
  });

  it('rejects truncated calldata', () => {
    expect(() => decodeSwapProxyExecute(proxyCalldata().slice(0, 80))).toThrow(/truncated/);
    expect(() => decodeSwapProxyExecute(SWAP_PROXY_EXECUTE_SELECTOR)).toThrow(/truncated/);
  });

  it('rejects malformed / non-hex payloads', () => {
    expect(() => decodeSwapProxyExecute('0xzzzz')).toThrow(/not well-formed hex/);
    expect(() => decodeSwapProxyExecute('garbage')).toThrow(ExecutionTargetError);
    expect(() => decodeSwapProxyExecute(`${SWAP_PROXY_EXECUTE_SELECTOR}${'ff'.repeat(192)}`)).toThrow(ExecutionTargetError); // head words point nowhere
  });
});

describe('classifyApprovalSpender', () => {
  it('approves only configured execution targets', () => {
    expect(classifyApprovalSpender(APPROVED_PROXY, POLICY)?.kind).toBe('SWAP_PROXY');
    expect(classifyApprovalSpender(APPROVED_ROUTER, POLICY)?.kind).toBe('UNIVERSAL_ROUTER');
    expect(classifyApprovalSpender(LEGACY_PROXY, POLICY)).toBeNull();
    expect(classifyApprovalSpender('0x1234567890123456789012345678901234567890', POLICY)).toBeNull();
  });
});

describe('shipped configuration', () => {
  it('approves the documented UR 2.1.1 and the deterministic SwapProxy for chain 4663 -- and neither incident address', () => {
    const targets = config.uniswapTradingApi.executionTargets;
    expect(targets.chainId).toBe(4663);
    expect(targets.universalRouters.map((a) => a.toLowerCase())).toContain(APPROVED_ROUTER.toLowerCase());
    expect(targets.swapProxies.map((a) => a.toLowerCase())).toEqual([APPROVED_PROXY.toLowerCase()]);
    const all = [...targets.universalRouters, ...targets.swapProxies].map((a) => a.toLowerCase());
    expect(all).not.toContain(LEGACY_PROXY.toLowerCase());
    expect(all).not.toContain(UNVERIFIED_ROUTER.toLowerCase());
  });
});
