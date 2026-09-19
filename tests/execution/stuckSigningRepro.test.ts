import { describe, expect, it, vi } from 'vitest';
import { createWalletClient, custom, defineChain } from 'viem';
import { privateKeyToAccount } from 'viem/accounts';
import { executeCriticalTransaction } from '../../src/execution/executeCriticalTransaction';
import type { TxRequest, TxSafetyDeps } from '../../src/execution/types';
import { InMemoryTransactionAttemptRepository } from './inMemoryTransactionAttemptRepository';

// Incident reproduction (production approve stuck at NONCE_ASSIGNED, txHash
// null, lastError null, retried every 15s). These three tests reproduce the
// three independent defects BEFORE the fix; they are kept as regressions.

// Well-known Hardhat/Anvil test key #0 -- public, never holds funds.
const TEST_KEY = '0xac0974bec39a17e36ba4a6b4d238ff944bacb478cbed5efcae784d7bf4f2ff80';
const TEST_CHAIN = defineChain({ id: 4663, name: 'test', nativeCurrency: { name: 'Ether', symbol: 'ETH', decimals: 18 }, rpcUrls: { default: { http: ['http://127.0.0.1:1'] } } });
const TX: TxRequest = { to: '0x1111111111111111111111111111111111111111', data: '0xabcdef', value: 0n };

describe('incident root cause -- viem signs over JSON-RPC when `account` is an address string', () => {
  it('walletClient.signTransaction({ account: <address string> }) ignores the local key and asks the RPC node to sign (eth_signTransaction)', async () => {
    const methods: string[] = [];
    const account = privateKeyToAccount(TEST_KEY);
    const client = createWalletClient({
      account,
      chain: TEST_CHAIN,
      transport: custom({
        request: async ({ method }: { method: string }) => {
          methods.push(method);
          if (method === 'eth_chainId') return '0x1237';
          throw new Error(`the method ${method} does not exist/is not available`); // what a hosted RPC answers
        },
      }),
    });
    // Exactly the call shape `viemTxSteps.signTx` used: account = getExecutorAddress() (a string).
    await expect(client.signTransaction({ account: account.address, chain: TEST_CHAIN, to: TX.to, data: TX.data, value: 0n, nonce: 1600, gas: 58801n, gasPrice: 63390000n })).rejects.toThrow();
    expect(methods).toContain('eth_signTransaction');

    // With the local ACCOUNT object the same call signs locally -- no eth_signTransaction.
    methods.length = 0;
    const raw = await client.signTransaction({ account, chain: TEST_CHAIN, to: TX.to, data: TX.data, value: 0n, nonce: 1600, gas: 58801n, gasPrice: 63390000n });
    expect(raw).toMatch(/^0x/);
    expect(methods).not.toContain('eth_signTransaction');
  });
});

function deps(overrides: Partial<TxSafetyDeps<{ ok: true }>> = {}): TxSafetyDeps<{ ok: true }> {
  return {
    buildTransaction: vi.fn(async () => TX),
    simulate: vi.fn(async () => ({ ok: true }) as const),
    estimateGas: vi.fn(async () => 58_801n),
    getGasPrice: vi.fn(async () => 63_390_000n),
    checkGasAffordable: vi.fn(async () => ({ ok: true }) as const),
    getNonce: vi.fn(async () => 1600),
    signTransaction: vi.fn(async () => ({ raw: '0xdead' as `0x${string}`, hash: `0x${'aa'.repeat(32)}` as `0x${string}` })),
    broadcastRaw: vi.fn(async () => undefined),
    waitForReceipt: vi.fn(async () => ({ status: 'success' as const, blockNumber: 1n })),
    getReceiptIfAvailable: vi.fn(async () => null),
    verifyOnChain: vi.fn(async () => ({ ok: true as const, data: { ok: true as const } })),
    ...overrides,
  };
}

describe('incident observability -- the signing exception must not vanish', () => {
  it('a throw from signTransaction after NONCE_ASSIGNED is persisted in lastError (the incident had lastError = null)', async () => {
    const repo = new InMemoryTransactionAttemptRepository();
    const d = deps({ signTransaction: vi.fn(async () => { throw new Error('the method eth_signTransaction does not exist/is not available'); }) });
    const r = await executeCriticalTransaction('deploy:x:approve', 'deploy:approve', d, repo);
    expect(r.ok).toBe(false);
    const row = (await repo.find('deploy:x:approve'))!;
    expect(row.txHash).toBeNull();
    expect(d.broadcastRaw).not.toHaveBeenCalled();
    expect(row.lastError).toMatch(/SIGN_TRANSACTION_FAILED/);
    expect(row.lastError).toMatch(/eth_signTransaction/);
  });
});

describe('fence bypass -- an attempt fenced FAILED (H3) must never be resurrected by a worker already in the pipeline', () => {
  it('a worker that re-reads a FAILED attempt inside the executor lock stops: no new nonce, no signing, no broadcast', async () => {
    const repo = new InMemoryTransactionAttemptRepository();
    // Another critical transaction holds the executor lock (its broadcast is in flight).
    let releaseHolder!: () => void;
    const holderGate = new Promise<void>((r) => { releaseHolder = r; });
    const holderDeps = deps({ broadcastRaw: vi.fn(async () => { await holderGate; }) });
    const holder = executeCriticalTransaction('other:swap', 'exit:swap', holderDeps, repo);
    await vi.waitFor(() => expect(holderDeps.broadcastRaw).toHaveBeenCalled());

    // The mint worker completes every pre-lock step (GAS_CHECKED persisted) and queues on the lock.
    const d = deps();
    const worker = executeCriticalTransaction('deploy:y:mint', 'deploy:mint', d, repo);
    await vi.waitFor(async () => expect((await repo.find('deploy:y:mint'))?.status).toBe('GAS_CHECKED'));

    // H3 expiry fences the attempt (version CAS) while the worker waits for the lock.
    const current = (await repo.find('deploy:y:mint'))!;
    await repo.update(current.id, { status: 'FAILED', failureCode: 'OPENING_TIMEOUT', lastError: 'fenced by expiry' }, current.version);
    releaseHolder();
    await holder;
    await worker;
    const row = (await repo.find('deploy:y:mint'))!;
    expect(row.status).toBe('FAILED');
    expect(d.getNonce).not.toHaveBeenCalled();
    expect(d.signTransaction).not.toHaveBeenCalled();
    expect(d.broadcastRaw).not.toHaveBeenCalled();
  });
});
