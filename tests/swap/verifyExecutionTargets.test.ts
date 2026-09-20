import { afterEach, describe, expect, it, vi } from 'vitest';
import { assertExecutionTargetsAtStartup, verifyExecutionTargets } from '../../src/swap/verifyExecutionTargets';
import { getExecutionTargetVerification, resetExecutionTargetVerification } from '../../src/swap/executionTargetGate';
import { SWAP_PROXY_EXECUTE_SELECTOR } from '../../src/swap/executionTargets';
import { APPROVED_PROXY, APPROVED_ROUTER, POLICY } from './executionTargetFixtures';

const POOL_MANAGER = '0x8366a39CC670B4001A1121B8F6A443A643e40951';
const ROUTER_CODE = '0x60806040' + 'ab'.repeat(100);
const PROXY_CODE = `0x6080806040${SWAP_PROXY_EXECUTE_SELECTOR.slice(2)}${'cd'.repeat(100)}`;

function readers(over: Partial<Parameters<typeof verifyExecutionTargets>[1]> = {}) {
  return {
    getChainId: vi.fn(async () => 4663),
    getCode: vi.fn(async (a: string) => (a.toLowerCase() === APPROVED_PROXY.toLowerCase() ? PROXY_CODE : ROUTER_CODE)),
    readPoolManager: vi.fn(async () => POOL_MANAGER),
    ...over,
  };
}

afterEach(() => {
  resetExecutionTargetVerification();
});

describe('verifyExecutionTargets (READ-ONLY identity assertion)', () => {
  it('passes when every target has code, the chain matches and each router is bound to the configured PoolManager', async () => {
    const r = readers();
    const report = await verifyExecutionTargets(POLICY, r, POOL_MANAGER);
    expect(report.ok).toBe(true);
    expect(report.failures).toEqual([]);
    expect(report.checked).toHaveLength(2);
    expect(r.readPoolManager).toHaveBeenCalledWith(APPROVED_ROUTER.toLowerCase());
  });

  it('fails when the RPC is on a different chain than the policy', async () => {
    const report = await verifyExecutionTargets(POLICY, readers({ getChainId: vi.fn(async () => 1) }), POOL_MANAGER);
    expect(report.ok).toBe(false);
    expect(report.failures.join()).toMatch(/chainId 1, but the execution-target policy is for chain 4663/);
  });

  it('fails when a configured target has no code on this chain', async () => {
    const report = await verifyExecutionTargets(POLICY, readers({ getCode: vi.fn(async () => '0x') }), POOL_MANAGER);
    expect(report.failures.join()).toMatch(/has NO code/);
  });

  it('fails when a router is bound to a different PoolManager', async () => {
    const report = await verifyExecutionTargets(POLICY, readers({ readPoolManager: vi.fn(async () => '0xdeadbeefdeadbeefdeadbeefdeadbeefdeadbeef') }), POOL_MANAGER);
    expect(report.failures.join()).toMatch(/bound to PoolManager .* expected/);
  });

  it('fails when a proxy does not expose the execute() entry point this project decodes', async () => {
    const report = await verifyExecutionTargets(POLICY, readers({ getCode: vi.fn(async () => ROUTER_CODE) }), POOL_MANAGER);
    expect(report.failures.join()).toMatch(/does not expose 0x2894adf9/);
  });

  it('fails when two approved proxies are not byte-identical (a deterministic deployment must be)', async () => {
    const policy = { ...POLICY, swapProxies: [APPROVED_PROXY, '0x1111111111111111111111111111111111111111'] };
    const getCode = vi.fn(async (a: string) => (a.toLowerCase() === APPROVED_PROXY.toLowerCase() ? PROXY_CODE : `${PROXY_CODE}ff`));
    const report = await verifyExecutionTargets(policy, readers({ getCode }), POOL_MANAGER);
    expect(report.failures.join()).toMatch(/do not share identical bytecode/);
  });

  it('fails closed when no router is approved', async () => {
    const report = await verifyExecutionTargets({ ...POLICY, universalRouters: [] }, readers(), POOL_MANAGER);
    expect(report.ok).toBe(false);
    expect(report.failures.join()).toMatch(/no approved Universal Router is configured/);
  });

  it('an unreadable RPC is a failure, not a pass', async () => {
    const report = await verifyExecutionTargets(POLICY, readers({ getChainId: vi.fn(async () => { throw new Error('ECONNREFUSED'); }) }), POOL_MANAGER);
    expect(report.ok).toBe(false);
    expect(report.failures.join()).toMatch(/could not read chainId/);
  });

  it('performs only read calls -- it never builds, signs or sends anything', async () => {
    const r = readers();
    await verifyExecutionTargets(POLICY, r, POOL_MANAGER);
    expect(r.getCode).toHaveBeenCalledTimes(2);
    expect(r.getChainId).toHaveBeenCalledTimes(1);
    expect(r.readPoolManager).toHaveBeenCalledTimes(1);
  });
});

describe('assertExecutionTargetsAtStartup', () => {
  it('publishes VERIFIED and logs the checks on success', async () => {
    const log = vi.fn();
    await assertExecutionTargetsAtStartup(log, POLICY, readers());
    expect(getExecutionTargetVerification()).toBe('VERIFIED');
    expect(log).toHaveBeenCalledWith('execution_targets_verified', expect.objectContaining({ chainId: 4663 }));
  });

  it('publishes FAILED (blocking exit swaps) without throwing, so the bot keeps monitoring', async () => {
    const log = vi.fn();
    await expect(assertExecutionTargetsAtStartup(log, POLICY, readers({ getCode: vi.fn(async () => '0x') }))).resolves.toMatchObject({ ok: false });
    expect(getExecutionTargetVerification()).toBe('FAILED');
    expect(log).toHaveBeenCalledWith('execution_targets_verification_failed', expect.objectContaining({ failures: expect.any(Array) }));
  });

  it('a thrown reader is caught and still results in FAILED', async () => {
    await assertExecutionTargetsAtStartup(vi.fn(), POLICY, { getCode: vi.fn(async () => { throw new Error('boom'); }) });
    expect(getExecutionTargetVerification()).toBe('FAILED');
  });
});
