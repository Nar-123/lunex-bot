import { describe, expect, it, vi } from 'vitest';
import type { Address } from 'viem';
import { enforceOpeningTimeout } from '../../src/positions/openingTimeout';
import { openPosition, resumeOpenPosition } from '../../src/positions/openPosition';
import type { OpenPositionDeps, OpenPositionInput } from '../../src/positions/openPosition';
import { executeCriticalTransaction } from '../../src/execution/executeCriticalTransaction';
import type { TxRequest, TxSafetyDeps } from '../../src/execution/types';
import { StaleTransactionAttemptWriteError } from '../../src/execution/types';
import type { MintVerifyData } from '../../src/positions/mintTx';
import { openMintAttemptKey } from '../../src/positions/types';
import { PositionCapitalSnapshotProvider } from '../../src/positions/capitalSnapshotProvider';
import type { CapitalRules } from '../../src/capital/types';
import { config } from '../../src/config';
import { InMemoryPositionRepository } from './inMemoryPositionRepository';
import { InMemoryTransactionAttemptRepository } from '../execution/inMemoryTransactionAttemptRepository';
import { POOL } from './fixtures';
import { validPermit2Preflight } from './permit2Fixtures';

// H3: bounded OPENING lifetime. These drive the REAL openPosition /
// resumeOpenPosition / executeCriticalTransaction flows against in-memory
// repositories (the real-SQLite cases -- restart with a new client, two
// connections racing, CapitalLock reuse -- live in
// positionRepository.integration.test.ts).

const WALLET = '0x9999999999999999999999999999999999999999' as Address;
const TOKEN = '0x0000000000000000000000000000000000000002' as Address;
const USDG = (n: number): bigint => BigInt(n) * 10n ** 18n;
const TTL = config.rules.execution.OPENING_MAX_AGE_MS;
const RULES: CapitalRules = { MAX_ACTIVE_POSITIONS: 3, POSITION_SIZE_PCT_OF_FREE_BALANCE: 0.35, MAX_TOTAL_DEPLOYED_PCT_OF_PORTFOLIO: 0.95, ETH_GAS_RESERVE_ENABLED: false, ETH_GAS_RESERVE_MIN: 0 };
const TX: TxRequest = { to: '0x1111111111111111111111111111111111111111', data: '0xabcdef', value: 0n };

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
    waitForReceipt: vi.fn(async () => ({ status: 'success' as const, blockNumber: 1n })),
    getReceiptIfAvailable: vi.fn(async () => null),
    verifyOnChain: vi.fn(async () => ({ ok: true as const, data })),
    ...overrides,
  };
}

const MINTED: MintVerifyData = { positionTokenId: '77', liquidity: 1000n };

/** The P0-4 guard's real behavior: `buildMintV4Position` throws when the fresh tick no longer fits the one-sided range. */
function stalePriceMintDeps() {
  return vi.fn(() => fakeTxDeps(MINTED, { buildTransaction: vi.fn(async () => { throw new Error('entry range is stale: price moved into/past the one-sided range since screening'); }) }));
}

function input(overrides: Partial<OpenPositionInput> = {}): OpenPositionInput {
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
    readOnChainUsdgBalance: async () => USDG(1000),
    capitalRules: RULES,
    ...overrides,
  };
}

function setup() {
  const txAttempts = new InMemoryTransactionAttemptRepository();
  const positions = new InMemoryPositionRepository(txAttempts);
  const logger = { info: vi.fn(), warn: vi.fn() };
  const deps = (buildMintDeps: OpenPositionDeps['buildMintDeps']): OpenPositionDeps => ({
    positions,
    txAttempts,
    livePositionState: { getLiveState: vi.fn() },
    poolPrice: { getPriceState: vi.fn() },
    buildMintDeps,
    readAllowance: vi.fn(async () => 10n ** 40n), // allowance already sufficient -- no approve leg
    permit2Preflight: validPermit2Preflight(),
    walletAddress: WALLET,
  });
  return { txAttempts, positions, logger, deps };
}

/** Opens a position whose mint can never be built (stale price), created at `createdAt`. */
async function stuckOpening(ctx: ReturnType<typeof setup>, createdAt: Date) {
  const outcome = await openPosition(input(), ctx.deps(stalePriceMintDeps()));
  expect(outcome.outcome).toBe('PENDING');
  const [row] = await ctx.positions.findAllOpening();
  ctx.positions.setCreatedAtForTest(row!.id, createdAt);
  return row!;
}

const T0 = new Date('2026-09-18T00:00:00Z');
const at = (ms: number) => () => new Date(T0.getTime() + ms);

describe('H3: OPENING has a bounded lifetime -- released only when its entry provably can never succeed', () => {
  it('a stale-price OPENING stays OPENING (and keeps retrying exactly as before) while younger than the TTL', async () => {
    const ctx = setup();
    const row = await stuckOpening(ctx, T0);
    const result = await enforceOpeningTimeout(row, { positions: ctx.positions, logger: ctx.logger, now: at(TTL - 1) });
    expect(result).toEqual({ skipResume: false, result: { outcome: 'TOO_YOUNG', ageMs: TTL - 1 } });
    expect((await resumeOpenPosition(row, ctx.deps(stalePriceMintDeps()))).outcome).toBe('PENDING'); // P0-4 behavior unchanged
    expect((await ctx.positions.findById(row.id))?.status).toBe('OPENING');
    expect(ctx.logger.warn).not.toHaveBeenCalled();
  });

  it('exact boundary is deterministic: TTL - 1 ms -> never expired; exactly TTL -> expired', async () => {
    const ctx = setup();
    const row = await stuckOpening(ctx, T0);
    expect((await enforceOpeningTimeout(row, { positions: ctx.positions, logger: ctx.logger, now: at(TTL - 1) })).result.outcome).toBe('TOO_YOUNG');
    expect((await ctx.positions.findById(row.id))?.status).toBe('OPENING');
    expect((await enforceOpeningTimeout(row, { positions: ctx.positions, logger: ctx.logger, now: at(TTL) })).result.outcome).toBe('EXPIRED');
  });

  it('at the TTL with no broadcast mint: FAILED; the mint key is fenced FAILED (OPENING_TIMEOUT); structured logs emitted', async () => {
    const ctx = setup();
    const row = await stuckOpening(ctx, T0);
    const mintBefore = await ctx.txAttempts.find(openMintAttemptKey(row.openIdempotencyKey));
    expect(mintBefore?.status).toBe('PENDING'); // build kept throwing -- never BUILT, never SIGNED

    const result = await enforceOpeningTimeout(row, { positions: ctx.positions, logger: ctx.logger, now: at(TTL) });
    expect(result).toEqual({ skipResume: true, result: { outcome: 'EXPIRED', mintStatusBefore: 'PENDING' } });
    expect((await ctx.positions.findById(row.id))?.status).toBe('FAILED');
    const mint = await ctx.txAttempts.find(openMintAttemptKey(row.openIdempotencyKey));
    expect(mint).toMatchObject({ status: 'FAILED', failureCode: 'OPENING_TIMEOUT' });
    expect(ctx.logger.info).toHaveBeenCalledWith('opening_timeout_eligible', expect.objectContaining({ positionId: row.id }));
    expect(ctx.logger.warn).toHaveBeenCalledWith('opening_timeout_failed', expect.objectContaining({ positionId: row.id, releasedEntryUsdgRaw: USDG(350).toString(), mintStatusBefore: 'PENDING' }));
  });

  it('releases the reserved capital AND the position slot (H2 accounting untouched: free + deployed = wallet)', async () => {
    const ctx = setup();
    const row = await stuckOpening(ctx, T0);
    const provider = new PositionCapitalSnapshotProvider(ctx.positions, WALLET, async () => USDG(1000), ctx.txAttempts);
    expect(await provider.getSnapshot()).toEqual({ freeUsdgBalance: USDG(650), totalDeployedUsdg: USDG(350), activePositionsCount: 1 });

    await enforceOpeningTimeout(row, { positions: ctx.positions, logger: ctx.logger, now: at(TTL) });

    const after = await provider.getSnapshot();
    expect(after).toEqual({ freeUsdgBalance: USDG(1000), totalDeployedUsdg: 0n, activePositionsCount: 0 });
    expect(after.freeUsdgBalance + after.totalDeployedUsdg).toBe(USDG(1000));
  });

  it('no longer blocks the token: the one-token-one-position check clears and the same token can be opened again (no new cooldown invented -- failed opens never recorded one)', async () => {
    const ctx = setup();
    const row = await stuckOpening(ctx, T0);
    await expect(openPosition(input({ entryUsdgRaw: USDG(100) }), ctx.deps(stalePriceMintDeps()))).resolves.toMatchObject({ outcome: 'FAILED' }); // blocked while OPENING
    await enforceOpeningTimeout(row, { positions: ctx.positions, logger: ctx.logger, now: at(TTL) });
    expect(await ctx.positions.findActiveByToken(TOKEN)).toBeNull();
    const again = await openPosition(input(), ctx.deps(vi.fn(() => fakeTxDeps(MINTED))));
    expect(again.outcome).toBe('ACTIVE');
  });

  it.each(['SIGNED', 'SENT', 'CONFIRMED'] as const)('mint %s (possibly broadcast / confirmed but not verified) -> NEVER released however old: BLOCKED, capital and slot kept, resume continues', async (status) => {
    const ctx = setup();
    const row = await stuckOpening(ctx, T0);
    const mint = (await ctx.txAttempts.find(openMintAttemptKey(row.openIdempotencyKey)))!;
    await ctx.txAttempts.update(mint.id, { status, txHash: `0x${'cd'.repeat(32)}`, rawTx: '0xdeadbeef' });

    const result = await enforceOpeningTimeout(row, { positions: ctx.positions, logger: ctx.logger, now: at(TTL * 100) });
    expect(result).toEqual({ skipResume: false, result: { outcome: 'BLOCKED_UNRESOLVED_TX', mintStatus: status } });
    expect((await ctx.positions.findById(row.id))?.status).toBe('OPENING');
    expect((await ctx.txAttempts.find(openMintAttemptKey(row.openIdempotencyKey)))?.status).toBe(status); // untouched
    const snapshot = await new PositionCapitalSnapshotProvider(ctx.positions, WALLET, async () => USDG(1000), ctx.txAttempts).getSnapshot();
    expect(snapshot.totalDeployedUsdg).toBe(USDG(350));
    expect(ctx.logger.warn).toHaveBeenCalledWith('opening_timeout_blocked_unresolved_tx', expect.objectContaining({ positionId: row.id, mintStatus: status }));
  });

  it('confirmed + VERIFIED mint but the ACTIVE transition was never persisted -> MINT_VERIFIED: never expired, the resume RECOVERS it to ACTIVE', async () => {
    const ctx = setup();
    const row = await stuckOpening(ctx, T0);
    const mint = (await ctx.txAttempts.find(openMintAttemptKey(row.openIdempotencyKey)))!;
    await ctx.txAttempts.update(mint.id, { status: 'VERIFIED', txHash: `0x${'ef'.repeat(32)}`, verifyData: MINTED });

    const result = await enforceOpeningTimeout(row, { positions: ctx.positions, logger: ctx.logger, now: at(TTL * 10) });
    expect(result).toEqual({ skipResume: false, result: { outcome: 'MINT_VERIFIED' } });
    expect((await ctx.positions.findById(row.id))?.status).toBe('OPENING');
    const resumed = await resumeOpenPosition(row, ctx.deps(stalePriceMintDeps()));
    expect(resumed.outcome).toBe('ACTIVE');
    expect((await ctx.positions.findById(row.id))?.positionTokenId).toBe('77');
  });

  it('FENCE: a worker mid-flight (mint at NONCE_ASSIGNED, about to sign) when the timeout fires can NEVER broadcast -- its SIGNED checkpoint write fails the version check', async () => {
    const ctx = setup();
    const row = await stuckOpening(ctx, T0);
    const mintKey = openMintAttemptKey(row.openIdempotencyKey);
    const broadcastRaw = vi.fn(async () => undefined);
    // The worker's own pipeline: while it is fetching the nonce, the timeout fires.
    const workerDeps = fakeTxDeps(MINTED, {
      getNonce: vi.fn(async () => {
        await enforceOpeningTimeout(row, { positions: ctx.positions, logger: ctx.logger, now: at(TTL) });
        return 7;
      }),
      broadcastRaw,
    });
    const workerResult = await executeCriticalTransaction(mintKey, 'deploy:mint', workerDeps, ctx.txAttempts);

    expect(workerResult.ok).toBe(false);
    if (!workerResult.ok) expect(workerResult.resumable).toBe(true);
    expect(broadcastRaw).not.toHaveBeenCalled(); // never on the wire
    expect((await ctx.txAttempts.find(mintKey))).toMatchObject({ status: 'FAILED', failureCode: 'OPENING_TIMEOUT' });
    expect((await ctx.positions.findById(row.id))?.status).toBe('FAILED');
    // ...and every later attempt at this key is the cached definitive failure.
    const later = await executeCriticalTransaction(mintKey, 'deploy:mint', fakeTxDeps(MINTED, { broadcastRaw }), ctx.txAttempts);
    expect(later.ok).toBe(false);
    expect(broadcastRaw).not.toHaveBeenCalled();
  });

  it('FENCE: a stale in-memory attempt snapshot cannot write SIGNED over the fenced row', async () => {
    const ctx = setup();
    const row = await stuckOpening(ctx, T0);
    const snapshot = (await ctx.txAttempts.find(openMintAttemptKey(row.openIdempotencyKey)))!;
    await enforceOpeningTimeout(row, { positions: ctx.positions, logger: ctx.logger, now: at(TTL) });
    await expect(ctx.txAttempts.update(snapshot.id, { status: 'SIGNED', rawTx: '0xdeadbeef', txHash: `0x${'ab'.repeat(32)}` }, snapshot.version)).rejects.toBeInstanceOf(StaleTransactionAttemptWriteError);
  });

  it('FENCE: no mint attempt yet (the worker is still on the approve leg) -> the mint key is created FAILED, so the resumed open can only fail, never mint', async () => {
    const ctx = setup();
    const txAttempts = ctx.txAttempts;
    // Force the approve leg to stay pending BEFORE signing (a transient gas-estimate
    // failure) so no mint attempt is ever created. (An approve that is SIGNED --
    // possibly broadcast -- now BLOCKS the expiry instead: see
    // tests/execution/criticalTxLiveness.test.ts, case H.)
    const approveDeps = vi.fn(() => fakeTxDeps({ allowanceRaw: 0n }, { estimateGas: vi.fn(async () => { throw new Error('ECONNRESET'); }) }));
    const deps = { ...ctx.deps(vi.fn(() => fakeTxDeps(MINTED))), readAllowance: vi.fn(async () => 0n), buildApproveDeps: approveDeps };
    expect((await openPosition(input(), deps)).outcome).toBe('PENDING');
    const [row] = await ctx.positions.findAllOpening();
    expect(await txAttempts.find(openMintAttemptKey(row!.openIdempotencyKey))).toBeNull();
    ctx.positions.setCreatedAtForTest(row!.id, T0);

    expect((await enforceOpeningTimeout(row!, { positions: ctx.positions, logger: ctx.logger, now: at(TTL) })).result).toEqual({ outcome: 'EXPIRED', mintStatusBefore: null });
    const mintBuild = vi.fn(() => fakeTxDeps(MINTED));
    const resumed = await resumeOpenPosition(row!, { ...deps, readAllowance: vi.fn(async () => 10n ** 40n), buildMintDeps: mintBuild });
    expect(resumed.outcome).toBe('PENDING'); // claim guard: no longer OPENING
    expect((await ctx.positions.findById(row!.id))?.status).toBe('FAILED');
  });

  it('repeated cleanup is a no-op: no second release, no extra attempt rows, status stays FAILED', async () => {
    const ctx = setup();
    const row = await stuckOpening(ctx, T0);
    await enforceOpeningTimeout(row, { positions: ctx.positions, logger: ctx.logger, now: at(TTL) });
    const attemptsAfterFirst = ctx.txAttempts.size();
    for (let i = 0; i < 3; i++) {
      expect(await enforceOpeningTimeout(row, { positions: ctx.positions, logger: ctx.logger, now: at(TTL * 5) })).toEqual({ skipResume: true, result: { outcome: 'NOT_OPENING' } });
    }
    expect(ctx.txAttempts.size()).toBe(attemptsAfterFirst);
    expect((await ctx.positions.findById(row.id))?.status).toBe('FAILED');
    expect(ctx.logger.warn).toHaveBeenCalledTimes(1);
  });

  it('two concurrent timeout calls on the same OPENING: exactly one EXPIRED, the other NOT_OPENING', async () => {
    const ctx = setup();
    const row = await stuckOpening(ctx, T0);
    const results = await Promise.all([
      enforceOpeningTimeout(row, { positions: ctx.positions, logger: ctx.logger, now: at(TTL) }),
      enforceOpeningTimeout(row, { positions: ctx.positions, logger: ctx.logger, now: at(TTL) }),
    ]);
    expect(results.map((r) => r.result.outcome).sort()).toEqual(['EXPIRED', 'NOT_OPENING']);
  });

  it('the successful OPENING -> ACTIVE path is unchanged, and a later timeout check never touches an ACTIVE position', async () => {
    const ctx = setup();
    const outcome = await openPosition(input(), ctx.deps(vi.fn(() => fakeTxDeps(MINTED))));
    expect(outcome.outcome).toBe('ACTIVE');
    if (outcome.outcome !== 'ACTIVE') return;
    const check = await enforceOpeningTimeout(outcome.position, { positions: ctx.positions, logger: ctx.logger, now: at(TTL * 100) });
    expect(check.result).toEqual({ outcome: 'NOT_OPENING' });
    expect((await ctx.positions.findById(outcome.position.id))?.status).toBe('ACTIVE');
  });
});
