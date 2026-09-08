import { describe, expect, it, vi } from 'vitest';
import { executeCriticalTransaction } from '../../src/execution/executeCriticalTransaction';
import type { TxRequest, TxSafetyDeps } from '../../src/execution/types';
import { InMemoryTransactionAttemptRepository } from './inMemoryTransactionAttemptRepository';

const TX: TxRequest = { to: '0x1111111111111111111111111111111111111111', data: '0xabcdef', value: 0n };
const RAW_TX = '0xf86c0102030405';
const TX_HASH = '0xdeadbeefdeadbeefdeadbeefdeadbeefdeadbeefdeadbeefdeadbeefdeadbeef';

function makeDeps(overrides: Partial<TxSafetyDeps<{ verified: true }>> = {}): TxSafetyDeps<{ verified: true }> {
  return {
    buildTransaction: vi.fn(async () => TX),
    simulate: vi.fn(async () => ({ ok: true }) as const),
    estimateGas: vi.fn(async () => 100_000n),
    getGasPrice: vi.fn(async () => 1_000_000_000n),
    checkGasAffordable: vi.fn(async () => ({ ok: true }) as const),
    getNonce: vi.fn(async () => 7),
    signTransaction: vi.fn(async () => ({ raw: RAW_TX as `0x${string}`, hash: TX_HASH as `0x${string}` })),
    broadcastRaw: vi.fn(async () => undefined),
    waitForReceipt: vi.fn(async () => ({ status: 'success' as const, blockNumber: 123n })),
    getReceiptIfAvailable: vi.fn(async () => null),
    verifyOnChain: vi.fn(async () => ({ ok: true as const, data: { verified: true as const } })),
    ...overrides,
  };
}

describe('executeCriticalTransaction -- happy path', () => {
  it('runs every step in order and returns ok:true with VERIFIED status', async () => {
    const repo = new InMemoryTransactionAttemptRepository();
    const deps = makeDeps();
    const result = await executeCriticalTransaction('deploy:token-a', 'OPEN_POSITION token-a', deps, repo);

    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.data).toEqual({ verified: true });
      expect(result.attempt.status).toBe('VERIFIED');
    }
    expect(deps.buildTransaction).toHaveBeenCalledTimes(1);
    expect(deps.simulate).toHaveBeenCalledTimes(1);
    expect(deps.signTransaction).toHaveBeenCalledTimes(1);
    expect(deps.broadcastRaw).toHaveBeenCalledTimes(1);
    expect(deps.verifyOnChain).toHaveBeenCalledTimes(1);
  });

  it('persists the raw tx and hash before broadcasting', async () => {
    const repo = new InMemoryTransactionAttemptRepository();
    await executeCriticalTransaction('deploy:token-b', 'p', makeDeps(), repo);
    const record = await repo.find('deploy:token-b');
    expect(record?.rawTx).toBe(RAW_TX);
    expect(record?.txHash).toBe(TX_HASH);
  });
});

describe('executeCriticalTransaction -- failure at each stage is definitive (resumable:false) when backed by an on-chain/pre-broadcast fact', () => {
  it('simulation rejection -> FAILED, never sends anything', async () => {
    const repo = new InMemoryTransactionAttemptRepository();
    const deps = makeDeps({ simulate: vi.fn(async () => ({ ok: false, reason: 'would revert: INSUFFICIENT_LIQUIDITY' })) });
    const result = await executeCriticalTransaction('k1', 'p', deps, repo);

    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.resumable).toBe(false);
      expect(result.attempt.status).toBe('FAILED');
    }
    expect(deps.signTransaction).not.toHaveBeenCalled();
    expect(deps.broadcastRaw).not.toHaveBeenCalled();
  });

  it('gas unaffordable -> FAILED, never sends anything', async () => {
    const repo = new InMemoryTransactionAttemptRepository();
    const deps = makeDeps({ checkGasAffordable: vi.fn(async () => ({ ok: false, reason: 'insufficient ETH for gas' })) });
    const result = await executeCriticalTransaction('k2', 'p', deps, repo);

    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.resumable).toBe(false);
    expect(deps.getNonce).not.toHaveBeenCalled();
    expect(deps.broadcastRaw).not.toHaveBeenCalled();
  });

  it('receipt status reverted -> FAILED (a definitive on-chain fact)', async () => {
    const repo = new InMemoryTransactionAttemptRepository();
    const deps = makeDeps({ waitForReceipt: vi.fn(async () => ({ status: 'reverted' as const, blockNumber: 5n })) });
    const result = await executeCriticalTransaction('k3', 'p', deps, repo);

    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.resumable).toBe(false);
      expect(result.attempt.status).toBe('FAILED');
    }
    expect(deps.verifyOnChain).not.toHaveBeenCalled();
  });

  it('on-chain verification mismatch -> FAILED even though the tx itself confirmed', async () => {
    const repo = new InMemoryTransactionAttemptRepository();
    const deps = makeDeps({
      verifyOnChain: vi.fn(async () => ({ ok: false as const, reason: 'position NFT liquidity does not match expected amount' })),
    });
    const result = await executeCriticalTransaction('k4', 'p', deps, repo);

    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.resumable).toBe(false);
    const record = await repo.find('k4');
    expect(record?.status).toBe('FAILED');
  });
});

describe('executeCriticalTransaction -- ambiguous failures never declare FAILED, and are resumable', () => {
  it('broadcast throwing leaves status at SIGNED (hash already known) and reports resumable:true', async () => {
    const repo = new InMemoryTransactionAttemptRepository();
    const deps = makeDeps({ broadcastRaw: vi.fn(async () => { throw new Error('ECONNRESET'); }) });
    const result = await executeCriticalTransaction('k5', 'p', deps, repo);

    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.resumable).toBe(true);
    const record = await repo.find('k5');
    expect(record?.status).toBe('SIGNED'); // NOT FAILED
    expect(record?.txHash).toBe(TX_HASH); // hash survives for the resume
  });

  it('an unexpected throw during simulate leaves status at BUILT and is resumable', async () => {
    const repo = new InMemoryTransactionAttemptRepository();
    const deps = makeDeps({ simulate: vi.fn(async () => { throw new Error('RPC timeout'); }) });
    const result = await executeCriticalTransaction('k6', 'p', deps, repo);

    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.resumable).toBe(true);
    const record = await repo.find('k6');
    expect(record?.status).toBe('BUILT');
  });

  it('an unexpected throw during waitForReceipt leaves status at SENT and is resumable', async () => {
    const repo = new InMemoryTransactionAttemptRepository();
    const deps = makeDeps({ waitForReceipt: vi.fn(async () => { throw new Error('provider dropped connection'); }) });
    const result = await executeCriticalTransaction('k7', 'p', deps, repo);

    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.resumable).toBe(true);
    const record = await repo.find('k7');
    expect(record?.status).toBe('SENT');
  });
});

describe('executeCriticalTransaction -- idempotency and resume', () => {
  it('calling again with the same key after VERIFIED does not re-run any step', async () => {
    const repo = new InMemoryTransactionAttemptRepository();
    const deps = makeDeps();
    await executeCriticalTransaction('k8', 'p', deps, repo);
    const second = await executeCriticalTransaction('k8', 'p', deps, repo);

    expect(second.ok).toBe(true);
    expect(deps.buildTransaction).toHaveBeenCalledTimes(1); // not called again
    expect(deps.broadcastRaw).toHaveBeenCalledTimes(1);
    expect(repo.size()).toBe(1); // no duplicate row created
  });

  it('calling again after a definitive FAILED returns the cached failure without re-running anything', async () => {
    const repo = new InMemoryTransactionAttemptRepository();
    const deps = makeDeps({ simulate: vi.fn(async () => ({ ok: false, reason: 'nope' })) });
    await executeCriticalTransaction('k9', 'p', deps, repo);
    const second = await executeCriticalTransaction('k9', 'p', deps, repo);

    expect(second.ok).toBe(false);
    expect(deps.simulate).toHaveBeenCalledTimes(1); // not re-run
    expect(deps.buildTransaction).toHaveBeenCalledTimes(1);
  });

  it('resumes from SIGNED after a broadcast failure: retrying does not re-sign or re-assign a nonce', async () => {
    const repo = new InMemoryTransactionAttemptRepository();
    let shouldFailBroadcast = true;
    const deps = makeDeps({
      broadcastRaw: vi.fn(async () => {
        if (shouldFailBroadcast) throw new Error('ECONNRESET');
      }),
    });

    const first = await executeCriticalTransaction('k10', 'p', deps, repo);
    expect(first.ok).toBe(false);

    shouldFailBroadcast = false;
    const second = await executeCriticalTransaction('k10', 'p', deps, repo);

    expect(second.ok).toBe(true);
    expect(deps.signTransaction).toHaveBeenCalledTimes(1); // never re-signed
    expect(deps.getNonce).toHaveBeenCalledTimes(1); // never re-assigned a nonce
    expect(deps.broadcastRaw).toHaveBeenCalledTimes(2); // retried
  });

  it('resumes from SENT after a waitForReceipt failure: retrying does not re-broadcast', async () => {
    const repo = new InMemoryTransactionAttemptRepository();
    let shouldFailReceipt = true;
    const deps = makeDeps({
      waitForReceipt: vi.fn(async () => {
        if (shouldFailReceipt) throw new Error('provider dropped connection');
        return { status: 'success' as const, blockNumber: 1n };
      }),
    });

    const first = await executeCriticalTransaction('k11', 'p', deps, repo);
    expect(first.ok).toBe(false);

    shouldFailReceipt = false;
    const second = await executeCriticalTransaction('k11', 'p', deps, repo);

    expect(second.ok).toBe(true);
    expect(deps.broadcastRaw).toHaveBeenCalledTimes(1); // never re-sent
    expect(deps.signTransaction).toHaveBeenCalledTimes(1);
  });

  it('two different idempotencyKeys never share or interfere with each other\'s state', async () => {
    const repo = new InMemoryTransactionAttemptRepository();
    const depsA = makeDeps();
    const depsB = makeDeps({ simulate: vi.fn(async () => ({ ok: false, reason: 'reject B' })) });

    const resultA = await executeCriticalTransaction('tokenA', 'p', depsA, repo);
    const resultB = await executeCriticalTransaction('tokenB', 'p', depsB, repo);

    expect(resultA.ok).toBe(true);
    expect(resultB.ok).toBe(false);
    expect(repo.size()).toBe(2);
  });
});

describe('executeCriticalTransaction -- broadcast-time classification (deterministic vs ambiguous)', () => {
  it('"already known" is NOT a failure -- proceeds to CONFIRMED/VERIFIED normally', async () => {
    const repo = new InMemoryTransactionAttemptRepository();
    const deps = makeDeps({
      broadcastRaw: vi.fn(async () => {
        throw new Error('RPC Request failed.\n\nDetails: already known\nVersion: viem@2.0.0');
      }),
    });

    const result = await executeCriticalTransaction('bcast-1', 'p', deps, repo);

    expect(result.ok).toBe(true);
    if (result.ok) expect(result.attempt.status).toBe('VERIFIED');
    expect(deps.waitForReceipt).toHaveBeenCalledTimes(1);
    expect(deps.signTransaction).toHaveBeenCalledTimes(1); // never re-signed just because broadcast "failed"
  });

  it('"insufficient funds" at broadcast time is DEFINITIVE -- FAILED with BROADCAST_REJECTED, never retried', async () => {
    const repo = new InMemoryTransactionAttemptRepository();
    const deps = makeDeps({
      broadcastRaw: vi.fn(async () => {
        throw new Error('RPC Request failed.\n\nDetails: insufficient funds for gas * price + value\nVersion: viem@2.0.0');
      }),
    });

    const result = await executeCriticalTransaction('bcast-2', 'p', deps, repo);

    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.resumable).toBe(false);
      expect(result.stuck).toBe(false);
      expect(result.attempt.failureCode).toBe('BROADCAST_REJECTED');
      expect(result.attempt.status).toBe('FAILED');
    }
    expect(deps.waitForReceipt).not.toHaveBeenCalled();

    // Calling again must not re-broadcast -- it's cached as a definitive failure.
    const again = await executeCriticalTransaction('bcast-2', 'p', deps, repo);
    expect(again.ok).toBe(false);
    expect(deps.broadcastRaw).toHaveBeenCalledTimes(1);
  });

  it('"nonce too low" where OUR OWN tx hash already has a receipt -- treated as success, not failure', async () => {
    const repo = new InMemoryTransactionAttemptRepository();
    const deps = makeDeps({
      broadcastRaw: vi.fn(async () => {
        throw new Error('RPC Request failed.\n\nDetails: nonce too low\nVersion: viem@2.0.0');
      }),
      getReceiptIfAvailable: vi.fn(async () => ({ status: 'success' as const, blockNumber: 42n })),
    });

    const result = await executeCriticalTransaction('bcast-3', 'p', deps, repo);

    expect(result.ok).toBe(true);
    if (result.ok) expect(result.attempt.status).toBe('VERIFIED');
    expect(deps.getReceiptIfAvailable).toHaveBeenCalledTimes(1);
  });

  it('"nonce too low" where our own tx hash has NO receipt -- this exact payload is dead, FAILED definitively', async () => {
    const repo = new InMemoryTransactionAttemptRepository();
    const deps = makeDeps({
      broadcastRaw: vi.fn(async () => {
        throw new Error('RPC Request failed.\n\nDetails: nonce too low\nVersion: viem@2.0.0');
      }),
      getReceiptIfAvailable: vi.fn(async () => null),
    });

    const result = await executeCriticalTransaction('bcast-4', 'p', deps, repo);

    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.resumable).toBe(false);
      expect(result.attempt.failureCode).toBe('BROADCAST_REJECTED');
    }
  });

  it('"replacement transaction underpriced" follows the same disambiguation path as "nonce too low"', async () => {
    const repo = new InMemoryTransactionAttemptRepository();
    const deps = makeDeps({
      broadcastRaw: vi.fn(async () => {
        throw new Error('replacement transaction underpriced');
      }),
      getReceiptIfAvailable: vi.fn(async () => null),
    });

    const result = await executeCriticalTransaction('bcast-5', 'p', deps, repo);
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.attempt.failureCode).toBe('BROADCAST_REJECTED');
  });

  it('if the disambiguation receipt check itself throws, stays ambiguous/resumable -- never guesses', async () => {
    const repo = new InMemoryTransactionAttemptRepository();
    const deps = makeDeps({
      broadcastRaw: vi.fn(async () => {
        throw new Error('nonce too low');
      }),
      getReceiptIfAvailable: vi.fn(async () => {
        throw new Error('RPC unavailable');
      }),
    });

    const result = await executeCriticalTransaction('bcast-6', 'p', deps, repo);

    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.resumable).toBe(true);
      expect(result.attempt.status).not.toBe('FAILED');
    }
  });

  it('an unrecognized broadcast error message stays AMBIGUOUS/resumable exactly as before (default not made more aggressive)', async () => {
    const repo = new InMemoryTransactionAttemptRepository();
    const deps = makeDeps({
      broadcastRaw: vi.fn(async () => {
        throw new Error('502 Bad Gateway');
      }),
    });

    const result = await executeCriticalTransaction('bcast-7', 'p', deps, repo);
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.resumable).toBe(true);
      expect(result.attempt.status).toBe('SIGNED');
    }
  });
});

describe('executeCriticalTransaction -- failureCode is set correctly for every definitive failure', () => {
  it('SIMULATION_REJECTED', async () => {
    const repo = new InMemoryTransactionAttemptRepository();
    const deps = makeDeps({ simulate: vi.fn(async () => ({ ok: false, reason: 'would revert' })) });
    const result = await executeCriticalTransaction('fc-1', 'p', deps, repo);
    if (!result.ok) expect(result.attempt.failureCode).toBe('SIMULATION_REJECTED');
  });

  it('GAS_UNAFFORDABLE', async () => {
    const repo = new InMemoryTransactionAttemptRepository();
    const deps = makeDeps({ checkGasAffordable: vi.fn(async () => ({ ok: false, reason: 'too poor' })) });
    const result = await executeCriticalTransaction('fc-2', 'p', deps, repo);
    if (!result.ok) expect(result.attempt.failureCode).toBe('GAS_UNAFFORDABLE');
  });

  it('REVERTED', async () => {
    const repo = new InMemoryTransactionAttemptRepository();
    const deps = makeDeps({ waitForReceipt: vi.fn(async () => ({ status: 'reverted' as const, blockNumber: 1n })) });
    const result = await executeCriticalTransaction('fc-3', 'p', deps, repo);
    if (!result.ok) expect(result.attempt.failureCode).toBe('REVERTED');
  });

  it('VERIFICATION_FAILED', async () => {
    const repo = new InMemoryTransactionAttemptRepository();
    const deps = makeDeps({ verifyOnChain: vi.fn(async () => ({ ok: false as const, reason: 'mismatch' })) });
    const result = await executeCriticalTransaction('fc-4', 'p', deps, repo);
    if (!result.ok) expect(result.attempt.failureCode).toBe('VERIFICATION_FAILED');
  });
});

describe('executeCriticalTransaction -- stuck-attempt tracking', () => {
  it('tracks attemptCount and firstAttemptedAt across resumed calls, and surfaces stuck:true once the retry threshold is hit', async () => {
    const repo = new InMemoryTransactionAttemptRepository();
    const deps = makeDeps({
      broadcastRaw: vi.fn(async () => {
        throw new Error('ECONNRESET'); // ambiguous, resumable every time
      }),
    });

    let lastResult;
    for (let i = 0; i < 5; i++) {
      lastResult = await executeCriticalTransaction('stuck-1', 'p', deps, repo);
    }

    expect(lastResult?.ok).toBe(false);
    if (lastResult && !lastResult.ok) {
      expect(lastResult.attempt.attemptCount).toBe(5);
      expect(lastResult.resumable).toBe(true);
      expect(lastResult.stuck).toBe(true); // hit STUCK_ATTEMPT_MAX_RETRIES (5)
    }
  });

  it('is not stuck before the retry threshold is reached', async () => {
    const repo = new InMemoryTransactionAttemptRepository();
    const deps = makeDeps({
      broadcastRaw: vi.fn(async () => {
        throw new Error('ECONNRESET');
      }),
    });

    let lastResult;
    for (let i = 0; i < 3; i++) {
      lastResult = await executeCriticalTransaction('stuck-2', 'p', deps, repo);
    }

    if (lastResult && !lastResult.ok) {
      expect(lastResult.attempt.attemptCount).toBe(3);
      expect(lastResult.stuck).toBe(false);
    }
  });

  it('a definitive failure is never reported as stuck, even after many calls', async () => {
    const repo = new InMemoryTransactionAttemptRepository();
    const deps = makeDeps({ simulate: vi.fn(async () => ({ ok: false, reason: 'nope' })) });

    await executeCriticalTransaction('stuck-3', 'p', deps, repo);
    const second = await executeCriticalTransaction('stuck-3', 'p', deps, repo);

    expect(second.ok).toBe(false);
    if (!second.ok) {
      expect(second.resumable).toBe(false);
      expect(second.stuck).toBe(false);
    }
  });

  it('does not count a short-circuited VERIFIED re-call toward attemptCount', async () => {
    const repo = new InMemoryTransactionAttemptRepository();
    const deps = makeDeps();

    await executeCriticalTransaction('stuck-4', 'p', deps, repo);
    await executeCriticalTransaction('stuck-4', 'p', deps, repo);
    const third = await executeCriticalTransaction('stuck-4', 'p', deps, repo);

    expect(third.ok).toBe(true);
    expect(third.attempt.attemptCount).toBe(1); // only the first call actually did work
  });
});
