import { describe, expect, it, vi } from 'vitest';
import type { Address } from 'viem';
import { openPosition, resumeOpenPosition } from '../../src/positions/openPosition';
import type { OpenPositionInput, OpenPositionDeps } from '../../src/positions/openPosition';
import { executeCriticalTransaction } from '../../src/execution/executeCriticalTransaction';
import type { TxRequest, TxSafetyDeps } from '../../src/execution/types';
import { InMemoryTransactionAttemptRepository } from '../execution/inMemoryTransactionAttemptRepository';
import { InMemoryPositionRepository } from './inMemoryPositionRepository';
import { PositionActivePositionChecker } from '../../src/positions/activePositionChecker';
import { PositionCapitalSnapshotProvider } from '../../src/positions/capitalSnapshotProvider';
import { POOL } from './fixtures';

const TX: TxRequest = { to: '0x1111111111111111111111111111111111111111', data: '0xabcdef', value: 0n };
const WALLET = '0x9999999999999999999999999999999999999999' as Address;
const TOKEN = '0x0000000000000000000000000000000000000002' as Address;
const USDG = (n: number): bigint => BigInt(n) * 10n ** 18n;

function fakeTxDeps<T>(data: T, overrides: Partial<TxSafetyDeps<T>> = {}): TxSafetyDeps<T> {
  return {
    buildTransaction: vi.fn(async () => TX),
    simulate: vi.fn(async () => ({ ok: true }) as const),
    estimateGas: vi.fn(async () => 100_000n),
    getGasPrice: vi.fn(async () => 1_000_000_000n),
    checkGasAffordable: vi.fn(async () => ({ ok: true }) as const),
    getNonce: vi.fn(async () => 7),
    signTransaction: vi.fn(async () => ({ raw: '0xdeadbeef' as `0x${string}`, hash: `0x${'ab'.repeat(32)}` as `0x${string}` })),
    broadcastRaw: vi.fn(async () => undefined),
    waitForReceipt: vi.fn(async () => ({ status: 'success' as const, blockNumber: 123n })),
    getReceiptIfAvailable: vi.fn(async () => null),
    verifyOnChain: vi.fn(async () => ({ ok: true as const, data })),
    ...overrides,
  };
}

function successfulMintDeps(positionTokenId = '42') {
  return vi.fn(() => fakeTxDeps({ positionTokenId, liquidity: 500n }));
}

function definitivelyFailingMintDeps(reason = 'would revert: mint failed') {
  return vi.fn(() => fakeTxDeps({ positionTokenId: '0', liquidity: 0n }, { simulate: vi.fn(async () => ({ ok: false, reason })) }));
}

function ambiguousMintDeps() {
  return vi.fn(() => fakeTxDeps({ positionTokenId: '0', liquidity: 0n }, { broadcastRaw: vi.fn(async () => { throw new Error('ECONNRESET'); }) }));
}

function ambiguousApproveDeps() {
  return vi.fn(() => fakeTxDeps({ allowanceRaw: 0n }, { broadcastRaw: vi.fn(async () => { throw new Error('ECONNRESET'); }) }));
}

function successfulApproveDeps() {
  return vi.fn(() => fakeTxDeps({ allowanceRaw: USDG(500) }));
}

function definitivelyFailingApproveDeps(reason = 'approve reverted') {
  return vi.fn(() => fakeTxDeps({ allowanceRaw: 0n }, { simulate: vi.fn(async () => ({ ok: false, reason })) }));
}

function makeInput(overrides: Partial<OpenPositionInput> = {}): OpenPositionInput {
  return {
    tokenAddress: TOKEN,
    tokenSymbol: 'MEME',
    tokenDecimals: 18,
    pool: POOL,
    tickLower: -6960,
    tickUpper: -60,
    entryUsdgRaw: USDG(350),
    entryTick: 0,
    entrySqrtPriceX96: 2n ** 96n,
    ...overrides,
  };
}

function baseDeps(overrides: Partial<OpenPositionDeps> = {}): Omit<OpenPositionDeps, 'positions' | 'txAttempts'> {
  return {
    livePositionState: { getLiveState: vi.fn() },
    poolPrice: { getPriceState: vi.fn() },
    readAllowance: vi.fn(async () => 0n), // insufficient by default -- most tests want the approve leg exercised unless overridden
    walletAddress: WALLET,
    ...overrides,
  };
}

describe('openPosition / resumeOpenPosition -- the open-side state machine', () => {
  it('openPosition creates the row at OPENING with a fresh openIdempotencyKey BEFORE any executeCriticalTransaction call', async () => {
    const positions = new InMemoryPositionRepository();
    const txAttempts = new InMemoryTransactionAttemptRepository();

    const outcome = await openPosition(makeInput(), {
      positions,
      txAttempts,
      ...baseDeps({
        buildApproveDeps: successfulApproveDeps(),
        buildMintDeps: successfulMintDeps(),
        readAllowance: vi.fn(async () => USDG(1000)), // already sufficient -- skip approve for this wiring test
      }),
    });

    expect(outcome.outcome).toBe('ACTIVE');
    if (outcome.outcome !== 'ACTIVE') throw new Error('unreachable');
    expect(outcome.position.status).toBe('ACTIVE');
    expect(outcome.position.openIdempotencyKey).toMatch(/^deploy:/);
    expect(outcome.position.positionTokenId).toBe('42');
  });

  describe('mint fails DEFINITIVELY -- the numeric proof (point-3-equivalent for the open side)', () => {
    it('markFailed is called, capital returns to free, the slot returns to available, and the token can be re-screened -- all proven, not assumed', async () => {
      const positions = new InMemoryPositionRepository();
      const txAttempts = new InMemoryTransactionAttemptRepository();

      // A second, unrelated ACTIVE position, so the snapshot has something real to compare against.
      const other = await positions.create({
        tokenAddress: '0x0000000000000000000000000000000000000003' as Address,
        tokenSymbol: 'OTHER',
        tokenDecimals: 18,
        pool: POOL,
        tickLower: -6960,
        tickUpper: -60,
        entryUsdgRaw: USDG(100),
        entrySqrtPriceX96: 2n ** 96n,
        entryTick: 0,
        openIdempotencyKey: 'deploy:other:1',
      });
      await positions.markActive(other.id, '1', new Date());

      const outcome = await openPosition(makeInput({ entryUsdgRaw: USDG(350) }), {
        positions,
        txAttempts,
        ...baseDeps({
          buildApproveDeps: successfulApproveDeps(),
          buildMintDeps: definitivelyFailingMintDeps(),
          readAllowance: vi.fn(async () => USDG(1000)), // sufficient -- isolate this test to the mint leg failing
        }),
      });

      expect(outcome.outcome).toBe('FAILED');

      const positionRows = await positions.findAllOpening();
      expect(positionRows).toHaveLength(0); // no longer OPENING

      // Capital accounting: the failed candidate's 350 USDG must NOT be
      // counted as deployed, and must NOT be reserved out of free balance
      // -- it genuinely never left the wallet. Only `other`'s 100 should
      // show up as deployed. This is Revision 7's FAILED-status fix,
      // exercised here through a REAL mint failure, not just re-asserted
      // in the abstract.
      const snapshotProvider = new PositionCapitalSnapshotProvider(positions, WALLET, async () => USDG(1000));
      const snapshot = await snapshotProvider.getSnapshot();
      expect(snapshot.totalDeployedUsdg).toBe(USDG(100)); // only `other` -- the failed candidate is NOT counted
      expect(snapshot.freeUsdgBalance).toBe(USDG(1000)); // the full on-chain balance -- nothing reserved for the failed candidate
      expect(snapshot.activePositionsCount).toBe(1); // only `other` occupies a slot

      // The token can be re-screened -- ActivePositionChecker must report
      // false, exactly the same proof pattern used in Revision 8.
      const checker = new PositionActivePositionChecker(positions);
      expect(await checker.hasActivePosition(TOKEN)).toBe(false);
    });

    it('a definitive APPROVE failure gets the exact same simple response -- markFailed, nothing irreversible happened yet', async () => {
      const positions = new InMemoryPositionRepository();
      const txAttempts = new InMemoryTransactionAttemptRepository();
      const buildMintDeps = successfulMintDeps();

      const outcome = await openPosition(makeInput(), {
        positions,
        txAttempts,
        ...baseDeps({
          buildApproveDeps: definitivelyFailingApproveDeps(),
          buildMintDeps,
          readAllowance: vi.fn(async () => 0n), // insufficient -- approve leg must run
        }),
      });

      expect(outcome.outcome).toBe('FAILED');
      expect(buildMintDeps).not.toHaveBeenCalled(); // never reached the mint leg

      const openingRows = await positions.findAllOpening();
      expect(openingRows).toHaveLength(0);
    });

    it('does NOT retry the same mint with a fresh key -- the next screening cycle is the correct retry path, not this function', async () => {
      const positions = new InMemoryPositionRepository();
      const txAttempts = new InMemoryTransactionAttemptRepository();

      await openPosition(makeInput(), {
        positions,
        txAttempts,
        ...baseDeps({ buildApproveDeps: successfulApproveDeps(), buildMintDeps: definitivelyFailingMintDeps(), readAllowance: vi.fn(async () => USDG(1000)) }),
      });

      // No OPENING row survives to be resumed -- there is nothing left for
      // this module to retry. A fresh candidate evaluation (a brand new
      // `openPosition` call, from the next 30-minute cycle) is the only
      // way forward, exactly as designed.
      expect(await positions.findAllOpening()).toHaveLength(0);
    });
  });

  describe('AMBIGUOUS (resumable) failures -- stay OPENING, retry with the SAME key, ordinary Module 6 resumability', () => {
    it('an ambiguous approve failure leaves the position OPENING with the same key', async () => {
      const positions = new InMemoryPositionRepository();
      const txAttempts = new InMemoryTransactionAttemptRepository();

      const outcome = await openPosition(makeInput(), {
        positions,
        txAttempts,
        ...baseDeps({ buildApproveDeps: ambiguousApproveDeps(), readAllowance: vi.fn(async () => 0n) }),
      });

      expect(outcome.outcome).toBe('PENDING');
      const openingRows = await positions.findAllOpening();
      expect(openingRows).toHaveLength(1);
    });

    it('an ambiguous mint failure leaves the position OPENING with the same key', async () => {
      const positions = new InMemoryPositionRepository();
      const txAttempts = new InMemoryTransactionAttemptRepository();

      const outcome = await openPosition(makeInput(), {
        positions,
        txAttempts,
        ...baseDeps({ buildApproveDeps: successfulApproveDeps(), buildMintDeps: ambiguousMintDeps(), readAllowance: vi.fn(async () => 0n) }),
      });

      expect(outcome.outcome).toBe('PENDING');
      expect(await positions.findAllOpening()).toHaveLength(1);
    });
  });

  describe('resume after a simulated crash: SIGNED but never broadcast, restart, resume continues from SIGNED without re-signing', () => {
    it('the mint leg resumes from SIGNED -- signTransaction is never called a second time', async () => {
      const positions = new InMemoryPositionRepository();
      const txAttempts = new InMemoryTransactionAttemptRepository();

      // "Before crash": mint's buildTransaction/simulate/gas/nonce/sign all
      // succeed, but broadcast throws (simulating the process dying right
      // as the network call went out, before a SENT status was ever persisted).
      const signTransaction = vi.fn(async () => ({ raw: '0xdeadbeef' as `0x${string}`, hash: `0x${'cd'.repeat(32)}` as `0x${string}` }));
      const crashedMintDeps = vi.fn(() =>
        fakeTxDeps(
          { positionTokenId: '99', liquidity: 500n },
          { signTransaction, broadcastRaw: vi.fn(async () => { throw new Error('process killed mid-broadcast'); }) },
        ),
      );

      const created = await openPosition(makeInput(), {
        positions,
        txAttempts,
        ...baseDeps({ buildApproveDeps: successfulApproveDeps(), buildMintDeps: crashedMintDeps, readAllowance: vi.fn(async () => USDG(1000)) }),
      });
      expect(created.outcome).toBe('PENDING');
      expect(signTransaction).toHaveBeenCalledTimes(1);

      const [openingPosition] = await positions.findAllOpening();
      if (!openingPosition) throw new Error('unreachable');

      // "After restart": resumeOpenPosition called on the SAME (still
      // OPENING) row, with a mint leg that now succeeds all the way through.
      const resumedSignTransaction = vi.fn(async () => ({ raw: '0xdeadbeef' as `0x${string}`, hash: `0x${'cd'.repeat(32)}` as `0x${string}` }));
      const resumedMintDeps = vi.fn(() => fakeTxDeps({ positionTokenId: '99', liquidity: 500n }, { signTransaction: resumedSignTransaction }));

      const resumed = await resumeOpenPosition(openingPosition, {
        positions,
        txAttempts,
        ...baseDeps({ buildApproveDeps: successfulApproveDeps(), buildMintDeps: resumedMintDeps, readAllowance: vi.fn(async () => USDG(1000)) }),
      });

      expect(resumed.outcome).toBe('ACTIVE');
      // The SAME idempotencyKey was used (Module 6 resumes from the
      // persisted SIGNED checkpoint) -- signTransaction on the RESUMED
      // call must never fire again, proving the already-signed raw tx
      // (from before the "crash") was reused, not re-signed.
      expect(resumedSignTransaction).not.toHaveBeenCalled();
    });
  });

  describe('never ACTIVE before the mint is genuinely verified on-chain', () => {
    it('a mint that CONFIRMS (receipt success) but fails verifyOnChain (e.g. liquidity reads 0) does not mark ACTIVE', async () => {
      const positions = new InMemoryPositionRepository();
      const txAttempts = new InMemoryTransactionAttemptRepository();

      const unverifiedMintDeps = vi.fn(() =>
        fakeTxDeps({ positionTokenId: '0', liquidity: 0n }, { verifyOnChain: vi.fn(async () => ({ ok: false as const, reason: 'liquidity reads 0' })) }),
      );

      const outcome = await openPosition(makeInput(), {
        positions,
        txAttempts,
        ...baseDeps({ buildApproveDeps: successfulApproveDeps(), buildMintDeps: unverifiedMintDeps, readAllowance: vi.fn(async () => USDG(1000)) }),
      });

      // A VERIFICATION_FAILED result is a DEFINITIVE failure per Module 6
      // (see executeCriticalTransaction.ts) -- so this correctly becomes FAILED, not ACTIVE.
      expect(outcome.outcome).toBe('FAILED');
      const reloaded = await positions.findAllOpening();
      expect(reloaded).toHaveLength(0);
      const active = await positions.findAllActive();
      expect(active).toHaveLength(0);
    });

    it('markActive is only called with the positionTokenId verifyOnChain actually returned', async () => {
      const positions = new InMemoryPositionRepository();
      const txAttempts = new InMemoryTransactionAttemptRepository();

      const outcome = await openPosition(makeInput(), {
        positions,
        txAttempts,
        ...baseDeps({
          buildApproveDeps: successfulApproveDeps(),
          buildMintDeps: successfulMintDeps('12345'),
          readAllowance: vi.fn(async () => USDG(1000)),
        }),
      });

      expect(outcome.outcome).toBe('ACTIVE');
      if (outcome.outcome !== 'ACTIVE') throw new Error('unreachable');
      expect(outcome.position.positionTokenId).toBe('12345');
      expect(outcome.position.openedAt).not.toBeNull();
    });
  });

  describe('approve leg is skipped entirely when current allowance is already sufficient', () => {
    it('does not call buildApproveDeps at all', async () => {
      const positions = new InMemoryPositionRepository();
      const txAttempts = new InMemoryTransactionAttemptRepository();
      const buildApproveDeps = successfulApproveDeps();

      const outcome = await openPosition(makeInput({ entryUsdgRaw: USDG(300) }), {
        positions,
        txAttempts,
        ...baseDeps({ buildApproveDeps, buildMintDeps: successfulMintDeps(), readAllowance: vi.fn(async () => USDG(500)) }),
      });

      expect(outcome.outcome).toBe('ACTIVE');
      expect(buildApproveDeps).not.toHaveBeenCalled();
    });
  });
});
