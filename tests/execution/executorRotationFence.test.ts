import { describe, expect, it, vi } from 'vitest';
import { executeCriticalTransaction } from '../../src/execution/executeCriticalTransaction';
import type { TxRequest, TxSafetyDeps } from '../../src/execution/types';
import { InMemoryTransactionAttemptRepository } from './inMemoryTransactionAttemptRepository';

/**
 * EXECUTOR-OWNERSHIP FENCE.
 *
 * The invariant: **a nonce is owned by the executor that reserved it, and an
 * attempt is never re-SIGNED under a different wallet.**
 *
 * `find(idempotencyKey)` is deliberately NOT executor-scoped -- the key is
 * globally unique and a terminal attempt's cached result must be readable
 * whoever asks. The consequence is that after a `PRIVATE_KEY` rotation, older
 * non-terminal attempts are still reachable. Re-signing one would emit a payload
 * from the NEW key carrying the OLD wallet's nonce; on a fresh account that
 * nonce is far in the future, so a node accepts it into its mempool and it never
 * mines -- no broadcast error, no revert, nothing to classify.
 *
 * What is deliberately PERMITTED: an attempt already past SIGNED carries a
 * payload the owning executor produced and may still be in flight. Re-broadcast
 * and verification of those exact bytes use no key, so crash recovery for the
 * previous wallet's transaction is preserved.
 */

const EXEC_A = '0x65299018abaaa6bd89aabf689dbef21be99ef1ea';
const EXEC_B = '0x7d22bd54152f8ead57edb0077a6e9f8a7fc76ddb';
const TX: TxRequest = { to: '0x1111111111111111111111111111111111111111', data: '0xabcdef', value: 0n };

type Deps = TxSafetyDeps<{ ok: true }>;

function makeDeps(over: Partial<Deps> = {}): Deps {
  return {
    buildTransaction: vi.fn(async () => TX),
    simulate: vi.fn(async () => ({ ok: true }) as const),
    estimateGas: vi.fn(async () => 100_000n),
    getGasPrice: vi.fn(async () => 1_000_000_000n),
    checkGasAffordable: vi.fn(async () => ({ ok: true }) as const),
    getNonce: vi.fn(async () => 0),
    signTransaction: vi.fn(async () => ({ raw: '0xaa' as `0x${string}`, hash: `0x${'ab'.repeat(32)}` as `0x${string}` })),
    broadcastRaw: vi.fn(async () => undefined),
    waitForReceipt: vi.fn(async () => ({ status: 'success' as const, blockNumber: 1n })),
    getReceiptIfAvailable: vi.fn(async () => null),
    verifyOnChain: vi.fn(async () => ({ ok: true as const, data: { ok: true as const } })),
    ...over,
  };
}

/**
 * Two repositories over ONE shared store, differing only in executor identity --
 * exactly what a `PRIVATE_KEY` rotation produces: same database, new signer.
 */
function rotatingStore() {
  const asA = new InMemoryTransactionAttemptRepository(EXEC_A);
  const asB = new InMemoryTransactionAttemptRepository(EXEC_B);
  // Share the backing map so both see the same rows, and offset B's id counter
  // so the two never mint the same row id (the real repository uses cuid()).
  (asB as unknown as { byKey: unknown }).byKey = (asA as unknown as { byKey: unknown }).byKey;
  (asB as unknown as { nextId: number }).nextId = 1000;
  return { asA, asB };
}

describe('executor rotation: an attempt reserved by A is never re-signed by B', () => {
  it('A reserves a nonce, rotation to B, resume -> refused, nothing signed or broadcast', async () => {
    const { asA, asB } = rotatingStore();

    // --- A gets as far as NONCE_ASSIGNED, then its signing step dies so the
    //     attempt is left holding A's nonce with no payload.
    const depsA = makeDeps({
      getNonce: vi.fn(async () => 1609), // A is a long-lived wallet
      signTransaction: vi.fn(async () => {
        throw Object.assign(new Error('signer unavailable'), { name: 'Transient' });
      }),
    });
    await executeCriticalTransaction('rotate-1', 'p', depsA, asA, { log: vi.fn() });
    const afterA = await asA.find('rotate-1');
    expect(afterA?.nonce).toBe(1609);
    expect(afterA?.executorAddress).toBe(EXEC_A);

    // A local signing throw is definitive, so revive the row to the exact
    // dangerous shape: holding A's nonce, unsigned, non-terminal.
    await asA.update(afterA!.id, { status: 'NONCE_ASSIGNED', failureCode: null, lastError: null }, afterA!.version);

    // --- rotation: same database, B is now the signer, and B's account is at 0
    const depsB = makeDeps({ getNonce: vi.fn(async () => 0) });
    const log = vi.fn();
    const result = await executeCriticalTransaction('rotate-1', 'p', depsB, asB, { log });

    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.reason).toMatch(/refusing to re-sign another wallet's nonce/);
      // Resumable, not FAILED: an ownership fact, not a verdict about the tx.
      expect(result.resumable).toBe(true);
      expect(result.attempt.failureCode).toBeNull();
      // The row is untouched: still A's nonce, still A's label.
      expect(result.attempt.nonce).toBe(1609);
      expect(result.attempt.executorAddress).toBe(EXEC_A);
      expect(result.attempt.rawTx).toBeNull();
    }
    // The whole point: B's key never signed, and nothing went to the chain.
    expect(depsB.signTransaction).not.toHaveBeenCalled();
    expect(depsB.broadcastRaw).not.toHaveBeenCalled();
    expect(log).toHaveBeenCalledWith(
      'critical_tx_step_failed',
      expect.objectContaining({ code: 'EXECUTOR_MISMATCH', owner: EXEC_A, current: EXEC_B }),
    );
  });

  it('stays refused on every later tick -- it never becomes signable by retrying', async () => {
    const { asA, asB } = rotatingStore();
    const created = await asA.create('rotate-loop', 'p');
    const ready = await asA.update(created.id, { status: 'GAS_CHECKED' }, created.version);
    const res = await asA.reserveNonce({ attemptId: ready.id, expectedVersion: ready.version, chainPendingNonce: 1609 });
    expect(res.nonce).toBe(1609);

    for (let i = 0; i < 4; i++) {
      const depsB = makeDeps();
      const r = await executeCriticalTransaction('rotate-loop', 'p', depsB, asB, { log: vi.fn() });
      expect(r.ok).toBe(false);
      expect(depsB.signTransaction).not.toHaveBeenCalled();
      expect(depsB.broadcastRaw).not.toHaveBeenCalled();
    }
  });

  it('B is not blocked from its OWN work -- a fresh attempt allocates from B account', async () => {
    const { asA, asB } = rotatingStore();
    const created = await asA.create('a-holds', 'p');
    const ready = await asA.update(created.id, { status: 'GAS_CHECKED' }, created.version);
    await asA.reserveNonce({ attemptId: ready.id, expectedVersion: ready.version, chainPendingNonce: 1609 });

    const depsB = makeDeps({ getNonce: vi.fn(async () => 0) });
    const result = await executeCriticalTransaction('b-own-work', 'p', depsB, asB, { log: vi.fn() });

    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.attempt.nonce).toBe(0); // A's 1609 is invisible to B
      expect(result.attempt.executorAddress).toBe(EXEC_B);
    }
    expect(depsB.signTransaction).toHaveBeenCalledWith(TX, 0, expect.anything(), expect.anything());
  });

  it('PERMITTED, and pinned: an already-SIGNED attempt of A may still be re-broadcast and verified under B', async () => {
    // Documented invariant: only RE-SIGNING is fenced. A's payload already
    // exists and may be in flight; re-broadcasting those exact bytes uses no
    // key, so crash recovery for A's transaction is preserved rather than
    // abandoning a possibly-live transaction.
    const { asA, asB } = rotatingStore();
    const created = await asA.create('signed-by-a', 'p');
    const ready = await asA.update(created.id, { status: 'GAS_CHECKED', txRequest: TX, gasLimit: 100_000n, gasPrice: 1n }, created.version);
    const res = await asA.reserveNonce({ attemptId: ready.id, expectedVersion: ready.version, chainPendingNonce: 1609 });
    const signed = await asA.update(
      res.attempt.id,
      { status: 'SIGNED', rawTx: '0xaa', txHash: `0x${'cd'.repeat(32)}` },
      res.attempt.version,
    );
    expect(signed.executorAddress).toBe(EXEC_A);

    const depsB = makeDeps();
    const result = await executeCriticalTransaction('signed-by-a', 'p', depsB, asB, { log: vi.fn() });

    expect(result.ok).toBe(true);
    // A's bytes were re-broadcast; B's key was never used to make new ones.
    expect(depsB.broadcastRaw).toHaveBeenCalledWith('0xaa');
    expect(depsB.signTransaction).not.toHaveBeenCalled();
  });

  it('a TERMINAL attempt of A short-circuits for B without signing anything', async () => {
    const { asA, asB } = rotatingStore();
    const created = await asA.create('verified-by-a', 'p');
    await asA.update(created.id, { status: 'VERIFIED', nonce: 1609, rawTx: '0xaa', verifyData: { ok: true } }, created.version);

    const depsB = makeDeps();
    const result = await executeCriticalTransaction('verified-by-a', 'p', depsB, asB, { log: vi.fn() });

    expect(result.ok).toBe(true);
    expect(depsB.signTransaction).not.toHaveBeenCalled();
    expect(depsB.broadcastRaw).not.toHaveBeenCalled();
  });

  it('normal same-executor resume is unchanged: the persisted nonce is reused and re-signed', async () => {
    // The behaviour the fence must not disturb.
    const repo = new InMemoryTransactionAttemptRepository(EXEC_B);
    const created = await repo.create('same-exec', 'p');
    const ready = await repo.update(created.id, { status: 'GAS_CHECKED', txRequest: TX, gasLimit: 100_000n, gasPrice: 1n }, created.version);
    const res = await repo.reserveNonce({ attemptId: ready.id, expectedVersion: ready.version, chainPendingNonce: 4 });
    expect(res.nonce).toBe(4);

    const deps = makeDeps({ getNonce: vi.fn(async () => 99) }); // provider moved; must be ignored
    const result = await executeCriticalTransaction('same-exec', 'p', deps, repo, { log: vi.fn() });

    expect(result.ok).toBe(true);
    expect(deps.getNonce).not.toHaveBeenCalled();
    expect(deps.signTransaction).toHaveBeenCalledWith(TX, 4, 100_000n, 1n);
  });

  it('a legacy (NULL-executor) attempt holding a nonce is fenced from a configured executor', async () => {
    // Exactly the production shape: rows written before executor scoping
    // existed. They belong to a previous wallet, so they must not be re-signed
    // by the current one either.
    const legacy = new InMemoryTransactionAttemptRepository(); // unscoped -> NULL
    const current = new InMemoryTransactionAttemptRepository(EXEC_B);
    (current as unknown as { byKey: unknown }).byKey = (legacy as unknown as { byKey: unknown }).byKey;
    (current as unknown as { nextId: number }).nextId = 1000;

    const created = await legacy.create('legacy-1', 'p');
    // txRequest too, so the attempt is resumable-shaped and the fence -- not the
    // "past BUILT but no txRequest" invariant -- is what stops it.
    await legacy.update(
      created.id,
      { status: 'NONCE_ASSIGNED', nonce: 1609, txRequest: TX, gasLimit: 100_000n, gasPrice: 1n },
      created.version,
    );
    expect((await legacy.find('legacy-1'))?.executorAddress).toBeNull();

    const depsB = makeDeps();
    const result = await executeCriticalTransaction('legacy-1', 'p', depsB, current, { log: vi.fn() });

    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.reason).toMatch(/unknown\/legacy/);
    expect(depsB.signTransaction).not.toHaveBeenCalled();
    expect(depsB.broadcastRaw).not.toHaveBeenCalled();
  });

  it('an unscoped process is NOT fenced from unscoped legacy rows -- the pre-rotation status quo still works', async () => {
    // A deployment that has not configured an executor address behaves exactly
    // as before: NULL owner, NULL current, no mismatch.
    const repo = new InMemoryTransactionAttemptRepository();
    const created = await repo.create('unscoped-1', 'p');
    await repo.update(created.id, { status: 'GAS_CHECKED', txRequest: TX, gasLimit: 100_000n, gasPrice: 1n }, created.version);
    const latest = await repo.find('unscoped-1');
    const res = await repo.reserveNonce({ attemptId: latest!.id, expectedVersion: latest!.version, chainPendingNonce: 3 });
    expect(res.attempt.executorAddress).toBeNull();

    const deps = makeDeps();
    const result = await executeCriticalTransaction('unscoped-1', 'p', deps, repo, { log: vi.fn() });

    expect(result.ok).toBe(true);
    expect(deps.signTransaction).toHaveBeenCalledWith(TX, 3, 100_000n, 1n);
  });
});
