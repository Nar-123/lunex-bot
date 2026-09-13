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

describe('executeCriticalTransaction -- P1: resumable verification failure after on-chain confirmation', () => {
  const resumableFailure = () => vi.fn(async () => ({ ok: false as const, resumable: true, reason: 'proceeds could not be measured: RPC timeout' }));

  it('verifyOnChain {ok:false, resumable:true} keeps the attempt CONFIRMED with no failureCode, reports resumable:true, records the reason', async () => {
    const repo = new InMemoryTransactionAttemptRepository();
    const result = await executeCriticalTransaction('p1-a', 'p', makeDeps({ verifyOnChain: resumableFailure() }), repo);

    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.resumable).toBe(true);
      expect(result.attempt.status).toBe('CONFIRMED');
      expect(result.attempt.failureCode).toBeNull();
      expect(result.attempt.lastError).toMatch(/proceeds could not be measured/);
    }
  });

  it('resuming re-runs ONLY verifyOnChain against the persisted hash -- never rebuilds, re-simulates, re-signs, re-broadcasts, or re-waits', async () => {
    const repo = new InMemoryTransactionAttemptRepository();
    await executeCriticalTransaction('p1-b', 'p', makeDeps({ verifyOnChain: resumableFailure() }), repo);

    const resumeDeps = makeDeps();
    const resumed = await executeCriticalTransaction('p1-b', 'p', resumeDeps, repo);

    expect(resumed.ok).toBe(true);
    if (resumed.ok) expect(resumed.attempt.status).toBe('VERIFIED');
    expect(resumeDeps.buildTransaction).not.toHaveBeenCalled();
    expect(resumeDeps.simulate).not.toHaveBeenCalled();
    expect(resumeDeps.estimateGas).not.toHaveBeenCalled();
    expect(resumeDeps.getNonce).not.toHaveBeenCalled();
    expect(resumeDeps.signTransaction).not.toHaveBeenCalled();
    expect(resumeDeps.broadcastRaw).not.toHaveBeenCalled();
    expect(resumeDeps.waitForReceipt).not.toHaveBeenCalled();
    expect(resumeDeps.verifyOnChain).toHaveBeenCalledTimes(1);
    expect(resumeDeps.verifyOnChain).toHaveBeenCalledWith(TX_HASH);
  });

  it('repeated resumable failures never escalate to FAILED, while attemptCount keeps growing (stuck-detectable)', async () => {
    const repo = new InMemoryTransactionAttemptRepository();
    let last: Awaited<ReturnType<typeof executeCriticalTransaction>> | undefined;
    for (let i = 0; i < 6; i++) {
      last = await executeCriticalTransaction('p1-c', 'p', makeDeps({ verifyOnChain: resumableFailure() }), repo);
    }
    expect(last?.ok).toBe(false);
    if (last && !last.ok) {
      expect(last.resumable).toBe(true);
      expect(last.attempt.status).toBe('CONFIRMED');
      expect(last.attempt.attemptCount).toBe(6);
    }
  });

  it('a verification failure with resumable:false (or omitted) is still a definitive VERIFICATION_FAILED -- the original contract is unchanged', async () => {
    const repo = new InMemoryTransactionAttemptRepository();
    const deps = makeDeps({ verifyOnChain: vi.fn(async () => ({ ok: false as const, resumable: false, reason: 'liquidity still non-zero' })) });
    const result = await executeCriticalTransaction('p1-d', 'p', deps, repo);

    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.resumable).toBe(false);
      expect(result.attempt.status).toBe('FAILED');
      expect(result.attempt.failureCode).toBe('VERIFICATION_FAILED');
    }
  });
});

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

  it('C2 regression: a throw from verifyOnChain (e.g. mintTx.ts propagating an RPC error) leaves status at CONFIRMED, resumable, NEVER FAILED', async () => {
    const repo = new InMemoryTransactionAttemptRepository();
    const deps = makeDeps({ verifyOnChain: vi.fn(async () => { throw new Error('RPC timeout'); }) });
    const result = await executeCriticalTransaction('k12', 'p', deps, repo);

    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.resumable).toBe(true);
      expect(result.attempt.status).toBe('CONFIRMED'); // the receipt already confirmed on-chain success -- never downgraded to FAILED
      expect(result.attempt.failureCode).toBeNull(); // no VERIFICATION_FAILED classification for a transport error
    }

    // Resuming with a healthy verifyOnChain must succeed without re-broadcasting.
    const healthyDeps = makeDeps();
    const resumed = await executeCriticalTransaction('k12', 'p', healthyDeps, repo);
    expect(resumed.ok).toBe(true);
    expect(healthyDeps.broadcastRaw).not.toHaveBeenCalled();
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

  describe('H3 regression: an AMBIGUOUS broadcast error checks for a receipt before giving up the tick', () => {
    it('broadcast throws an unrecognized error but a receipt IS found under our own hash -- recognized as mined, proceeds to VERIFIED', async () => {
      const repo = new InMemoryTransactionAttemptRepository();
      const deps = makeDeps({
        broadcastRaw: vi.fn(async () => {
          throw new Error('502 Bad Gateway');
        }),
        getReceiptIfAvailable: vi.fn(async () => ({ status: 'success' as const, blockNumber: 99n })),
      });

      const result = await executeCriticalTransaction('h3-1', 'p', deps, repo);

      expect(result.ok).toBe(true);
      if (result.ok) expect(result.attempt.status).toBe('VERIFIED');
      expect(deps.getReceiptIfAvailable).toHaveBeenCalledTimes(1);
    });

    it('broadcast throws an unrecognized error and NO receipt is found -- stays resumable, never FAILED', async () => {
      const repo = new InMemoryTransactionAttemptRepository();
      const deps = makeDeps({
        broadcastRaw: vi.fn(async () => {
          throw new Error('502 Bad Gateway');
        }),
        getReceiptIfAvailable: vi.fn(async () => null),
      });

      const result = await executeCriticalTransaction('h3-2', 'p', deps, repo);

      expect(result.ok).toBe(false);
      if (!result.ok) {
        expect(result.resumable).toBe(true);
        expect(result.attempt.status).toBe('SIGNED');
        expect(result.attempt.status).not.toBe('FAILED');
      }
    });

    it('if the receipt check itself throws, stays ambiguous/resumable -- never guesses', async () => {
      const repo = new InMemoryTransactionAttemptRepository();
      const deps = makeDeps({
        broadcastRaw: vi.fn(async () => {
          throw new Error('502 Bad Gateway');
        }),
        getReceiptIfAvailable: vi.fn(async () => {
          throw new Error('RPC unavailable');
        }),
      });

      const result = await executeCriticalTransaction('h3-3', 'p', deps, repo);

      expect(result.ok).toBe(false);
      if (!result.ok) {
        expect(result.resumable).toBe(true);
        expect(result.attempt.status).not.toBe('FAILED');
      }
    });
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

describe('executeCriticalTransaction -- C7 regression: executor wallet concurrency', () => {
  it('two different idempotencyKeys racing concurrently NEVER receive the same nonce', async () => {
    const repo = new InMemoryTransactionAttemptRepository();
    let nextNonce = 0;
    // Simulates a real chain's `eth_getTransactionCount(pending)`: if two
    // calls were allowed to race unserialized, both could read the SAME
    // value before either increments it. The executor mutex must prevent
    // that by serializing the nonce-assignment -> sign -> broadcast span.
    const sharedGetNonce = vi.fn(async () => {
      const n = nextNonce;
      await new Promise((resolve) => setTimeout(resolve, 5)); // widen the race window
      nextNonce = n + 1;
      return n;
    });

    const depsA = makeDeps({ getNonce: sharedGetNonce });
    const depsB = makeDeps({ getNonce: sharedGetNonce });

    const [resultA, resultB] = await Promise.all([
      executeCriticalTransaction('nonce-race-A', 'p', depsA, repo),
      executeCriticalTransaction('nonce-race-B', 'p', depsB, repo),
    ]);

    expect(resultA.ok).toBe(true);
    expect(resultB.ok).toBe(true);
    const attemptA = await repo.find('nonce-race-A');
    const attemptB = await repo.find('nonce-race-B');
    expect(attemptA?.nonce).not.toBe(attemptB?.nonce);
    expect(new Set([attemptA?.nonce, attemptB?.nonce]).size).toBe(2);
  });

  it('serializes broadcast calls process-wide -- never two broadcasts in flight at once', async () => {
    const repo = new InMemoryTransactionAttemptRepository();
    let inFlight = 0;
    let maxConcurrentInFlight = 0;
    const trackedBroadcast = vi.fn(async () => {
      inFlight++;
      maxConcurrentInFlight = Math.max(maxConcurrentInFlight, inFlight);
      await new Promise((resolve) => setTimeout(resolve, 5));
      inFlight--;
    });

    const depsA = makeDeps({ broadcastRaw: trackedBroadcast });
    const depsB = makeDeps({ broadcastRaw: trackedBroadcast });
    const depsC = makeDeps({ broadcastRaw: trackedBroadcast });

    await Promise.all([
      executeCriticalTransaction('bcast-race-A', 'p', depsA, repo),
      executeCriticalTransaction('bcast-race-B', 'p', depsB, repo),
      executeCriticalTransaction('bcast-race-C', 'p', depsC, repo),
    ]);

    expect(maxConcurrentInFlight).toBe(1); // never more than one holder of the lock at a time
  });
});

describe('executeCriticalTransaction -- C1 regression: VERIFIED short-circuit must never return fabricated/undefined data', () => {
  it('persists verifyData atomically with status VERIFIED on the fresh-verify path', async () => {
    const repo = new InMemoryTransactionAttemptRepository();
    const deps = makeDeps();
    await executeCriticalTransaction('c1-1', 'p', deps, repo);

    const record = await repo.find('c1-1');
    expect(record?.status).toBe('VERIFIED');
    expect(record?.verifyData).toEqual({ verified: true });
  });

  it('CRASH-RECOVERY: process 1 verifies and crashes before markActive; process 2 resumes and gets the REAL data, not undefined', async () => {
    const repo = new InMemoryTransactionAttemptRepository();
    const deps = makeDeps();

    // "Process 1": runs the full pipeline through VERIFIED.
    const first = await executeCriticalTransaction('c1-2', 'deploy:mint', deps, repo);
    expect(first.ok).toBe(true);

    // "Process 2" (simulated restart): a brand-new call with the SAME key,
    // same deps, but verifyOnChain must NOT be invoked again -- the cached
    // verifyData must be returned directly.
    const verifyOnChainCallsBefore = (deps.verifyOnChain as ReturnType<typeof vi.fn>).mock.calls.length;
    const resumed = await executeCriticalTransaction('c1-2', 'deploy:mint', deps, repo);

    expect(resumed.ok).toBe(true);
    if (resumed.ok) {
      expect(resumed.data).toEqual({ verified: true }); // the historical bug returned `undefined` here
    }
    expect((deps.verifyOnChain as ReturnType<typeof vi.fn>).mock.calls.length).toBe(verifyOnChainCallsBefore);
  });

  it('a VERIFIED attempt with missing verifyData (legacy row) is safely reconstructed via verifyOnChain, never FAILED', async () => {
    const repo = new InMemoryTransactionAttemptRepository();
    const deps = makeDeps();

    await executeCriticalTransaction('c1-3', 'p', deps, repo);
    const attempt = await repo.find('c1-3');
    if (!attempt) throw new Error('unreachable');
    // Simulate a pre-migration row: VERIFIED but verifyData was never persisted.
    await repo.update(attempt.id, { verifyData: null });

    const resumed = await executeCriticalTransaction('c1-3', 'p', deps, repo);
    expect(resumed.ok).toBe(true);
    if (resumed.ok) {
      expect(resumed.data).toEqual({ verified: true }); // reconstructed via a fresh verifyOnChain call
      expect(resumed.attempt.status).toBe('VERIFIED');
    }
    // verifyData is backfilled so subsequent resumes don't need to reconstruct again.
    const backfilled = await repo.find('c1-3');
    expect(backfilled?.verifyData).toEqual({ verified: true });
  });

  it('a VERIFIED attempt with missing verifyData AND a failing reconstruction stays resumable, NEVER FAILED (funds already on-chain)', async () => {
    const repo = new InMemoryTransactionAttemptRepository();
    const deps = makeDeps();

    await executeCriticalTransaction('c1-4', 'p', deps, repo);
    const attempt = await repo.find('c1-4');
    if (!attempt) throw new Error('unreachable');
    await repo.update(attempt.id, { verifyData: null });

    const flakyDeps = makeDeps({ verifyOnChain: vi.fn(async () => { throw new Error('RPC timeout'); }) });
    const resumed = await executeCriticalTransaction('c1-4', 'p', flakyDeps, repo);

    expect(resumed.ok).toBe(false);
    if (!resumed.ok) {
      expect(resumed.resumable).toBe(true);
      expect(resumed.attempt.status).toBe('VERIFIED'); // status is NEVER downgraded -- the op already succeeded on-chain
    }
  });

  it('a VERIFIED attempt with neither verifyData nor txHash stays resumable, never crashes, never FAILED', async () => {
    const repo = new InMemoryTransactionAttemptRepository();
    const deps = makeDeps();

    await executeCriticalTransaction('c1-5', 'p', deps, repo);
    const attempt = await repo.find('c1-5');
    if (!attempt) throw new Error('unreachable');
    await repo.update(attempt.id, { verifyData: null, txHash: null });

    const resumed = await executeCriticalTransaction('c1-5', 'p', deps, repo);
    expect(resumed.ok).toBe(false);
    if (!resumed.ok) {
      expect(resumed.resumable).toBe(true);
      expect(resumed.attempt.status).toBe('VERIFIED');
    }
  });
});
