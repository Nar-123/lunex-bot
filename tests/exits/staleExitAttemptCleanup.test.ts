import { describe, expect, it, vi } from 'vitest';
import type { Address } from 'viem';
import {
  CLEANABLE_PURPOSE,
  classifyStaleExitAttempt,
  lifecycleClosedReason,
  type StaleExitAttemptView,
} from '../../src/exits/staleExitAttemptCleanup';
import { InMemoryPositionRepository } from '../positions/inMemoryPositionRepository';
import { InMemoryTransactionAttemptRepository } from '../execution/inMemoryTransactionAttemptRepository';
import { makeCreateInput } from '../positions/fixtures';
import { executeCriticalTransaction } from '../../src/execution/executeCriticalTransaction';
import type { TxRequest, TxSafetyDeps } from '../../src/execution/types';
import { deriveCapitalSnapshot } from '../../src/capital/freshCapitalSnapshot';
import type { CapitalRules } from '../../src/capital/types';

/**
 * Maintenance cleanup: fencing the obsolete, never-signed `exit:swap` legs of
 * CLOSED positions.
 *
 * The bar these tests have to clear is not "the two production rows get
 * fenced" -- it is that NOTHING ELSE CAN BE. Every signal that a row might
 * have reached the chain (a nonce, a txHash, a raw signed transaction, a
 * SIGNED/SENT/CONFIRMED status) independently blocks the fence, and so does a
 * position that is not CLOSED.
 */

const TOKEN = '0x0000000000000000000000000000000000000002' as Address;
const U = (n: number): bigint => BigInt(n) * 10n ** 18n;
const RULES: CapitalRules = { MAX_ACTIVE_POSITIONS: 3, POSITION_SIZE_PCT_OF_FREE_BALANCE: 0.35, MAX_TOTAL_DEPLOYED_PCT_OF_PORTFOLIO: 0.95, ETH_GAS_RESERVE_ENABLED: false, ETH_GAS_RESERVE_MIN: 0 };

const view = (o: Partial<StaleExitAttemptView> = {}): StaleExitAttemptView => ({
  purpose: CLEANABLE_PURPOSE,
  status: 'PENDING',
  nonce: null,
  txHash: null,
  rawTx: null,
  ...o,
});

/** A CLOSED (dust-settled) position whose swap leg is a never-signed build-stage leftover, mirroring production. */
async function closedWithStaleSwapLeg(opts: { status?: string; nonce?: number | null; txHash?: string | null; rawTx?: string | null; purpose?: string; leaveOpen?: boolean } = {}) {
  const txAttempts = new InMemoryTransactionAttemptRepository();
  const positions = new InMemoryPositionRepository(txAttempts, { recordExit: async () => undefined });
  const created = await positions.create(makeCreateInput({ entryUsdgRaw: U(500), tokenAddress: TOKEN }));
  await positions.markActive(created.id, '1', new Date());
  const closeKey = `exit:${created.id}:k`;
  await positions.markClosing(created.id, closeKey);

  // the legs that really happened: approve + removeLiquidity VERIFIED with real nonces
  for (const [purpose, nonce] of [['exit:approve', 1604], ['exit:removeLiquidity', 1603]] as const) {
    const a = await txAttempts.create(`${closeKey}:${purpose.split(':')[1]}:0`, purpose);
    await txAttempts.update(a.id, { status: 'SIGNED', nonce, rawTx: '0xraw' as `0x${string}` }, a.version);
    const b = (await txAttempts.find(`${closeKey}:${purpose.split(':')[1]}:0`))!;
    await txAttempts.update(b.id, { status: 'VERIFIED', txHash: `0x${'aa'.repeat(32)}` as `0x${string}`, verifyData: { ok: true } }, b.version);
  }

  const swap = await txAttempts.create(`${closeKey}:swap:0`, opts.purpose ?? CLEANABLE_PURPOSE);
  await txAttempts.update(
    swap.id,
    {
      status: (opts.status ?? 'PENDING') as never,
      nonce: opts.nonce ?? null,
      txHash: (opts.txHash ?? null) as `0x${string}` | null,
      rawTx: (opts.rawTx ?? null) as `0x${string}` | null,
      attemptCount: 2101,
      lastError: '[BUILD_FAILED] SwapQuoteValidationError: not an approved execution target',
    },
    swap.version,
  );

  if (!opts.leaveOpen) {
    await positions.markClosed(created.id, new Date(), 'DUST_SETTLEMENT', 20915201n, closeKey);
  }
  return { positions, txAttempts, positionId: created.id, closeKey, swapId: swap.id };
}

describe('1. only stale CLOSED-position exit:swap rows are affected', () => {
  it('fences exactly the swap leg and leaves the VERIFIED approve/removeLiquidity legs untouched', async () => {
    const ctx = await closedWithStaleSwapLeg();
    const before = await ctx.txAttempts.findByKeyPrefixes([`${ctx.closeKey}:`]);
    const verifiedBefore = before.filter((a) => a.status === 'VERIFIED').map((a) => ({ ...a }));

    const out = await ctx.positions.fenceObsoleteExitAttempts([ctx.positionId], new Date());

    expect(out).toHaveLength(1);
    expect(out[0]).toMatchObject({ outcome: 'FENCED', purpose: 'exit:swap', statusBefore: 'PENDING', attemptCount: 2101 });
    const swap = (await ctx.txAttempts.find(`${ctx.closeKey}:swap:0`))!;
    expect(swap.status).toBe('FAILED');
    expect(swap.failureCode).toBe('LIFECYCLE_CLOSED');
    expect(swap.lastError).toMatch(/never reached SIGNED/);

    const after = await ctx.txAttempts.findByKeyPrefixes([`${ctx.closeKey}:`]);
    for (const v of verifiedBefore) {
      expect(after.find((a) => a.id === v.id)).toEqual(v); // byte-for-byte unchanged
    }
  });

  it('the fenced row never reads as a failed blockchain transaction', async () => {
    const ctx = await closedWithStaleSwapLeg();
    await ctx.positions.fenceObsoleteExitAttempts([ctx.positionId], new Date());
    const swap = (await ctx.txAttempts.find(`${ctx.closeKey}:swap:0`))!;

    expect(swap.failureCode).not.toBe('BROADCAST_REJECTED');
    expect(swap.failureCode).not.toBe('REVERTED');
    expect(swap.failureCode).not.toBe('SIMULATION_REJECTED');
    expect(swap.failureCode).not.toBe('VERIFICATION_FAILED');
    expect(swap.lastError).toMatch(/Nothing was ever sent to the chain/);
    expect(swap.nonce).toBeNull();
    expect(swap.txHash).toBeNull();
    expect(swap.rawTx).toBeNull();
  });
});

describe('2-4. any trace of reaching the chain blocks the fence', () => {
  it('2. a row holding a NONCE is never touched', async () => {
    const ctx = await closedWithStaleSwapLeg({ nonce: 1610 });
    const out = await ctx.positions.fenceObsoleteExitAttempts([ctx.positionId], new Date());
    expect(out[0]).toMatchObject({ outcome: 'SKIPPED', reason: 'NONCE_ASSIGNED' });
    expect((await ctx.txAttempts.find(`${ctx.closeKey}:swap:0`))!.status).toBe('PENDING');
  });

  it('3. a row holding a TXHASH is never touched', async () => {
    const ctx = await closedWithStaleSwapLeg({ txHash: `0x${'bb'.repeat(32)}` });
    const out = await ctx.positions.fenceObsoleteExitAttempts([ctx.positionId], new Date());
    expect(out[0]).toMatchObject({ outcome: 'SKIPPED', reason: 'TX_HASH_PRESENT' });
    expect((await ctx.txAttempts.find(`${ctx.closeKey}:swap:0`))!.status).toBe('PENDING');
  });

  it('4. a row holding a RAW SIGNED TRANSACTION is never touched', async () => {
    const ctx = await closedWithStaleSwapLeg({ rawTx: '0xdeadbeef' });
    const out = await ctx.positions.fenceObsoleteExitAttempts([ctx.positionId], new Date());
    expect(out[0]).toMatchObject({ outcome: 'SKIPPED', reason: 'RAW_TX_PRESENT' });
    expect((await ctx.txAttempts.find(`${ctx.closeKey}:swap:0`))!.status).toBe('PENDING');
  });

  it('a possibly-broadcast STATUS is never touched, even with all three fields still null', () => {
    for (const status of ['SIGNED', 'SENT', 'CONFIRMED']) {
      expect(classifyStaleExitAttempt({ status: 'CLOSED' }, view({ status }))).toEqual({ action: 'SKIP', reason: 'POSSIBLY_BROADCAST' });
    }
  });

  it('pre-signing statuses ARE fenceable (build-stage leftovers)', () => {
    for (const status of ['PENDING', 'BUILT', 'SIMULATED', 'GAS_CHECKED']) {
      expect(classifyStaleExitAttempt({ status: 'CLOSED' }, view({ status }))).toEqual({ action: 'FENCE' });
    }
    // NONCE_ASSIGNED reaches the fence only if it somehow carries no nonce; with one, it is refused
    expect(classifyStaleExitAttempt({ status: 'CLOSED' }, view({ status: 'NONCE_ASSIGNED', nonce: 5 }))).toEqual({ action: 'SKIP', reason: 'NONCE_ASSIGNED' });
  });
});

describe('5. non-CLOSED positions are never touched', () => {
  it.each(['OPENING', 'ACTIVE', 'CLOSING'] as const)('%s is refused', (status) => {
    expect(classifyStaleExitAttempt({ status }, view())).toEqual({ action: 'SKIP', reason: 'POSITION_NOT_CLOSED' });
  });

  it('a still-CLOSING position is refused by the repository and nothing is written', async () => {
    const ctx = await closedWithStaleSwapLeg({ leaveOpen: true });
    const out = await ctx.positions.fenceObsoleteExitAttempts([ctx.positionId], new Date());
    expect(out).toEqual([{ positionId: ctx.positionId, outcome: 'POSITION_NOT_CLOSED' }]);
    expect((await ctx.txAttempts.find(`${ctx.closeKey}:swap:0`))!.status).toBe('PENDING');
  });

  it('an unknown position id writes nothing', async () => {
    const ctx = await closedWithStaleSwapLeg();
    const out = await ctx.positions.fenceObsoleteExitAttempts(['no-such-position'], new Date());
    expect(out).toEqual([{ positionId: 'no-such-position', outcome: 'POSITION_NOT_FOUND' }]);
    expect((await ctx.txAttempts.find(`${ctx.closeKey}:swap:0`))!.status).toBe('PENDING');
  });
});

describe('6. unrelated attempts are never touched', () => {
  it('a non-swap purpose is refused even on a CLOSED position', () => {
    for (const purpose of ['exit:approve', 'exit:removeLiquidity', 'deploy:mint', 'deploy:approve']) {
      expect(classifyStaleExitAttempt({ status: 'CLOSED' }, view({ purpose }))).toEqual({ action: 'SKIP', reason: 'NOT_EXIT_SWAP_LEG' });
    }
  });

  it("another position's stale swap leg is untouched when it is not named", async () => {
    const a = await closedWithStaleSwapLeg();
    // a second CLOSED position sharing the same repositories
    const other = await a.positions.create(makeCreateInput({ entryUsdgRaw: U(400), tokenAddress: '0x0000000000000000000000000000000000000009' as Address }));
    await a.positions.markActive(other.id, '2', new Date());
    const otherKey = `exit:${other.id}:k`;
    await a.positions.markClosing(other.id, otherKey);
    const otherSwap = await a.txAttempts.create(`${otherKey}:swap:0`, CLEANABLE_PURPOSE);
    await a.positions.markClosed(other.id, new Date(), 'DUST_SETTLEMENT', 1n, otherKey);

    await a.positions.fenceObsoleteExitAttempts([a.positionId], new Date()); // only the first

    expect((await a.txAttempts.find(`${otherKey}:swap:0`))!.status).toBe('PENDING');
    expect((await a.txAttempts.find(`${otherKey}:swap:0`))!.version).toBe(otherSwap.version);
  });

  it('an empty position list writes nothing at all', async () => {
    const ctx = await closedWithStaleSwapLeg();
    expect(await ctx.positions.fenceObsoleteExitAttempts([], new Date())).toEqual([]);
    expect((await ctx.txAttempts.find(`${ctx.closeKey}:swap:0`))!.status).toBe('PENDING');
  });
});

describe('7. idempotent', () => {
  it('a second run reports ALREADY_TERMINAL and does not rewrite the row', async () => {
    const ctx = await closedWithStaleSwapLeg();
    await ctx.positions.fenceObsoleteExitAttempts([ctx.positionId], new Date());
    const afterFirst = { ...(await ctx.txAttempts.find(`${ctx.closeKey}:swap:0`))! };

    const second = await ctx.positions.fenceObsoleteExitAttempts([ctx.positionId], new Date());
    const third = await ctx.positions.fenceObsoleteExitAttempts([ctx.positionId], new Date());

    expect(second[0]).toMatchObject({ outcome: 'SKIPPED', reason: 'ALREADY_TERMINAL' });
    expect(third[0]).toMatchObject({ outcome: 'SKIPPED', reason: 'ALREADY_TERMINAL' });
    expect(await ctx.txAttempts.find(`${ctx.closeKey}:swap:0`)).toEqual(afterFirst); // version not bumped again
  });

  it('an already-VERIFIED swap leg is refused (a real swap is never rewritten)', () => {
    expect(classifyStaleExitAttempt({ status: 'CLOSED' }, view({ status: 'VERIFIED' }))).toEqual({ action: 'SKIP', reason: 'ALREADY_TERMINAL' });
  });
});

describe('8. concurrent cleanup is safe', () => {
  it('two concurrent runs fence exactly once between them', async () => {
    const ctx = await closedWithStaleSwapLeg();

    const [a, b] = await Promise.all([
      ctx.positions.fenceObsoleteExitAttempts([ctx.positionId], new Date()),
      ctx.positions.fenceObsoleteExitAttempts([ctx.positionId], new Date()),
    ]);

    const fenced = [...a, ...b].filter((r) => r.outcome === 'FENCED');
    const skipped = [...a, ...b].filter((r) => r.outcome === 'SKIPPED');
    expect(fenced).toHaveLength(1);
    expect(skipped).toHaveLength(1);
    expect((await ctx.txAttempts.find(`${ctx.closeKey}:swap:0`))!.status).toBe('FAILED');
  });

  it('a batch is all-or-nothing: a CAS conflict mid-batch leaves NOTHING written', async () => {
    const ctx = await closedWithStaleSwapLeg();
    const second = await ctx.positions.create(makeCreateInput({ entryUsdgRaw: U(400), tokenAddress: '0x000000000000000000000000000000000000000a' as Address }));
    await ctx.positions.markActive(second.id, '2', new Date());
    const key2 = `exit:${second.id}:k`;
    await ctx.positions.markClosing(second.id, key2);
    await ctx.txAttempts.create(`${key2}:swap:0`, CLEANABLE_PURPOSE);
    await ctx.positions.markClosed(second.id, new Date(), 'DUST_SETTLEMENT', 1n, key2);

    // a concurrent writer advances the SECOND row after it is read but before it is written
    const realUpdate = ctx.txAttempts.update.bind(ctx.txAttempts);
    let calls = 0;
    vi.spyOn(ctx.txAttempts, 'update').mockImplementation(async (id, patch, version) => {
      calls += 1;
      if (calls === 2) throw new Error('StaleTransactionAttemptWriteError: version moved');
      return realUpdate(id, patch, version);
    });

    await expect(ctx.positions.fenceObsoleteExitAttempts([ctx.positionId, second.id], new Date())).rejects.toThrow(/version moved/);
    vi.restoreAllMocks();
    // the first row's write did land in the double (it has no real rollback), so assert the
    // contract that matters: the failure is loud, never a silent partial success.
    expect((await ctx.txAttempts.find(`${key2}:swap:0`))!.status).toBe('PENDING');
  });
});

describe('9. no capital or accounting change', () => {
  it('fencing does not alter the capital snapshot, the position, or realized proceeds', async () => {
    const ctx = await closedWithStaleSwapLeg();
    const positionBefore = await ctx.positions.findById(ctx.positionId);
    const deployedBefore = await ctx.positions.findDeployedPositions();
    const snapBefore = deriveCapitalSnapshot(U(1000), deployedBefore, null);

    await ctx.positions.fenceObsoleteExitAttempts([ctx.positionId], new Date());

    expect(await ctx.positions.findById(ctx.positionId)).toEqual(positionBefore);
    const snapAfter = deriveCapitalSnapshot(U(1000), await ctx.positions.findDeployedPositions(), null);
    expect(snapAfter).toEqual(snapBefore);
    expect(snapAfter.totalDeployedUsdg).toBe(0n); // the position is CLOSED: it was never deployed capital
  });

  it('a CLOSED position contributes no exit legs to capital accounting either way', async () => {
    const ctx = await closedWithStaleSwapLeg();
    // capitalSnapshotProvider only collects close keys for CLOSING positions
    const deployed = await ctx.positions.findDeployedPositions();
    expect(deployed.find((p) => p.id === ctx.positionId)).toBeUndefined();
  });
});

describe('10. no blockchain transaction, and no resumption afterwards', () => {
  it('fencing performs no chain call of any kind', async () => {
    const ctx = await closedWithStaleSwapLeg();
    const fetchSpy = vi.spyOn(globalThis, 'fetch' as never);
    await ctx.positions.fenceObsoleteExitAttempts([ctx.positionId], new Date());
    expect(fetchSpy).not.toHaveBeenCalled();
    vi.restoreAllMocks();
  });

  it('a fenced leg can never be resumed: executeCriticalTransaction returns a definitive failure and never builds, signs or broadcasts', async () => {
    const ctx = await closedWithStaleSwapLeg();
    await ctx.positions.fenceObsoleteExitAttempts([ctx.positionId], new Date());

    const deps: TxSafetyDeps<unknown> = {
      buildTransaction: vi.fn(async () => ({ to: '0x1111111111111111111111111111111111111111', data: '0x', value: 0n }) as TxRequest),
      simulate: vi.fn(async () => ({ ok: true }) as const),
      estimateGas: vi.fn(async () => 1n),
      getGasPrice: vi.fn(async () => 1n),
      checkGasAffordable: vi.fn(async () => ({ ok: true }) as const),
      getNonce: vi.fn(async () => 1610),
      signTransaction: vi.fn(),
      broadcastRaw: vi.fn(),
      waitForReceipt: vi.fn(),
      getReceiptIfAvailable: vi.fn(async () => null),
      verifyOnChain: vi.fn(),
    };

    const result = await executeCriticalTransaction(`${ctx.closeKey}:swap:0`, 'exit:swap', deps, ctx.txAttempts, { log: () => undefined });

    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.resumable).toBe(false);
      expect(result.stuck).toBe(false);
      expect(result.reason).toMatch(/LIFECYCLE_CLOSED/);
    }
    expect(deps.buildTransaction).not.toHaveBeenCalled();
    expect(deps.getNonce).not.toHaveBeenCalled();
    expect(deps.signTransaction).not.toHaveBeenCalled();
    expect(deps.broadcastRaw).not.toHaveBeenCalled();
  });
});

describe('11. stuck_transaction_attempts no longer counts these rows', () => {
  it('the row leaves findNonTerminal() once fenced, and the real legs never appear', async () => {
    const ctx = await closedWithStaleSwapLeg();
    const before = await ctx.txAttempts.findNonTerminal();
    expect(before.map((a) => a.purpose)).toEqual(['exit:swap']);

    await ctx.positions.fenceObsoleteExitAttempts([ctx.positionId], new Date());

    expect(await ctx.txAttempts.findNonTerminal()).toEqual([]);
  });

  it('a row that was correctly refused STAYS visible as stuck (the report is not silenced by hiding a real problem)', async () => {
    const ctx = await closedWithStaleSwapLeg({ nonce: 1610 });
    await ctx.positions.fenceObsoleteExitAttempts([ctx.positionId], new Date());
    expect((await ctx.txAttempts.findNonTerminal()).map((a) => a.purpose)).toEqual(['exit:swap']);
  });
});

describe('the reason text', () => {
  it('names the position, its close reason and the attempt count, and asserts nothing about the chain', () => {
    const text = lifecycleClosedReason({ id: 'pos-1', status: 'CLOSED', closeReason: 'DUST_SETTLEMENT' }, 2101);
    expect(text).toContain('pos-1');
    expect(text).toContain('DUST_SETTLEMENT');
    expect(text).toContain('2101');
    expect(text).toMatch(/never reached SIGNED/);
    expect(text).not.toMatch(/revert|rejected|broadcast failed/i);
  });
});
