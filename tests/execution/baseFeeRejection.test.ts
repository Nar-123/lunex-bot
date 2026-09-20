import { describe, expect, it, vi } from 'vitest';
import { InvalidInputRpcError, RpcRequestError } from 'viem';
import { classifyBroadcastError } from '../../src/execution/classifyBroadcastError';
import { executeCriticalTransaction } from '../../src/execution/executeCriticalTransaction';
import type { TxRequest, TxSafetyDeps } from '../../src/execution/types';
import { InMemoryTransactionAttemptRepository } from './inMemoryTransactionAttemptRepository';

/** The EXACT provider error observed live (Alchemy, Robinhood Chain), JSON-RPC -32000, wrapped exactly as viem 2.56.3 wraps it. */
const PROVIDER_MESSAGE = 'err: max fee per gas less than block base fee: address 0x65299018ABAaa6bD89aabF689dbEf21Be99ef1Ea, maxFeePerGas: 66172000, baseFee: 67172000 (supplied gas 100000)';
const RAW = `0x02f8${'ab'.repeat(120)}` as `0x${string}`;
const HASH = `0x${'cd'.repeat(32)}` as `0x${string}`;
const TX: TxRequest = { to: '0x1111111111111111111111111111111111111111', data: '0x095ea7b3', value: 0n };

function feeTooLowError(): Error {
  return new InvalidInputRpcError(
    new RpcRequestError({ body: { method: 'eth_sendRawTransaction', params: [RAW] }, error: { code: -32000, message: PROVIDER_MESSAGE }, url: 'https://robinhood-mainnet.g.alchemy.com/v2/SECRETAPIKEY123' }),
  );
}

function deps(overrides: Partial<TxSafetyDeps<{ ok: true }>> = {}): TxSafetyDeps<{ ok: true }> {
  return {
    buildTransaction: vi.fn(async () => TX),
    simulate: vi.fn(async () => ({ ok: true }) as const),
    estimateGas: vi.fn(async () => 58_801n),
    getGasPrice: vi.fn(async () => 67_752_000n),
    checkGasAffordable: vi.fn(async () => ({ ok: true }) as const),
    getNonce: vi.fn(async () => 1600),
    signTransaction: vi.fn(async () => ({ raw: RAW, hash: HASH })),
    broadcastRaw: vi.fn(async () => undefined),
    waitForReceipt: vi.fn(async () => ({ status: 'success' as const, blockNumber: 67305252n })),
    getReceiptIfAvailable: vi.fn(async () => null),
    verifyOnChain: vi.fn(async () => ({ ok: true as const, data: { ok: true as const } })),
    ...overrides,
  };
}

describe('base-fee rejection classification', () => {
  it('the exact provider text is classified FEE_TOO_LOW (not AMBIGUOUS)', () => {
    expect(classifyBroadcastError(PROVIDER_MESSAGE)).toEqual({ kind: 'FEE_TOO_LOW' });
    expect(classifyBroadcastError('max fee per gas less than block base fee')).toEqual({ kind: 'FEE_TOO_LOW' });
  });

  it('...including through viem\'s InvalidInputRpcError wrapper (whose short message says nothing useful)', () => {
    const err = feeTooLowError();
    expect(err.name).toBe('InvalidInputRpcError');
    expect(err.message.startsWith('Missing or invalid parameters.')).toBe(true);
    expect(classifyBroadcastError(err.message)).toEqual({ kind: 'FEE_TOO_LOW' });
  });

  it('ambiguity handling is NOT weakened: the bare viem short message, timeouts and unknown errors stay AMBIGUOUS', () => {
    expect(classifyBroadcastError('Missing or invalid parameters. Double check you have provided the correct parameters.')).toEqual({ kind: 'AMBIGUOUS' });
    expect(classifyBroadcastError('The request took too long to respond.')).toEqual({ kind: 'AMBIGUOUS' });
    expect(classifyBroadcastError('max fee per gas higher than 2^256-1')).toEqual({ kind: 'AMBIGUOUS' });
    expect(classifyBroadcastError('already known')).toEqual({ kind: 'ALREADY_KNOWN' });
    expect(classifyBroadcastError('nonce too low')).toEqual({ kind: 'POSSIBLY_OURS' });
  });
});

describe('executeCriticalTransaction -- BROADCAST_REJECTED_FEE_TOO_LOW', () => {
  it('stays SIGNED and resumable, logs/persists the dedicated code with the provider details (secrets redacted)', async () => {
    const repo = new InMemoryTransactionAttemptRepository();
    const log = vi.fn();
    const d = deps({ broadcastRaw: vi.fn(async () => { throw feeTooLowError(); }) });

    const r = await executeCriticalTransaction('deploy:x:approve', 'deploy:approve', d, repo, { log });

    expect(r).toMatchObject({ ok: false, resumable: true });
    const row = (await repo.find('deploy:x:approve'))!;
    expect(row.status).toBe('SIGNED');
    expect(row.failureCode).toBeNull();
    expect(row.lastError).toMatch(/^\[BROADCAST_REJECTED_FEE_TOO_LOW\]/);
    expect(row.lastError).toContain('baseFee: 67172000');
    expect(row.lastError).toContain('maxFeePerGas: 66172000');
    expect(row.lastError).toContain('code -32000');
    expect(row.lastError).not.toContain('SECRETAPIKEY123');
    expect(row.lastError).not.toContain('ab'.repeat(60));
    expect(log).toHaveBeenCalledWith('critical_tx_step_failed', expect.objectContaining({ code: 'BROADCAST_REJECTED_FEE_TOO_LOW', txHash: HASH, signedGasPrice: '67752000', retry: 'same-signed-bytes' }));
    expect(JSON.stringify(log.mock.calls)).not.toContain('SECRETAPIKEY123');
  });

  it('retry re-broadcasts the SAME signed bytes: signed once, one nonce, identical payload, no second logical attempt', async () => {
    const repo = new InMemoryTransactionAttemptRepository();
    let calls = 0;
    const broadcastRaw = vi.fn(async () => { if (++calls <= 3) throw feeTooLowError(); }); // rejected 3x (as live), then accepted
    const d = deps({ broadcastRaw });

    for (let i = 0; i < 3; i++) expect(await executeCriticalTransaction('deploy:x:approve', 'deploy:approve', d, repo, { log: vi.fn() })).toMatchObject({ ok: false, resumable: true });
    const final = await executeCriticalTransaction('deploy:x:approve', 'deploy:approve', d, repo, { log: vi.fn() });

    expect(final.ok).toBe(true);
    expect(d.signTransaction).toHaveBeenCalledTimes(1); // never re-signed
    expect(d.getNonce).toHaveBeenCalledTimes(1); // no new nonce -> no nonce gap
    expect(d.getGasPrice).toHaveBeenCalledTimes(1); // gas decision frozen with the payload
    expect(broadcastRaw).toHaveBeenCalledTimes(4);
    for (const call of broadcastRaw.mock.calls) expect(call).toEqual([RAW]); // byte-identical every time
    const row = (await repo.find('deploy:x:approve'))!;
    expect(row).toMatchObject({ status: 'VERIFIED', nonce: 1600, txHash: HASH, attemptCount: 4 });
  });

  it('an EARLIER broadcast of these exact bytes that already landed is recognised via our own receipt -> proceeds, never duplicated', async () => {
    const repo = new InMemoryTransactionAttemptRepository();
    const d = deps({
      broadcastRaw: vi.fn(async () => { throw feeTooLowError(); }),
      getReceiptIfAvailable: vi.fn(async () => ({ status: 'success' as const, blockNumber: 67305252n })),
    });
    const r = await executeCriticalTransaction('deploy:x:approve', 'deploy:approve', d, repo, { log: vi.fn() });
    expect(r.ok).toBe(true);
    expect(d.getReceiptIfAvailable).toHaveBeenCalledWith(HASH);
    expect(d.signTransaction).toHaveBeenCalledTimes(1);
  });

  it('a failing receipt lookup does not turn the known rejection into FAILED (still resumable, same code)', async () => {
    const repo = new InMemoryTransactionAttemptRepository();
    const d = deps({ broadcastRaw: vi.fn(async () => { throw feeTooLowError(); }), getReceiptIfAvailable: vi.fn(async () => { throw new Error('rpc down'); }) });
    expect(await executeCriticalTransaction('k', 'p', d, repo, { log: vi.fn() })).toMatchObject({ ok: false, resumable: true });
    const row = (await repo.find('k'))!;
    expect(row.status).toBe('SIGNED');
    expect(row.lastError).toMatch(/^\[BROADCAST_REJECTED_FEE_TOO_LOW\]/);
  });

  it('a genuinely ambiguous broadcast keeps the existing BROADCAST_AMBIGUOUS + receipt-recovery behaviour', async () => {
    const repo = new InMemoryTransactionAttemptRepository();
    const log = vi.fn();
    const d = deps({ broadcastRaw: vi.fn(async () => { throw new Error('socket hang up'); }) });
    expect(await executeCriticalTransaction('k2', 'p', d, repo, { log })).toMatchObject({ ok: false, resumable: true });
    expect((await repo.find('k2'))!.lastError).toMatch(/^\[BROADCAST_AMBIGUOUS\]/);
    expect(d.getReceiptIfAvailable).toHaveBeenCalledWith(HASH);
    expect(log).toHaveBeenCalledWith('critical_tx_step_failed', expect.objectContaining({ code: 'BROADCAST_AMBIGUOUS' }));
  });

  it('gas-price refusal (cap) at GAS_CHECK is transient: no nonce, nothing signed, never FAILED', async () => {
    const { GasPriceAboveCapError } = await import('../../src/execution/gasPrice');
    const repo = new InMemoryTransactionAttemptRepository();
    const d = deps({ getGasPrice: vi.fn(async () => { throw new GasPriceAboveCapError(2_000_000_000n, 1_000_000_000n, 500); }) });
    expect(await executeCriticalTransaction('k3', 'p', d, repo, { log: vi.fn() })).toMatchObject({ ok: false, resumable: true });
    const row = (await repo.find('k3'))!;
    expect(row.status).toBe('SIMULATED');
    expect(row.lastError).toMatch(/^\[GAS_CHECK_FAILED\].*GasPriceAboveCapError/);
    expect(d.getNonce).not.toHaveBeenCalled();
    expect(d.signTransaction).not.toHaveBeenCalled();
  });
});
