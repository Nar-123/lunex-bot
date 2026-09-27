import { describe, expect, it, vi } from 'vitest';
import { executeCriticalTransaction } from '../../src/execution/executeCriticalTransaction';
import type { TxRequest, TxSafetyDeps } from '../../src/execution/types';
import { InMemoryTransactionAttemptRepository } from './inMemoryTransactionAttemptRepository';

/**
 * Adversarial nonce allocation under RPC FAILOVER, end to end through
 * `executeCriticalTransaction`.
 *
 * The scenario these tests reproduce: ordered failover means two consecutive
 * `getNonce()` calls can be served by two different providers, and `pending`
 * is exactly what providers disagree about right after a broadcast -- one has
 * the transaction in its mempool, the next does not. A perfectly serialized
 * second transaction could therefore still be handed a nonce that is already
 * spoken for and sign a SECOND payload under it.
 *
 * `ExecutorMutex` is not the thing under test here: it prevents interleaving,
 * not staleness. What is under test is that persisted state, not the
 * provider's answer, decides the allocation.
 */

const TX: TxRequest = { to: '0x1111111111111111111111111111111111111111', data: '0xabcdef', value: 0n };

/** A distinct signed payload per attempt+nonce, so a shared nonce would show up as two different hashes. */
function payloadFor(key: string, nonce: number): { raw: `0x${string}`; hash: `0x${string}` } {
  const tag = Buffer.from(key + ':' + String(nonce)).toString('hex').padEnd(64, '0').slice(0, 64);
  return { raw: ('0x' + tag) as `0x${string}`, hash: ('0x' + tag) as `0x${string}` };
}

interface ProviderView {
  /** What `getNonce()` returns on each successive call -- one entry per call, the last value repeating. */
  answers: number[];
}

type Deps = TxSafetyDeps<{ verified: true }>;

function makeDeps(key: string, view: ProviderView, overrides: Partial<Deps> = {}): Deps {
  let call = 0;
  const signedNonces: number[] = [];
  const deps: Deps = {
    buildTransaction: vi.fn(async () => TX),
    simulate: vi.fn(async () => ({ ok: true }) as const),
    estimateGas: vi.fn(async () => 100_000n),
    getGasPrice: vi.fn(async () => 1_000_000_000n),
    checkGasAffordable: vi.fn(async () => ({ ok: true }) as const),
    getNonce: vi.fn(async () => {
      const answer = view.answers[Math.min(call, view.answers.length - 1)] as number;
      call += 1;
      return answer;
    }),
    signTransaction: vi.fn(async (_tx: TxRequest, nonce: number) => {
      signedNonces.push(nonce);
      return payloadFor(key, nonce);
    }),
    broadcastRaw: vi.fn(async () => undefined),
    waitForReceipt: vi.fn(async () => ({ status: 'success' as const, blockNumber: 123n })),
    getReceiptIfAvailable: vi.fn(async () => null),
    verifyOnChain: vi.fn(async () => ({ ok: true as const, data: { verified: true as const } })),
    ...overrides,
  };
  Object.defineProperty(deps, 'signedNonces', { value: signedNonces, enumerable: false });
  return deps;
}

const signedNoncesOf = (deps: Deps): number[] => (deps as unknown as { signedNonces: number[] }).signedNonces;

/** Every nonce any attempt in storage has signed a payload under (terminal rows included). */
async function persistedSignedNonces(repo: InMemoryTransactionAttemptRepository): Promise<number[]> {
  const all = await repo.findByKeyPrefixes(['']);
  return all.filter((a) => a.rawTx !== null && a.nonce !== null).map((a) => a.nonce as number);
}

const unavailableVerification = (): Deps['verifyOnChain'] =>
  vi.fn(async () => ({ ok: false as const, resumable: true, reason: 'proceeds unreadable: RPC timeout' }));

/**
 * Makes the FIRST repository write matching `predicate` throw, then behaves
 * normally. Targeted by patch CONTENT rather than call index, so the test
 * pins the checkpoint it means (the signed-payload persist) and cannot drift
 * when the pipeline gains or loses an unrelated write.
 */
function failFirstWrite(
  repo: InMemoryTransactionAttemptRepository,
  predicate: (patch: Record<string, unknown>) => boolean,
): { restore: () => void } {
  const original = repo.update.bind(repo);
  let fired = false;
  const spy = vi.spyOn(repo, 'update').mockImplementation(async (id, patch, expectedVersion) => {
    if (!fired && predicate(patch as Record<string, unknown>)) {
      fired = true;
      throw new Error('database is locked');
    }
    return original(id, patch, expectedVersion);
  });
  return { restore: () => spy.mockRestore() };
}

/** The signed-checkpoint persist -- the write that stores rawTx/txHash. */
const isSignedPersist = (patch: Record<string, unknown>): boolean => patch.rawTx !== undefined;

describe('(b) transaction A broadcasts, then transaction B starts with a STALE provider', () => {
  it('B does not reuse A nonce even though its provider still reports the old pending count', async () => {
    const repo = new InMemoryTransactionAttemptRepository();

    // A: provider says pending = 5. A signs and broadcasts nonce 5.
    const depsA = makeDeps('a', { answers: [5] });
    const resultA = await executeCriticalTransaction('tx-a', 'p', depsA, repo);
    expect(resultA.ok).toBe(true);
    expect(signedNoncesOf(depsA)).toEqual([5]);

    // B: failover routes its read to a provider that has NOT seen A yet -- it
    // still answers 5. Pre-fix, B signed a second payload under nonce 5.
    const depsB = makeDeps('b', { answers: [5] });
    const resultB = await executeCriticalTransaction('tx-b', 'p', depsB, repo);

    expect(resultB.ok).toBe(true);
    expect(signedNoncesOf(depsB)).toEqual([6]);
    expect(signedNoncesOf(depsB)).not.toContain(5);
  });

  it('holds when A is still IN FLIGHT (broadcast, verification unavailable) rather than complete', async () => {
    const repo = new InMemoryTransactionAttemptRepository();

    const depsA = makeDeps('a', { answers: [5] }, { verifyOnChain: unavailableVerification() });
    const resultA = await executeCriticalTransaction('tx-a', 'p', depsA, repo);
    expect(resultA.ok).toBe(false);
    if (!resultA.ok) expect(resultA.attempt.status).toBe('CONFIRMED');

    const depsB = makeDeps('b', { answers: [5] });
    await executeCriticalTransaction('tx-b', 'p', depsB, repo);

    expect(signedNoncesOf(depsB)).toEqual([6]);
  });

  it('a provider lagging by SEVERAL transactions still cannot cause a collision', async () => {
    const repo = new InMemoryTransactionAttemptRepository();

    for (const [i, key] of ['t0', 't1', 't2'].entries()) {
      // Every read comes back stale at 5, as if one provider never updates.
      const deps = makeDeps(key, { answers: [5] });
      await executeCriticalTransaction(key, 'p', deps, repo);
      expect(signedNoncesOf(deps)).toEqual([5 + i]);
    }

    const nonces = await persistedSignedNonces(repo);
    expect(new Set(nonces).size).toBe(nonces.length);
  });

  it('a provider that is AHEAD is believed -- the chain can always move the nonce forward', async () => {
    const repo = new InMemoryTransactionAttemptRepository();
    await executeCriticalTransaction('ahead-a', 'p', makeDeps('a', { answers: [5] }), repo);

    // Something outside this bot moved the account on (or a fallback is simply
    // further along): 40 is above every local record, so it wins.
    const depsB = makeDeps('b', { answers: [40] });
    await executeCriticalTransaction('ahead-b', 'p', depsB, repo);

    expect(signedNoncesOf(depsB)).toEqual([40]);
  });
});

describe('(c) concurrent critical transactions on the same executor', () => {
  it('two concurrent calls get DIFFERENT nonces, despite an identical stale provider answer', async () => {
    const repo = new InMemoryTransactionAttemptRepository();
    const depsA = makeDeps('a', { answers: [9] });
    const depsB = makeDeps('b', { answers: [9] });

    const [resultA, resultB] = await Promise.all([
      executeCriticalTransaction('conc-a', 'p', depsA, repo),
      executeCriticalTransaction('conc-b', 'p', depsB, repo),
    ]);

    expect(resultA.ok).toBe(true);
    expect(resultB.ok).toBe(true);
    expect([...signedNoncesOf(depsA), ...signedNoncesOf(depsB)].sort((x, y) => x - y)).toEqual([9, 10]);
  });

  it('five concurrent calls allocate five distinct nonces', async () => {
    const repo = new InMemoryTransactionAttemptRepository();
    const keys = ['c0', 'c1', 'c2', 'c3', 'c4'];
    const depsList = keys.map((k) => makeDeps(k, { answers: [20] }));

    const results = await Promise.all(
      keys.map((k, i) => executeCriticalTransaction(k, 'p', depsList[i] as Deps, repo)),
    );

    expect(results.every((r) => r.ok)).toBe(true);
    expect(depsList.flatMap((d) => signedNoncesOf(d)).sort((x, y) => x - y)).toEqual([20, 21, 22, 23, 24]);
  });

  it('concurrent calls for the SAME idempotency key still produce exactly one nonce and one payload', async () => {
    // Idempotency must not be weakened by the new reads: the same logical
    // operation is one transaction, not two.
    const repo = new InMemoryTransactionAttemptRepository();
    const depsA = makeDeps('same', { answers: [11] });
    const depsB = makeDeps('same', { answers: [11] });

    await Promise.all([
      executeCriticalTransaction('same-key', 'p', depsA, repo).catch(() => undefined),
      executeCriticalTransaction('same-key', 'p', depsB, repo).catch(() => undefined),
    ]);

    const signed = [...signedNoncesOf(depsA), ...signedNoncesOf(depsB)];
    expect(new Set(signed).size).toBe(1);
    expect(signed[0]).toBe(11);
    const nonces = await persistedSignedNonces(repo);
    expect(nonces).toEqual([11]);
  });
});

describe('(d) restart / resume of an attempt that already persisted a nonce', () => {
  it('resume reuses the PERSISTED nonce and never consults a provider again', async () => {
    const repo = new InMemoryTransactionAttemptRepository();

    // First pass: signed and broadcast under nonce 5, verification unavailable
    // -- the attempt stays non-terminal with nonce 5 persisted.
    const first = makeDeps('r', { answers: [5] }, { verifyOnChain: unavailableVerification() });
    await executeCriticalTransaction('resume-1', 'p', first, repo);

    // Process restart: brand-new deps, and the provider now answers something
    // completely different (far ahead).
    const afterRestart = makeDeps('r', { answers: [99] });
    const resumed = await executeCriticalTransaction('resume-1', 'p', afterRestart, repo);

    expect(resumed.ok).toBe(true);
    expect(afterRestart.getNonce).not.toHaveBeenCalled();
    expect(afterRestart.signTransaction).not.toHaveBeenCalled();
    expect(afterRestart.broadcastRaw).not.toHaveBeenCalled();
    if (resumed.ok) expect(resumed.attempt.nonce).toBe(5);
  });

  it('a crash between SIGN and its persist re-signs under the SAME nonce, never a fresh one', async () => {
    const repo = new InMemoryTransactionAttemptRepository();

    // The signed-checkpoint persist fails, so nonce 5 IS persisted but rawTx
    // is not -- the exact window the SIGNED checkpoint exists to make safe.
    const injected = failFirstWrite(repo, isSignedPersist);
    const crashing = makeDeps('x', { answers: [5] });
    const crashed = await executeCriticalTransaction('crash-1', 'p', crashing, repo);
    injected.restore();

    expect(crashed.ok).toBe(false);
    if (!crashed.ok) {
      expect(crashed.resumable).toBe(true);
      expect(crashed.attempt.status).toBe('NONCE_ASSIGNED');
      expect(crashed.attempt.nonce).toBe(5);
      expect(crashed.attempt.rawTx).toBeNull();
    }

    // Resume: the SAME nonce is re-signed, and the provider is not asked again.
    const resumeDeps = makeDeps('x', { answers: [77] });
    const resumed = await executeCriticalTransaction('crash-1', 'p', resumeDeps, repo);

    expect(resumed.ok).toBe(true);
    expect(resumeDeps.getNonce).not.toHaveBeenCalled();
    expect(signedNoncesOf(resumeDeps)).toEqual([5]);
  });

  it('a nonce assigned to an attempt that FAILED before signing is reclaimable', async () => {
    const repo = new InMemoryTransactionAttemptRepository();

    // Local signing throw: a definitive pre-broadcast fact -> FAILED, and the
    // nonce was provably never used on-chain.
    const failing = makeDeps('x', { answers: [5] }, {
      signTransaction: vi.fn(async () => {
        throw new Error('signer unavailable');
      }),
    });
    const failed = await executeCriticalTransaction('pre-sign-fail', 'p', failing, repo);
    expect(failed.ok).toBe(false);
    if (!failed.ok) {
      expect(failed.resumable).toBe(false);
      expect(failed.attempt.nonce).toBe(5);
      expect(failed.attempt.rawTx).toBeNull();
    }

    // The chain still sits at 5 and nothing is in flight there -- a genuinely
    // new attempt must be able to take it, or 5 becomes a permanent hole that
    // blocks every later transaction.
    const next = makeDeps('y', { answers: [5] });
    await executeCriticalTransaction('after-fail', 'p', next, repo);

    expect(signedNoncesOf(next)).toEqual([5]);
  });

  it('after a restart the reservation is read from STORAGE, not from process memory', async () => {
    const repo = new InMemoryTransactionAttemptRepository();
    await executeCriticalTransaction(
      'restart-a',
      'p',
      makeDeps('a', { answers: [5] }, { verifyOnChain: unavailableVerification() }),
      repo,
    );

    // Fresh deps stand in for the restarted process; the repository IS the
    // persistent store, so it is deliberately the same instance.
    const depsB = makeDeps('b', { answers: [5] });
    await executeCriticalTransaction('restart-b', 'p', depsB, repo);

    expect(signedNoncesOf(depsB)).toEqual([6]);
  });
});

describe('(e) no duplicate nonce among non-terminal attempts', () => {
  it('ten sequential transactions against a frozen provider produce ten unique nonces', async () => {
    const repo = new InMemoryTransactionAttemptRepository();

    for (let i = 0; i < 10; i++) {
      // The provider never advances -- the worst case for staleness.
      await executeCriticalTransaction('seq-' + String(i), 'p', makeDeps('seq-' + String(i), { answers: [3] }), repo);
    }

    const nonces = await persistedSignedNonces(repo);
    expect(nonces.sort((a, b) => a - b)).toEqual([3, 4, 5, 6, 7, 8, 9, 10, 11, 12]);
  });

  it('a nonce held by a non-terminal attempt is never handed out again', async () => {
    const repo = new InMemoryTransactionAttemptRepository();
    await executeCriticalTransaction(
      'stuck-1',
      'p',
      makeDeps('stuck', { answers: [4] }, { verifyOnChain: unavailableVerification() }),
      repo,
    );

    for (let i = 0; i < 3; i++) {
      const deps = makeDeps('later-' + String(i), { answers: [4] });
      await executeCriticalTransaction('later-' + String(i), 'p', deps, repo);
      expect(signedNoncesOf(deps)).not.toContain(4);
    }
  });

  it('a nonce reserved at NONCE_ASSIGNED (nothing signed yet) is already respected', async () => {
    const repo = new InMemoryTransactionAttemptRepository();

    // Reserve nonce 8 without ever signing: the nonce is persisted, then the
    // signed-checkpoint persist fails. Nothing was broadcast, so the ONLY
    // record of 8 is the reservation itself -- `highestSignedNonce` is null
    // here, which is precisely why the reserved scan has to exist too.
    const injected = failFirstWrite(repo, isSignedPersist);
    const reserving = makeDeps('res', { answers: [8] });
    const reserved = await executeCriticalTransaction('reserve', 'p', reserving, repo);
    injected.restore();

    expect(reserved.ok).toBe(false);
    if (!reserved.ok) {
      expect(reserved.attempt.status).toBe('NONCE_ASSIGNED');
      expect(reserved.attempt.nonce).toBe(8);
      expect(reserved.attempt.rawTx).toBeNull();
    }
    expect(await repo.findSignedNoncesAtOrAbove(0)).toEqual([]);

    const other = makeDeps('other', { answers: [8] });
    await executeCriticalTransaction('other', 'p', other, repo);

    expect(signedNoncesOf(other)).toEqual([9]);
    expect(signedNoncesOf(other)).not.toContain(8);
  });
});

describe('a persisted SIGNED nonce is never reused, even once its attempt is terminal', () => {
  it('a nonce whose payload was signed then definitively rejected is NOT handed out again', async () => {
    const repo = new InMemoryTransactionAttemptRepository();

    // A signs nonce 5, the node rejects it "nonce too low", and no receipt
    // exists under A's own hash -> FAILED, with rawTx persisted. The nonce was
    // consumed by SOMETHING (that is what "nonce too low" means), so it is
    // dead, not free.
    const depsA = makeDeps('a', { answers: [5] }, {
      broadcastRaw: vi.fn(async () => {
        throw new Error('nonce too low');
      }),
      getReceiptIfAvailable: vi.fn(async () => null),
    });
    const failed = await executeCriticalTransaction('dead-5', 'p', depsA, repo);

    expect(failed.ok).toBe(false);
    if (!failed.ok) {
      expect(failed.resumable).toBe(false);
      expect(failed.attempt.status).toBe('FAILED');
      expect(failed.attempt.nonce).toBe(5);
      expect(failed.attempt.rawTx).not.toBeNull();
    }

    // The attempt is terminal, so the reserved scan cannot see it -- only the
    // signed high-water mark can. A stale provider still says 5.
    expect(await repo.findNonTerminal()).toHaveLength(0);
    const depsB = makeDeps('b', { answers: [5] });
    await executeCriticalTransaction('after-dead-5', 'p', depsB, repo);

    expect(signedNoncesOf(depsB)).toEqual([6]);
    expect(signedNoncesOf(depsB)).not.toContain(5);
  });

  it('a VERIFIED (terminal, invisible to findNonTerminal) nonce is likewise never reused', async () => {
    const repo = new InMemoryTransactionAttemptRepository();
    const depsA = makeDeps('a', { answers: [30] });
    const done = await executeCriticalTransaction('verified-30', 'p', depsA, repo);

    expect(done.ok).toBe(true);
    if (done.ok) expect(done.attempt.status).toBe('VERIFIED');
    expect(await repo.findNonTerminal()).toHaveLength(0);

    const depsB = makeDeps('b', { answers: [30] });
    await executeCriticalTransaction('after-verified-30', 'p', depsB, repo);

    expect(signedNoncesOf(depsB)).toEqual([31]);
  });
});

describe('executor key rotation -- storage outlives the identity', () => {
  it('REGRESSION: a new executor at nonce 0 is not given the OLD wallet next nonce', async () => {
    const repo = new InMemoryTransactionAttemptRepository();

    // The old executor's history: a completed transaction at nonce 1609.
    const old = makeDeps('old', { answers: [1609] });
    const done = await executeCriticalTransaction('old-wallet-tx', 'p', old, repo);
    expect(done.ok).toBe(true);
    expect(await repo.findSignedNoncesAtOrAbove(0)).toEqual([1609]);

    // PRIVATE_KEY is rotated. Same database, brand-new account at nonce 0.
    const rotated = makeDeps('new', { answers: [0] });
    const result = await executeCriticalTransaction('new-wallet-tx', 'p', rotated, repo);

    expect(result.ok).toBe(true);
    // Pre-fix this signed 1610 -- a far-future nonce on a fresh account, which
    // a node accepts and never mines. No error anywhere; the entry just hangs.
    expect(signedNoncesOf(rotated)).toEqual([0]);
  });

  it('a rotation needs no adjustment at all -- the chain answer stands', async () => {
    const repo = new InMemoryTransactionAttemptRepository();
    await executeCriticalTransaction('old-tx', 'p', makeDeps('old', { answers: [1609] }), repo);

    const log = vi.fn();
    await executeCriticalTransaction('new-tx', 'p', makeDeps('new', { answers: [0] }), repo, { log });

    // Nothing was skipped, so there is nothing to report: the old wallet's
    // nonces simply are not at the new account's pointer.
    expect(log).not.toHaveBeenCalledWith('nonce_allocation_adjusted', expect.anything());
  });

  it('the rotated executor then advances normally, one nonce at a time', async () => {
    const repo = new InMemoryTransactionAttemptRepository();
    await executeCriticalTransaction('old-tx', 'p', makeDeps('old', { answers: [1609] }), repo);

    // Three transactions on the new account, each against a frozen provider.
    for (let i = 0; i < 3; i++) {
      const deps = makeDeps('new-' + String(i), { answers: [i] });
      await executeCriticalTransaction('new-' + String(i), 'p', deps, repo);
      expect(signedNoncesOf(deps)).toEqual([i]);
    }
  });
});

describe('failure handling is unchanged -- staleness never becomes a FAILED verdict', () => {
  it('a nonce read that throws leaves the attempt resumable with NO nonce persisted', async () => {
    const repo = new InMemoryTransactionAttemptRepository();
    const deps = makeDeps('t', { answers: [5] }, {
      getNonce: vi.fn(async () => {
        throw new Error('HTTP request failed: 429 Monthly capacity limit exceeded');
      }),
    });

    const result = await executeCriticalTransaction('throw-1', 'p', deps, repo);

    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.resumable).toBe(true);
      expect(result.attempt.status).toBe('GAS_CHECKED');
      expect(result.attempt.nonce).toBeNull();
      expect(result.attempt.failureCode).toBeNull();
    }
    expect(deps.signTransaction).not.toHaveBeenCalled();
    expect(deps.broadcastRaw).not.toHaveBeenCalled();
  });

  it('a findNonTerminal failure during allocation is resumable, never FAILED, and signs nothing', async () => {
    const repo = new InMemoryTransactionAttemptRepository();
    vi.spyOn(repo, 'findNonTerminal').mockRejectedValueOnce(new Error('database is locked'));
    const deps = makeDeps('t', { answers: [5] });

    const result = await executeCriticalTransaction('throw-3', 'p', deps, repo);

    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.resumable).toBe(true);
      expect(result.attempt.status).toBe('GAS_CHECKED');
      expect(result.attempt.nonce).toBeNull();
      expect(result.attempt.failureCode).toBeNull();
    }
    expect(deps.signTransaction).not.toHaveBeenCalled();
    expect(deps.broadcastRaw).not.toHaveBeenCalled();
  });

  it('a findSignedNoncesAtOrAbove failure during allocation is resumable, never FAILED, and signs nothing', async () => {
    const repo = new InMemoryTransactionAttemptRepository();
    vi.spyOn(repo, 'findSignedNoncesAtOrAbove').mockRejectedValueOnce(new Error('database is locked'));
    const deps = makeDeps('t', { answers: [5] });

    const result = await executeCriticalTransaction('throw-2', 'p', deps, repo);

    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.resumable).toBe(true);
      expect(result.attempt.nonce).toBeNull();
      expect(result.attempt.failureCode).toBeNull();
    }
    expect(deps.signTransaction).not.toHaveBeenCalled();
  });

  it('logs an explanatory event when the provider answer had to be overridden', async () => {
    const repo = new InMemoryTransactionAttemptRepository();
    await executeCriticalTransaction('log-a', 'p', makeDeps('a', { answers: [5] }), repo);

    const log = vi.fn();
    await executeCriticalTransaction('log-b', 'p', makeDeps('b', { answers: [5] }), repo, { log });

    expect(log).toHaveBeenCalledWith(
      'nonce_allocation_adjusted',
      expect.objectContaining({ chainPendingNonce: 5, allocatedNonce: 6, adjustedBy: 'ALREADY_SIGNED' }),
    );
  });

  it('stays silent when the provider answer was accepted as-is', async () => {
    const repo = new InMemoryTransactionAttemptRepository();
    const log = vi.fn();

    await executeCriticalTransaction('quiet', 'p', makeDeps('q', { answers: [5] }), repo, { log });

    expect(log).not.toHaveBeenCalledWith('nonce_allocation_adjusted', expect.anything());
  });
});
