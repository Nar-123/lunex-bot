import { describe, expect, it, vi } from 'vitest';
import type { Address, TransactionSerializedLegacy } from 'viem';
import { createWalletClient, custom, defineChain, recoverTransactionAddress } from 'viem';
import { privateKeyToAccount } from 'viem/accounts';
import { executeCriticalTransaction, safeErrorMessage } from '../../src/execution/executeCriticalTransaction';
import { ExecutorLockTimeoutError, getExecutorLockHolder, withExecutorLock } from '../../src/execution/executorMutex';
import { signTxWithAccount } from '../../src/execution/viemTxSteps';
import type { TxRequest, TxSafetyDeps } from '../../src/execution/types';
import { openPosition } from '../../src/positions/openPosition';
import type { OpenPositionDeps } from '../../src/positions/openPosition';
import { openMintAttemptKey } from '../../src/positions/types';
import type { MintVerifyData } from '../../src/positions/mintTx';
import { InMemoryTransactionAttemptRepository } from './inMemoryTransactionAttemptRepository';
import { InMemoryPositionRepository } from '../positions/inMemoryPositionRepository';
import { POOL } from '../positions/fixtures';
import { validPermit2Preflight } from '../positions/permit2Fixtures';

// Stuck-transaction incident (production approve at NONCE_ASSIGNED, txHash
// null, lastError null, retried every 15s): liveness + observability +
// fencing regressions A-L. Uses only deterministic promises (no sleeps for
// correctness; the lock-wait bound is set to a few ms).

const TEST_KEY = '0xac0974bec39a17e36ba4a6b4d238ff944bacb478cbed5efcae784d7bf4f2ff80'; // public Anvil key #0
const TX: TxRequest = { to: '0x1111111111111111111111111111111111111111', data: '0x095ea7b3', value: 0n };
const HASH = `0x${'ab'.repeat(32)}` as `0x${string}`;

function deferred<T = void>() {
  let resolve!: (v: T) => void;
  let reject!: (e: unknown) => void;
  const promise = new Promise<T>((res, rej) => { resolve = res; reject = rej; });
  return { promise, resolve, reject };
}

function deps(overrides: Partial<TxSafetyDeps<{ ok: true }>> = {}): TxSafetyDeps<{ ok: true }> {
  return {
    buildTransaction: vi.fn(async () => TX),
    simulate: vi.fn(async () => ({ ok: true }) as const),
    estimateGas: vi.fn(async () => 58_801n),
    getGasPrice: vi.fn(async () => 63_390_000n),
    checkGasAffordable: vi.fn(async () => ({ ok: true }) as const),
    getNonce: vi.fn(async () => 1600),
    signTransaction: vi.fn(async () => ({ raw: '0xdeadbeef' as `0x${string}`, hash: HASH })),
    broadcastRaw: vi.fn(async () => undefined),
    waitForReceipt: vi.fn(async () => ({ status: 'success' as const, blockNumber: 1n })),
    getReceiptIfAvailable: vi.fn(async () => null),
    verifyOnChain: vi.fn(async () => ({ ok: true as const, data: { ok: true as const } })),
    ...overrides,
  };
}

describe('root-cause fix: signing is LOCAL (no eth_signTransaction, no RPC at all)', () => {
  it('signTxWithAccount signs with the local key, makes zero RPC calls, the hash is keccak(raw), the signer recovers to the executor, and the payload equals viem\'s own local-account signature', async () => {
    const account = privateKeyToAccount(TEST_KEY);
    const signed = await signTxWithAccount(account, 4663, TX, 1600, 58_801n, 63_390_000n);
    expect(await recoverTransactionAddress({ serializedTransaction: signed.raw as TransactionSerializedLegacy })).toBe(account.address);

    const methods: string[] = [];
    const chain = defineChain({ id: 4663, name: 't', nativeCurrency: { name: 'E', symbol: 'E', decimals: 18 }, rpcUrls: { default: { http: ['http://127.0.0.1:1'] } } });
    const client = createWalletClient({ account, chain, transport: custom({ request: async ({ method }: { method: string }) => { methods.push(method); return '0x1237'; } }) });
    const viemRaw = await client.signTransaction({ account, chain, to: TX.to, data: TX.data, value: 0n, nonce: 1600, gas: 58_801n, gasPrice: 63_390_000n });
    expect(signed.raw).toBe(viemRaw); // byte-identical payload to what viem produces for the local account
    expect(methods).not.toContain('eth_signTransaction');
  });
});

describe('root-cause fix: the PRODUCTION signTx wrapper', () => {
  it('signs offline with the configured executor key (the test RPC is unreachable: https://test-rpc.invalid) and recovers to the executor address', async () => {
    const { signTx } = await import('../../src/execution/viemTxSteps');
    const { getExecutorAddress } = await import('../../src/blockchain/walletClient');
    const signed = await signTx(TX, 1600, 58_801n, 63_390_000n);
    expect(await recoverTransactionAddress({ serializedTransaction: signed.raw as TransactionSerializedLegacy })).toBe(getExecutorAddress());
  });
});

describe('A. signTransaction throws (after NONCE_ASSIGNED)', () => {
  it('-> FAILED/SIGN_TRANSACTION_FAILED with the exact error persisted and logged; nothing broadcast; resume never re-signs or takes a new nonce', async () => {
    const repo = new InMemoryTransactionAttemptRepository();
    const log = vi.fn();
    const d = deps({ signTransaction: vi.fn(async () => { throw new Error('the method eth_signTransaction does not exist/is not available'); }) });
    const r = await executeCriticalTransaction('deploy:k:approve', 'deploy:approve', d, repo, { log });
    expect(r).toMatchObject({ ok: false, resumable: false });
    const row = (await repo.find('deploy:k:approve'))!;
    expect(row).toMatchObject({ status: 'FAILED', failureCode: 'SIGN_TRANSACTION_FAILED', txHash: null, rawTx: null, nonce: 1600 });
    expect(row.lastError).toMatch(/^\[SIGN_TRANSACTION_FAILED\] Error: the method eth_signTransaction/);
    expect(d.broadcastRaw).not.toHaveBeenCalled();
    expect(log).toHaveBeenCalledWith('critical_tx_step_failed', expect.objectContaining({ idempotencyKey: 'deploy:k:approve', purpose: 'deploy:approve', status: 'NONCE_ASSIGNED', checkpoint: 'SIGN', code: 'SIGN_TRANSACTION_FAILED', nonce: 1600 }));

    const again = await executeCriticalTransaction('deploy:k:approve', 'deploy:approve', d, repo, { log });
    expect(again).toMatchObject({ ok: false, resumable: false });
    expect(d.getNonce).toHaveBeenCalledTimes(1);
    expect(d.signTransaction).toHaveBeenCalledTimes(1);
    expect((await repo.find('deploy:k:approve'))!.attemptCount).toBe(1); // a definitive failure is not retried -- no unbounded counter growth
  });
});

describe('B. signTransaction succeeds but the SIGNED checkpoint write fails (stale CAS)', () => {
  it('-> resumable, never broadcast (the payload was never persisted), error recorded; the resume re-signs under the SAME nonce and completes', async () => {
    const repo = new InMemoryTransactionAttemptRepository();
    const log = vi.fn();
    let first = true;
    const d = deps({
      signTransaction: vi.fn(async () => {
        if (first) {
          first = false;
          // A concurrent writer bumps the row between the in-lock re-read and the SIGNED CAS.
          const cur = (await repo.find('deploy:b:approve'))!;
          await repo.update(cur.id, { lastError: 'concurrent writer' }, cur.version);
        }
        return { raw: '0xdeadbeef' as `0x${string}`, hash: HASH };
      }),
    });
    const r = await executeCriticalTransaction('deploy:b:approve', 'deploy:approve', d, repo, { log });
    expect(r).toMatchObject({ ok: false, resumable: true });
    const row = (await repo.find('deploy:b:approve'))!;
    expect(row.status).toBe('NONCE_ASSIGNED');
    expect(row.txHash).toBeNull();
    expect(row.lastError).toMatch(/^\[SIGNED_CHECKPOINT_PERSIST_FAILED\]/);
    expect(d.broadcastRaw).not.toHaveBeenCalled();
    expect(log).toHaveBeenCalledWith('critical_tx_step_failed', expect.objectContaining({ checkpoint: 'SIGNED_PERSIST', code: 'SIGNED_CHECKPOINT_PERSIST_FAILED' }));

    expect(await executeCriticalTransaction('deploy:b:approve', 'deploy:approve', d, repo, { log })).toMatchObject({ ok: true });
    expect(d.getNonce).toHaveBeenCalledTimes(1); // never a second nonce for the same attempt
    expect(d.signTransaction).toHaveBeenNthCalledWith(2, TX, 1600, 58_801n, 63_390_000n);
    expect(d.broadcastRaw).toHaveBeenCalledTimes(1);
  });
});

describe('C/D/K/L. executor liveness without unsafe concurrency', () => {
  it.each([
    ['C. signing hangs', 'signTransaction'],
    ['D. broadcast hangs', 'broadcastRaw'],
  ] as const)('%s -> other transactions stop waiting after the bound (EXECUTOR_BUSY, never touch the wallet) while the holder keeps the lock; once it finishes, later transactions proceed', async (_n, step) => {
    const repo = new InMemoryTransactionAttemptRepository();
    const hang = deferred();
    const holderDeps = deps(step === 'signTransaction'
      ? { signTransaction: vi.fn(async () => { await hang.promise; return { raw: '0xdeadbeef' as `0x${string}`, hash: HASH }; }) }
      : { broadcastRaw: vi.fn(async () => { await hang.promise; }) });
    const holder = executeCriticalTransaction('holder:tx', 'exit:swap', holderDeps, repo, { log: vi.fn() });
    await vi.waitFor(() => expect(holderDeps[step]).toHaveBeenCalled());
    expect(getExecutorLockHolder()?.label).toBe('holder:tx');

    const log = vi.fn();
    const waiterDeps = deps();
    const waiter = await executeCriticalTransaction('waiter:tx', 'deploy:approve', waiterDeps, repo, { log, lockWaitMs: 5 });
    expect(waiter).toMatchObject({ ok: false, resumable: true });
    expect(waiter.ok === false && waiter.reason).toMatch(/\[EXECUTOR_BUSY\]/);
    expect(waiterDeps.getNonce).not.toHaveBeenCalled(); // it never entered the critical section
    expect(waiterDeps.signTransaction).not.toHaveBeenCalled();
    expect((await repo.find('waiter:tx'))!.lastError).toMatch(/^\[EXECUTOR_BUSY\] ExecutorLockTimeoutError: .*held by "holder:tx"/);
    expect(log).toHaveBeenCalledWith('critical_tx_step_failed', expect.objectContaining({ code: 'EXECUTOR_BUSY', lockHolder: 'holder:tx' }));
    expect(getExecutorLockHolder()?.label).toBe('holder:tx'); // the lock was NOT released early

    hang.resolve();
    expect(await holder).toMatchObject({ ok: true });
    expect(getExecutorLockHolder()).toBeNull();
    // L. the waiter's next tick proceeds normally now that the executor is free.
    expect(await executeCriticalTransaction('waiter:tx', 'deploy:approve', waiterDeps, repo, { log })).toMatchObject({ ok: true });
    expect(waiterDeps.getNonce).toHaveBeenCalledTimes(1);
  });

  it('K. the lock is never held by two critical sections at once -- across throwing holders, abandoned waiters and normal completions', async () => {
    let inside = 0;
    let maxInside = 0;
    const tasks = Array.from({ length: 40 }, (_, i) => withExecutorLock(async () => {
      inside++; maxInside = Math.max(maxInside, inside);
      await new Promise((r) => setTimeout(r, 1)); // real contention: queued waiters' wait bounds elapse
      inside--;
      if (i % 3 === 0) throw new Error(`holder ${i} failed`);
      return i;
    }, { label: `t${i}`, maxWaitMs: i % 5 === 0 ? 2 : undefined }));
    const results = await Promise.allSettled(tasks);
    expect(maxInside).toBe(1);
    expect(results.filter((r) => r.status === 'rejected' && r.reason instanceof ExecutorLockTimeoutError).length).toBeGreaterThan(0);
    expect(await withExecutorLock(async () => 'still usable')).toBe('still usable');
  });

  it('an abandoned waiter\'s critical section is SKIPPED even when its turn comes later; a started critical section is never abandoned by its timer', async () => {
    const gate = deferred();
    const holder = withExecutorLock(async () => { await gate.promise; return 'h'; }, { label: 'h' });
    const skipped = vi.fn(async () => 'should never run');
    await expect(withExecutorLock(skipped, { label: 'w', maxWaitMs: 1 })).rejects.toBeInstanceOf(ExecutorLockTimeoutError);
    gate.resolve();
    expect(await holder).toBe('h');
    await withExecutorLock(async () => undefined); // drain
    expect(skipped).not.toHaveBeenCalled();

    const slow = deferred();
    const started = withExecutorLock(async () => { await slow.promise; return 'real outcome'; }, { label: 's', maxWaitMs: 1 });
    await new Promise((r) => setTimeout(r, 10)); // the wait bound elapses WHILE the section runs
    slow.resolve();
    expect(await started).toBe('real outcome');
  });
});

describe('E. ambiguous broadcast', () => {
  it('-> stays SIGNED and resumable (never FAILED), code BROADCAST_AMBIGUOUS persisted and logged -- with the RPC URL key and signed payload redacted', async () => {
    const repo = new InMemoryTransactionAttemptRepository();
    const log = vi.fn();
    const leaky = `HTTP request failed. URL: https://robinhood-mainnet.g.alchemy.com/v2/SECRETKEY123 Request body: {"method":"eth_sendRawTransaction","params":["0x${'f8'.repeat(120)}"]} Details: socket hang up`;
    const d = deps({ broadcastRaw: vi.fn(async () => { throw new Error(leaky); }) });
    const r = await executeCriticalTransaction('exit:e:swap', 'exit:swap', d, repo, { log });
    expect(r).toMatchObject({ ok: false, resumable: true });
    const row = (await repo.find('exit:e:swap'))!;
    expect(row.status).toBe('SIGNED');
    expect(row.failureCode).toBeNull();
    expect(row.lastError).toMatch(/^\[BROADCAST_AMBIGUOUS\] broadcast uncertain:/);
    const logged = JSON.stringify(log.mock.calls);
    for (const text of [row.lastError!, logged]) {
      expect(text).not.toContain('SECRETKEY123');
      expect(text).not.toContain('f8f8f8f8f8f8');
    }
    expect(log).toHaveBeenCalledWith('critical_tx_step_failed', expect.objectContaining({ code: 'BROADCAST_AMBIGUOUS', txHash: HASH }));
  });

  it('safeErrorMessage bounds length and keeps a 32-byte tx hash readable', () => {
    const msg = safeErrorMessage(new Error(`boom ${HASH} ${'x'.repeat(2000)}`));
    expect(msg.length).toBeLessThanOrEqual(800); // raised from 500 so the provider Details line survives
    expect(msg).toContain(HASH);
  });

  it('receipt wait failure -> resumable, RECEIPT_WAIT_FAILED recorded (status stays SENT)', async () => {
    const repo = new InMemoryTransactionAttemptRepository();
    const d = deps({ waitForReceipt: vi.fn(async () => { throw new Error('Timed out while waiting for transaction'); }) });
    expect(await executeCriticalTransaction('exit:w:swap', 'exit:swap', d, repo, { log: vi.fn() })).toMatchObject({ ok: false, resumable: true });
    const row = (await repo.find('exit:w:swap'))!;
    expect(row.status).toBe('SENT');
    expect(row.lastError).toMatch(/^\[RECEIPT_WAIT_FAILED\]/);
  });
});

describe('F. concurrent resume of the same idempotency key', () => {
  it('two concurrent calls -> exactly one nonce, one signature, one broadcast; the attempt ends VERIFIED', async () => {
    const repo = new InMemoryTransactionAttemptRepository();
    const d = deps();
    await Promise.allSettled([
      executeCriticalTransaction('deploy:f:mint', 'deploy:mint', d, repo, { log: vi.fn() }),
      executeCriticalTransaction('deploy:f:mint', 'deploy:mint', d, repo, { log: vi.fn() }),
    ]);
    await executeCriticalTransaction('deploy:f:mint', 'deploy:mint', d, repo, { log: vi.fn() });
    expect(d.getNonce).toHaveBeenCalledTimes(1);
    expect(d.signTransaction).toHaveBeenCalledTimes(1);
    expect(d.broadcastRaw).toHaveBeenCalledTimes(1);
    expect((await repo.find('deploy:f:mint'))!.status).toBe('VERIFIED');
  });
});

// --- H3 + approve ---------------------------------------------------------

const WALLET = '0x9999999999999999999999999999999999999999' as Address;
const TOKEN = '0x0000000000000000000000000000000000000002' as Address;
const U = (n: number): bigint => BigInt(n) * 10n ** 18n;
const MINTED: MintVerifyData = { positionTokenId: '77', liquidity: 1000n };
const OLD = new Date('2026-09-18T00:00:00Z');
const LATER = new Date('2026-09-19T00:00:00Z');

async function openingWithApprove(approveStatus: 'NONCE_ASSIGNED' | 'SIGNED' | 'SENT' | null) {
  const txAttempts = new InMemoryTransactionAttemptRepository();
  const positions = new InMemoryPositionRepository(txAttempts);
  const p = await positions.create({ tokenAddress: TOKEN, tokenSymbol: 'MEME', tokenDecimals: 18, pool: POOL, tickLower: -6960, tickUpper: -60, entryUsdgRaw: U(20), entrySqrtPriceX96: 2n ** 96n, openIdempotencyKey: `deploy:${TOKEN}:k1` } as never);
  positions.setCreatedAtForTest(p.id, OLD);
  const approveKey = `${p.openIdempotencyKey}:approve`;
  if (approveStatus) {
    const a = await txAttempts.create(approveKey, 'deploy:approve');
    await txAttempts.update(a.id, { status: approveStatus, nonce: 1600, ...(approveStatus !== 'NONCE_ASSIGNED' && { rawTx: '0xdeadbeef', txHash: HASH }) }, a.version);
  }
  return { txAttempts, positions, p, approveKey };
}

describe('G/H/I. H3 expiry and the approve leg', () => {
  it('G. approve at NONCE_ASSIGNED -> fenced FAILED/OPENING_TIMEOUT atomically with the position and the mint key; resuming it can never sign', async () => {
    const { txAttempts, positions, p, approveKey } = await openingWithApprove('NONCE_ASSIGNED');
    expect(await positions.expireStaleOpening(p.id, 1000, LATER)).toEqual({ outcome: 'EXPIRED', mintStatusBefore: null });
    expect((await positions.findById(p.id))?.status).toBe('FAILED');
    expect(await txAttempts.find(approveKey)).toMatchObject({ status: 'FAILED', failureCode: 'OPENING_TIMEOUT', txHash: null });
    expect(await txAttempts.find(openMintAttemptKey(p.openIdempotencyKey))).toMatchObject({ status: 'FAILED', failureCode: 'OPENING_TIMEOUT' });
    const d = deps();
    expect(await executeCriticalTransaction(approveKey, 'deploy:approve', d, txAttempts, { log: vi.fn() })).toMatchObject({ ok: false, resumable: false });
    expect(d.signTransaction).not.toHaveBeenCalled();
    expect(d.broadcastRaw).not.toHaveBeenCalled();
  });

  it('G. race: an approve worker queued on the executor lock when expiry fences it stops inside the lock -- no signature, no allowance', async () => {
    const { txAttempts, positions, p, approveKey } = await openingWithApprove(null);
    const hold = deferred();
    const holder = withExecutorLock(async () => { await hold.promise; });
    const d = deps();
    const worker = executeCriticalTransaction(approveKey, 'deploy:approve', d, txAttempts, { log: vi.fn() });
    await vi.waitFor(async () => expect((await txAttempts.find(approveKey))?.status).toBe('GAS_CHECKED'));
    expect((await positions.expireStaleOpening(p.id, 1000, LATER)).outcome).toBe('EXPIRED');
    hold.resolve();
    await holder;
    expect(await worker).toMatchObject({ ok: false, resumable: false });
    expect(d.getNonce).not.toHaveBeenCalled();
    expect(d.signTransaction).not.toHaveBeenCalled();
    expect((await txAttempts.find(approveKey))!.status).toBe('FAILED');
  });

  it.each(['SIGNED', 'SENT'] as const)('H. approve %s (possibly broadcast) -> expiry BLOCKED; the approve is NOT failed and the position keeps its reservation until the approve resolves', async (status) => {
    const { txAttempts, positions, p, approveKey } = await openingWithApprove(status);
    expect(await positions.expireStaleOpening(p.id, 1000, LATER)).toEqual({ outcome: 'BLOCKED_UNRESOLVED_TX', mintStatus: 'NONE', approveStatus: status });
    expect((await positions.findById(p.id))?.status).toBe('OPENING');
    expect((await txAttempts.find(approveKey))!.status).toBe(status);
    expect(await txAttempts.find(openMintAttemptKey(p.openIdempotencyKey))).toBeNull();
  });

  it('I. no approve and no mint attempt -> EXPIRED, mint key fenced', async () => {
    const { txAttempts, positions, p } = await openingWithApprove(null);
    expect(await positions.expireStaleOpening(p.id, 1000, LATER)).toEqual({ outcome: 'EXPIRED', mintStatusBefore: null });
    expect(await txAttempts.find(openMintAttemptKey(p.openIdempotencyKey))).toMatchObject({ status: 'FAILED', failureCode: 'OPENING_TIMEOUT' });
  });
});

describe('J. a position that is no longer OPENING never proceeds to mint', () => {
  it('the position is failed while its approve leg runs (without a mint fence) -> no mint attempt is created, nothing is signed for it', async () => {
    const txAttempts = new InMemoryTransactionAttemptRepository();
    const positions = new InMemoryPositionRepository(txAttempts);
    const mintSign = vi.fn(async () => ({ raw: '0xdeadbeef' as `0x${string}`, hash: HASH }));
    const buildMintDeps = vi.fn(() => ({ ...deps(), signTransaction: mintSign, verifyOnChain: vi.fn(async () => ({ ok: true as const, data: MINTED })) }));
    const approveDeps = () => ({
      ...deps(),
      verifyOnChain: vi.fn(async () => {
        const [row] = await positions.findAllOpening();
        await positions.markFailed(row!.id); // another writer fails the lifecycle mid-approve
        return { ok: true as const, data: { allowanceRaw: U(20) } };
      }),
    });
    const d: OpenPositionDeps = {
      positions,
      txAttempts,
      livePositionState: { getLiveState: vi.fn() },
      poolPrice: { getPriceState: vi.fn() },
      buildMintDeps: buildMintDeps as unknown as OpenPositionDeps['buildMintDeps'],
      buildApproveDeps: approveDeps as unknown as OpenPositionDeps['buildApproveDeps'],
      readAllowance: vi.fn(async () => 0n),
      permit2Preflight: validPermit2Preflight(),
      walletAddress: WALLET,
    };
    const outcome = await openPosition({
      tokenAddress: TOKEN, tokenSymbol: 'MEME', tokenDecimals: 18, pool: POOL, tickLower: -6960, tickUpper: -60,
      entryUsdgRaw: U(20), entryTick: 0, entrySqrtPriceX96: 2n ** 96n,
      readOnChainUsdgBalance: async () => U(1000),
      capitalRules: { MAX_ACTIVE_POSITIONS: 3, POSITION_SIZE_PCT_OF_FREE_BALANCE: 0.35, MAX_TOTAL_DEPLOYED_PCT_OF_PORTFOLIO: 0.95, ETH_GAS_RESERVE_ENABLED: false, ETH_GAS_RESERVE_MIN: 0 },
    }, d);
    expect(outcome.outcome).toBe('FAILED');
    expect(buildMintDeps).not.toHaveBeenCalled();
    expect(mintSign).not.toHaveBeenCalled();
    const all = await positions.findDeployedPositions();
    expect(all).toEqual([]); // FAILED: nothing reserved or deployed
    expect(txAttempts.size()).toBe(1); // only the approve attempt -- no mint attempt was ever created
  });
});
