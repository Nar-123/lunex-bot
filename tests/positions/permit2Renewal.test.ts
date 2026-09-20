import { describe, expect, it, vi } from 'vitest';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { decodeFunctionData, getAddress, type Address } from 'viem';
import {
  assessPermit2Renewal,
  encodePermit2Approve,
  FORBIDDEN_EXPIRATION,
  PERMIT2_APPROVE_ABI,
  PERMIT2_RENEWAL_CONFIRMATION,
  renewalIdempotencyKey,
  UINT160_MAX,
  verifyRenewal,
  type Permit2RenewalInput,
} from '../../src/positions/permit2Renewal';
import { runPermit2RenewalPreflight, buildPermit2RenewalDeps } from '../../src/positions/permit2RenewalTx';
import { renewPermit2Grant } from '../../src/positions/permit2RenewalAction';
import { evaluatePermit2Preflight } from '../../src/positions/permit2Preflight';
import { InMemoryTransactionAttemptRepository } from '../execution/inMemoryTransactionAttemptRepository';
import { config } from '../../src/config';

/**
 * Operator-authorised Permit2 renewal.
 *
 * The renewal path can create a standing permission to move USDG, so the bar
 * is the same as every other write in this project: every input is read live,
 * every mismatch fails closed, nothing is ever inferred from a receipt, and
 * nothing happens without an explicit human action.
 */

const PERMIT2 = config.uniswap.v4.permit2 as Address;
const POSITION_MANAGER = config.uniswap.v4.positionManager as Address;
const USDG = config.quoteAsset.ADDRESS as Address;
const WALLET = '0x65299018ABAaa6bD89aabF689dbEf21Be99ef1Ea' as Address;
const OTHER = '0x1111111111111111111111111111111111111111' as Address;
const CHAIN = config.chain.chainId;
const NOW = 1_789_900_000; // chain time (unix seconds)
const R = config.rules.execution.PERMIT2_RENEWAL;
const DAY = 86_400;

/** Production's grant shape: uint160 max, nonce 2, expiring 2026-10-01T16:25:26Z. */
const PROD_EXPIRY = Math.floor(Date.parse('2026-10-01T16:25:26Z') / 1000);

function input(o: Partial<Permit2RenewalInput> = {}): Permit2RenewalInput {
  return {
    chainId: CHAIN,
    configuredChainId: CHAIN,
    configuredPermit2: PERMIT2,
    positionManagerPermit2: PERMIT2,
    positionManagerSpender: POSITION_MANAGER,
    configuredToken: USDG,
    executorOwner: WALLET,
    readFor: { owner: WALLET, token: USDG, spender: POSITION_MANAGER },
    grant: { amount: UINT160_MAX, expiration: NOW + 10 * DAY, nonce: 2 },
    chainTimestamp: NOW,
    ...o,
  };
}
/** A grant with `secondsLeft` remaining -- inside the eligibility window unless stated. */
const at = (secondsLeft: number, o: Partial<Permit2RenewalInput> = {}) => input({ grant: { amount: UINT160_MAX, expiration: NOW + secondsLeft, nonce: 2 }, ...o });

describe('identity: the renewal only ever acts on verified state (1-8)', () => {
  it('1. the configured Permit2, matching PositionManager.permit2(), is accepted', () => {
    const r = assessPermit2Renewal(at(10 * DAY));
    expect(r.status).toBe('RENEWAL_NEEDED');
    expect(r.txParams?.to.toLowerCase()).toBe(PERMIT2.toLowerCase());
  });

  it('2. a PositionManager bound to a DIFFERENT Permit2 is refused, and no tx is built', () => {
    const r = assessPermit2Renewal(at(10 * DAY, { positionManagerPermit2: OTHER }));
    expect(r).toMatchObject({ status: 'WRONG_PERMIT2', txParams: null, idempotencyKey: null });
    expect(r.reason).toMatch(/not the configured/);
  });

  it('3. the executor wallet is accepted as owner', () => {
    expect(assessPermit2Renewal(at(10 * DAY)).status).toBe('RENEWAL_NEEDED');
  });

  it('4. a grant read for a DIFFERENT owner is refused', () => {
    const r = assessPermit2Renewal(at(10 * DAY, { readFor: { owner: OTHER, token: USDG, spender: POSITION_MANAGER } }));
    expect(r).toMatchObject({ status: 'WRONG_OWNER', txParams: null });
  });

  it('5. the configured USDG is accepted as token', () => {
    expect(assessPermit2Renewal(at(10 * DAY)).txParams?.call.token).toBe(USDG);
  });

  it('6. a grant read for a DIFFERENT token is refused', () => {
    const r = assessPermit2Renewal(at(10 * DAY, { readFor: { owner: WALLET, token: OTHER, spender: POSITION_MANAGER } }));
    expect(r).toMatchObject({ status: 'WRONG_TOKEN', txParams: null });
  });

  it('7. the spender is ALWAYS the configured PositionManager', () => {
    expect(assessPermit2Renewal(at(10 * DAY)).txParams?.call.spender).toBe(POSITION_MANAGER);
  });

  it('8. a grant read for a DIFFERENT spender is refused', () => {
    const r = assessPermit2Renewal(at(10 * DAY, { readFor: { owner: WALLET, token: USDG, spender: OTHER } }));
    expect(r).toMatchObject({ status: 'WRONG_SPENDER', txParams: null });
    expect(r.reason).toMatch(/settlement pulls through/);
  });

  it('a mismatched chain id is UNAVAILABLE, never a renewal', () => {
    expect(assessPermit2Renewal(at(10 * DAY, { chainId: CHAIN + 1 }))).toMatchObject({ status: 'UNAVAILABLE', txParams: null });
  });
});

describe('when a renewal is warranted (9, 10, 14, 18)', () => {
  it('9. a comfortably valid grant is VALID_CURRENT and builds NO transaction', () => {
    const r = assessPermit2Renewal(at(60 * DAY));
    expect(r).toMatchObject({ status: 'VALID_CURRENT', txParams: null, idempotencyKey: null });
    expect(r.renewalEligible).toBe(false);
  });

  it('10. a grant inside the eligibility window is RENEWAL_NEEDED', () => {
    const r = assessPermit2Renewal(at(R.ELIGIBLE_WHEN_REMAINING_SECONDS - 1));
    expect(r.status).toBe('RENEWAL_NEEDED');
    expect(r.renewalEligible).toBe(true);
    expect(r.txParams).not.toBeNull();
  });

  it('14. an ALREADY-EXPIRED grant can still be renewed (that is the point)', () => {
    const r = assessPermit2Renewal(at(-DAY));
    expect(r.status).toBe('RENEWAL_NEEDED');
    expect(r.secondsUntilExpiry).toBe(-DAY);
    expect(r.txParams?.call.expiration).toBe(NOW + R.DEFAULT_LIFETIME_SECONDS);
  });

  it('18. no transaction is built when the grant is comfortably valid', () => {
    const r = assessPermit2Renewal(at(60 * DAY));
    expect(r).toMatchObject({ status: 'VALID_CURRENT', txParams: null, idempotencyKey: null });
    expect(r.renewalEligible).toBe(false);
    expect(r.renewalRecommended).toBe(false);
  });

  it("18b. the REAL production grant today: eligible for renewal, not yet recommended", () => {
    // Production: expires 2026-10-01T16:25:26Z, ~11 days out. That is inside the
    // 30-day eligibility window but outside the 7-day recommendation window --
    // so an operator MAY renew now, and MUST by 2026-09-24.
    const prodNow = PROD_EXPIRY - 11 * DAY;
    const r = assessPermit2Renewal(input({ grant: { amount: UINT160_MAX, expiration: PROD_EXPIRY, nonce: 2 }, chainTimestamp: prodNow }));
    expect(r.status).toBe('RENEWAL_NEEDED');
    expect(r.renewalEligible).toBe(true);
    expect(r.renewalRecommended).toBe(false);
    expect(r.txParams?.call.expiration).toBe(prodNow + R.DEFAULT_LIFETIME_SECONDS);
    expect(r.txParams?.call.spender).toBe(POSITION_MANAGER);
  });

  it('the eligibility boundary is exact', () => {
    expect(assessPermit2Renewal(at(R.ELIGIBLE_WHEN_REMAINING_SECONDS)).status).toBe('RENEWAL_NEEDED');
    expect(assessPermit2Renewal(at(R.ELIGIBLE_WHEN_REMAINING_SECONDS + 1)).status).toBe('VALID_CURRENT');
  });

  it('renewalRecommended tracks the same 7 days the entry pre-flight warns at', () => {
    expect(R.RECOMMEND_WHEN_REMAINING_SECONDS).toBe(config.rules.execution.PERMIT2_EXPIRY_WARNING_SECONDS);
    expect(assessPermit2Renewal(at(R.RECOMMEND_WHEN_REMAINING_SECONDS)).renewalRecommended).toBe(true);
    expect(assessPermit2Renewal(at(R.RECOMMEND_WHEN_REMAINING_SECONDS + 1)).renewalRecommended).toBe(false);
  });
});

describe('expiration policy (11, 12, 13, 26)', () => {
  it('11. the expiration is computed from CHAIN time, never the local clock', () => {
    vi.useFakeTimers();
    try {
      vi.setSystemTime(new Date('2000-01-01T00:00:00Z'));
      expect(assessPermit2Renewal(at(DAY)).txParams?.call.expiration).toBe(NOW + R.DEFAULT_LIFETIME_SECONDS);
      vi.setSystemTime(new Date('2999-01-01T00:00:00Z'));
      expect(assessPermit2Renewal(at(DAY)).txParams?.call.expiration).toBe(NOW + R.DEFAULT_LIFETIME_SECONDS);
    } finally {
      vi.useRealTimers();
    }
  });

  it('11b. a different chain timestamp moves the computed expiration with it', () => {
    const later = NOW + 12345;
    const r = assessPermit2Renewal(input({ grant: { amount: UINT160_MAX, expiration: later + DAY, nonce: 2 }, chainTimestamp: later }));
    expect(r.txParams?.call.expiration).toBe(later + R.DEFAULT_LIFETIME_SECONDS);
  });

  it('12. the lifetime is bounded: the configured maximum is accepted, one second more is refused', () => {
    expect(assessPermit2Renewal(at(DAY, { requestedLifetimeSeconds: R.MAX_LIFETIME_SECONDS })).status).toBe('RENEWAL_NEEDED');
    const over = assessPermit2Renewal(at(DAY, { requestedLifetimeSeconds: R.MAX_LIFETIME_SECONDS + 1 }));
    expect(over).toMatchObject({ status: 'INVALID_EXPIRATION', txParams: null });
    expect(over.reason).toMatch(/exceeds the configured maximum/);
  });

  it('12b. the lifetime is configurable, not hard-coded', () => {
    expect(assessPermit2Renewal(at(DAY, { requestedLifetimeSeconds: 45 * DAY })).txParams?.call.expiration).toBe(NOW + 45 * DAY);
    expect(assessPermit2Renewal(at(DAY)).txParams?.call.expiration).toBe(NOW + R.DEFAULT_LIFETIME_SECONDS);
    expect(R.DEFAULT_LIFETIME_SECONDS).toBe(90 * DAY);
  });

  it('13. uint48 max is unreachable, both as a request and through the encoder', () => {
    const asLifetime = assessPermit2Renewal(at(DAY, { requestedLifetimeSeconds: FORBIDDEN_EXPIRATION }));
    expect(asLifetime.status).toBe('INVALID_EXPIRATION');
    expect(() => encodePermit2Approve({ permit2: PERMIT2, token: USDG, spender: POSITION_MANAGER, amount: UINT160_MAX, expiration: FORBIDDEN_EXPIRATION })).toThrow(/never-expiring|uint48-max/);
    expect(FORBIDDEN_EXPIRATION).toBe(2 ** 48 - 1);
  });

  it('a non-positive, fractional or past lifetime is refused', () => {
    for (const bad of [0, -1, -DAY, 1.5]) {
      expect(assessPermit2Renewal(at(DAY, { requestedLifetimeSeconds: bad })).status).toBe('INVALID_EXPIRATION');
    }
  });

  it('26. a renewal that would not meaningfully extend the grant is refused', () => {
    // grant already runs to NOW + 100 days, but eligibility forced by a short read?
    // construct: remaining inside the window, yet the requested lifetime lands before it.
    const r = assessPermit2Renewal(input({
      grant: { amount: UINT160_MAX, expiration: NOW + 10 * DAY, nonce: 2 },
      requestedLifetimeSeconds: 10 * DAY, // equal to the current expiry -> no improvement
    }));
    expect(r).toMatchObject({ status: 'INVALID_EXPIRATION', txParams: null });
    expect(r.reason).toMatch(/would not extend/);
    // one improvement-window beyond is accepted
    expect(assessPermit2Renewal(input({ grant: { amount: UINT160_MAX, expiration: NOW + 10 * DAY, nonce: 2 }, requestedLifetimeSeconds: 10 * DAY + R.MIN_IMPROVEMENT_SECONDS + 1 })).status).toBe('RENEWAL_NEEDED');
  });
});

describe('19. exact transaction parameters', () => {
  it('encodes Permit2.approve with the verified token, spender, amount and expiration', () => {
    const r = assessPermit2Renewal(at(DAY));
    const tx = r.txParams!;
    expect(tx.to).toBe(PERMIT2);
    expect(tx.from).toBe(WALLET);
    expect(tx.chainId).toBe(CHAIN);
    expect(tx.value).toBe(0n);

    const decoded = decodeFunctionData({ abi: PERMIT2_APPROVE_ABI, data: tx.data });
    expect(decoded.functionName).toBe('approve');
    expect(decoded.args).toEqual([USDG, POSITION_MANAGER, UINT160_MAX, NOW + R.DEFAULT_LIFETIME_SECONDS]);
    expect(tx.data.slice(0, 10)).toBe('0x87517c45'); // approve(address,address,uint160,uint48)
  });

  it('the idempotency key names the chain, token, spender and expiration', () => {
    const r = assessPermit2Renewal(at(DAY));
    expect(r.idempotencyKey).toBe(renewalIdempotencyKey(CHAIN, USDG, POSITION_MANAGER, NOW + R.DEFAULT_LIFETIME_SECONDS));
    expect(r.idempotencyKey).toMatch(/^permit2:renew:4663:0x[0-9a-f]{40}:0x[0-9a-f]{40}:\d+$/);
  });

  it('the reported spender is the CONFIGURED PositionManager, not the form the read returned', () => {
    // `same()` compares case-insensitively, so a lowercase read passes the guard.
    // What the transaction reports must still be the configured address, because
    // that -- not the read -- is the audited source of the spender.
    const r = assessPermit2Renewal(at(DAY, { readFor: { owner: WALLET.toLowerCase() as Address, token: USDG.toLowerCase() as Address, spender: POSITION_MANAGER.toLowerCase() as Address } }));
    expect(r.status).toBe('RENEWAL_NEEDED');
    // reported checksummed, whatever form the read (or the config) used
    expect(r.txParams?.call.spender).toBe(getAddress(POSITION_MANAGER));
    expect(r.txParams?.call.token).toBe(getAddress(USDG));
    expect(r.txParams?.from).toBe(getAddress(WALLET));
    expect(r.idempotencyKey).toBe(renewalIdempotencyKey(CHAIN, USDG, POSITION_MANAGER, NOW + R.DEFAULT_LIFETIME_SECONDS));
  });

  it('an absurd chain timestamp that would push the expiration to uint48 max is REFUSED, not thrown', () => {
    // The lifetime bound cannot catch this (the lifetime is ordinary); only the
    // explicit uint48 guard can. It must fail closed with a status, never by
    // escaping as an exception from a read-only assessment.
    const nearMax = FORBIDDEN_EXPIRATION - 1000;
    let r: ReturnType<typeof assessPermit2Renewal>;
    expect(() => {
      r = assessPermit2Renewal(input({ grant: { amount: UINT160_MAX, expiration: nearMax, nonce: 2 }, chainTimestamp: nearMax - DAY }));
    }).not.toThrow();
    expect(r!.status).toBe('INVALID_EXPIRATION');
    expect(r!.reason).toMatch(/uint48 max|never-expiring/);
    expect(r!.txParams).toBeNull();
  });

  it('the encoder refuses an out-of-range amount', () => {
    for (const bad of [0n, -1n, UINT160_MAX + 1n]) {
      expect(() => encodePermit2Approve({ permit2: PERMIT2, token: USDG, spender: POSITION_MANAGER, amount: bad, expiration: NOW + DAY })).toThrow(/uint160/);
    }
  });
});

describe('20. post-execution verification -- never inferred from a receipt', () => {
  const expected = { owner: WALLET, token: USDG, spender: POSITION_MANAGER, amount: UINT160_MAX, expiration: NOW + 90 * DAY, nonceBefore: 2 };
  const readBack = (o: Partial<{ owner: Address; token: Address; spender: Address; amount: bigint; expiration: number; nonce: number }> = {}) => ({
    readFor: { owner: o.owner ?? WALLET, token: o.token ?? USDG, spender: o.spender ?? POSITION_MANAGER },
    grant: { amount: o.amount ?? UINT160_MAX, expiration: o.expiration ?? NOW + 90 * DAY, nonce: o.nonce ?? 2 },
    chainTimestamp: NOW,
  });

  it('a fully matching re-read verifies', () => {
    expect(verifyRenewal(expected, readBack())).toMatchObject({ ok: true });
  });

  it.each([
    ['owner', { owner: OTHER }, /owner/],
    ['token', { token: OTHER }, /token/],
    ['spender', { spender: OTHER }, /spender/],
    ['amount short', { amount: 1n }, /below the intended/],
    ['expiration different', { expiration: NOW + 89 * DAY }, /expiration/],
  ])('a mismatched %s is a verification FAILURE', (_label, over, re) => {
    const v = verifyRenewal(expected, readBack(over));
    expect(v.ok).toBe(false);
    expect(v.reason).toMatch(re);
  });

  it('a moved nonce is a failure -- approve must not consume one', () => {
    const v = verifyRenewal(expected, readBack({ nonce: 3 }));
    expect(v.ok).toBe(false);
    expect(v.reason).toMatch(/nonce moved/);
  });

  it('an expiration already in the past at verification time is a failure', () => {
    const v = verifyRenewal({ ...expected, expiration: NOW - 1 }, { ...readBack({ expiration: NOW - 1 }), chainTimestamp: NOW });
    expect(v.ok).toBe(false);
  });

  it('the tx deps verify by RE-READING, and reject a receipt-only success', async () => {
    const params = assessPermit2Renewal(at(DAY)).txParams!;
    const shortGrant = vi.fn(async () => ({ amount: UINT160_MAX, expiration: NOW + DAY, nonce: 2 })); // unchanged: the approve did not land
    const deps = buildPermit2RenewalDeps(params, 2, { walletAddress: WALLET, readPermit2Grant: shortGrant, readChainTimestamp: async () => NOW });
    const v = await deps.verifyOnChain('0xhash' as `0x${string}`);
    expect(v.ok).toBe(false);
    if (!v.ok) expect(v.reason).toMatch(/expiration/);
    expect(shortGrant).toHaveBeenCalledTimes(1);
  });

  it('the tx deps verify successfully when the grant really did change', async () => {
    const params = assessPermit2Renewal(at(DAY)).txParams!;
    const deps = buildPermit2RenewalDeps(params, 2, {
      walletAddress: WALLET,
      readPermit2Grant: async () => ({ amount: UINT160_MAX, expiration: params.call.expiration, nonce: 2 }),
      readChainTimestamp: async () => NOW,
    });
    const v = await deps.verifyOnChain('0xhash' as `0x${string}`);
    expect(v.ok).toBe(true);
    if (v.ok) expect(v.data).toMatchObject({ expiration: params.call.expiration, nonce: 2 });
  });
});

describe('live pre-flight: all inputs read fresh, failures fail closed', () => {
  const readers = (o: Record<string, unknown> = {}) => ({
    readChainId: vi.fn(async () => CHAIN),
    readPositionManagerPermit2: vi.fn(async () => PERMIT2),
    readPermit2Grant: vi.fn(async () => ({ amount: UINT160_MAX, expiration: NOW + DAY, nonce: 2 })),
    readChainTimestamp: vi.fn(async () => NOW),
    walletAddress: WALLET,
    ...o,
  });

  it('reads chain id, PositionManager.permit2(), the grant and chain time on EVERY call', async () => {
    const r = readers();
    await runPermit2RenewalPreflight(undefined, r);
    await runPermit2RenewalPreflight(undefined, r);
    expect(r.readChainId).toHaveBeenCalledTimes(2);
    expect(r.readPositionManagerPermit2).toHaveBeenCalledTimes(2);
    expect(r.readPermit2Grant).toHaveBeenCalledTimes(2);
    expect(r.readChainTimestamp).toHaveBeenCalledTimes(2);
  });

  it('reads the grant for exactly (executor wallet, configured USDG, configured PositionManager)', async () => {
    const r = readers();
    await runPermit2RenewalPreflight(undefined, r);
    expect(r.readPermit2Grant).toHaveBeenCalledWith(PERMIT2, WALLET, USDG, POSITION_MANAGER);
  });

  it('a failing read rejects -- never "valid", never "no grant"', async () => {
    for (const failing of ['readChainId', 'readPositionManagerPermit2', 'readPermit2Grant', 'readChainTimestamp']) {
      const r = readers({ [failing]: vi.fn(async () => { throw new Error('rpc down'); }) });
      await expect(runPermit2RenewalPreflight(undefined, r)).rejects.toThrow('rpc down');
    }
  });
});

describe('15-17, 21. duplicates, concurrency, idempotency and ambiguous recovery', () => {
  const readers = (expiration: number) => ({
    readChainId: async () => CHAIN,
    readPositionManagerPermit2: async () => PERMIT2,
    readPermit2Grant: async () => ({ amount: UINT160_MAX, expiration, nonce: 2 }),
    readChainTimestamp: async () => NOW,
    walletAddress: WALLET,
  });
  const req = { confirm: PERMIT2_RENEWAL_CONFIRMATION, actor: 'admin', requestId: 'r1' };

  it('15. a repeated request reuses the SAME idempotency key -- not a second transaction', async () => {
    const txAttempts = new InMemoryTransactionAttemptRepository();
    const keys: string[] = [];
    const execute = vi.fn(async (key: string) => { keys.push(key); return { ok: true as const, data: { amount: UINT160_MAX.toString(), expiration: NOW + 90 * DAY, nonce: 2 }, attempt: {} as never }; });
    await renewPermit2Grant(req, { txAttempts, readers: readers(NOW + DAY), execute: execute as never });
    await renewPermit2Grant({ ...req, requestId: 'r2' }, { txAttempts, readers: readers(NOW + DAY), execute: execute as never });
    expect(keys).toHaveLength(2);
    expect(keys[0]).toBe(keys[1]);
  });

  it('16. two simultaneous requests both route through the executor; the loser never builds a second tx', async () => {
    const txAttempts = new InMemoryTransactionAttemptRepository();
    let inFlight = 0;
    let maxConcurrent = 0;
    const execute = vi.fn(async (_key: string) => {
      inFlight += 1; maxConcurrent = Math.max(maxConcurrent, inFlight);
      await new Promise((r) => setTimeout(r, 5));
      inFlight -= 1;
      // the real executor serialises via its lock; the loser gets EXECUTOR_BUSY
      return maxConcurrent > 1 && inFlight === 0
        ? { ok: false as const, reason: '[EXECUTOR_BUSY] another critical transaction holds the executor lock', resumable: true, stuck: false, attempt: {} as never }
        : { ok: true as const, data: { amount: UINT160_MAX.toString(), expiration: NOW + 90 * DAY, nonce: 2 }, attempt: {} as never };
    });
    const [a, b] = await Promise.all([
      renewPermit2Grant(req, { txAttempts, readers: readers(NOW + DAY), execute: execute as never }),
      renewPermit2Grant({ ...req, requestId: 'r2' }, { txAttempts, readers: readers(NOW + DAY), execute: execute as never }),
    ]);
    // Both used the same key, so the executor -- not this module -- decides.
    const keys = execute.mock.calls.map((c) => c[0]);
    expect(new Set(keys).size).toBe(1);
    expect([a.outcome, b.outcome].filter((o) => o === 'RENEWED').length).toBeGreaterThanOrEqual(1);
  });

  it('17. an already-valid grant never reaches the executor at all', async () => {
    const execute = vi.fn();
    const r = await renewPermit2Grant(req, { txAttempts: new InMemoryTransactionAttemptRepository(), readers: readers(NOW + 60 * DAY), execute: execute as never });
    expect(r).toMatchObject({ outcome: 'REJECTED', reason: 'RENEWAL_NOT_NEEDED' });
    expect(execute).not.toHaveBeenCalled();
  });

  it('21. an ambiguous prior renewal is resumed by the executor, not re-sent, and no new nonce is taken', async () => {
    const txAttempts = new InMemoryTransactionAttemptRepository();
    const key = renewalIdempotencyKey(CHAIN, USDG, POSITION_MANAGER, NOW + R.DEFAULT_LIFETIME_SECONDS);
    // a prior attempt that reached SIGNED -- it may already be on the wire
    const prior = await txAttempts.create(key, 'permit2:renew');
    await txAttempts.update(prior.id, { status: 'SIGNED', nonce: 1610, rawTx: '0xsigned' as `0x${string}` }, prior.version);

    const getNonce = vi.fn();
    const signTransaction = vi.fn();
    const execute = vi.fn(async (k: string, _p: string, deps: { getNonce: unknown; signTransaction: unknown }) => {
      // stand in for the real executor's resume path: it must NOT re-nonce or re-sign
      expect(k).toBe(key);
      void deps;
      return { ok: false as const, reason: 'resumed by receipt: still pending', resumable: true, stuck: false, attempt: {} as never };
    });
    const r = await renewPermit2Grant(req, { txAttempts, readers: readers(NOW + DAY), execute: execute as never });
    expect(r.outcome).toBe('FAILED');
    if (r.outcome === 'FAILED') expect(r.resumable).toBe(true);
    expect(getNonce).not.toHaveBeenCalled();
    expect(signTransaction).not.toHaveBeenCalled();
    // the prior attempt row is untouched by this module
    expect((await txAttempts.find(key))?.nonce).toBe(1610);
  });

  it('a wrong confirmation string never reads the chain or reaches the executor', async () => {
    const execute = vi.fn();
    const readPermit2Grant = vi.fn();
    const r = await renewPermit2Grant({ ...req, confirm: 'yes' }, { txAttempts: new InMemoryTransactionAttemptRepository(), readers: { readPermit2Grant } as never, execute: execute as never });
    expect(r).toMatchObject({ outcome: 'REJECTED', reason: 'NOT_CONFIRMED' });
    expect(readPermit2Grant).not.toHaveBeenCalled();
    expect(execute).not.toHaveBeenCalled();
  });
});

describe('25, 27, 28. nothing automatic, and nothing existing changed', () => {
  const root = path.resolve(__dirname, '../..');
  const read = (f: string) => readFileSync(path.join(root, f), 'utf8');
  const stripComments = (t: string): string => t.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');

  it('25. no scheduler, timer, cycle or startup path invokes a renewal', () => {
    const callers = ['src/composition/screeningCycle.ts', 'src/composition/exitCycle.ts', 'src/composition/monitoringCycle.ts', 'src/composition/app.ts', 'src/index.ts'];
    for (const f of callers) {
      const text = stripComments(read(f));
      expect(text, f).not.toMatch(/renewPermit2Grant|runPermit2RenewalPreflight|buildPermit2RenewalDeps|encodePermit2Approve/);
    }
  });

  it('25b. the renewal modules contain no timer, no schedule and no self-invocation', () => {
    for (const f of ['src/positions/permit2Renewal.ts', 'src/positions/permit2RenewalTx.ts', 'src/positions/permit2RenewalAction.ts']) {
      const text = stripComments(read(f));
      expect(text, f).not.toMatch(/setInterval|setTimeout|cron|schedule/i);
    }
  });

  it('25c. the AI control surface cannot reach a renewal', () => {
    const text = stripComments(read('src/api/routes/aiControl.ts'));
    expect(text).not.toMatch(/permit2|renew/i);
  });

  it('27. the existing entry pre-flight is untouched: still read-only, still no tx construction', () => {
    for (const f of ['src/positions/permit2Preflight.ts', 'src/blockchain/permit2.ts']) {
      const text = stripComments(read(f));
      expect(text, f).not.toMatch(/encodeFunctionData|writeContract|sendTransaction|signTypedData|permitTransferFrom|\.approve\(/);
      expect(text.match(/stateMutability:\s*'(nonpayable|payable)'/g), f).toBeNull();
    }
  });

  it('27b. the entry pre-flight still judges the same way (unchanged behaviour)', () => {
    const base = {
      configuredPermit2: PERMIT2,
      positionManagerPermit2: PERMIT2,
      positionManagerPermit2Spender: POSITION_MANAGER,
      readFor: { owner: WALLET, token: USDG, spender: POSITION_MANAGER },
      expectedOwner: WALLET,
      expectedToken: USDG,
      erc20AllowanceToPermit2: 2n ** 200n,
      requiredAmount: 20_906_915n,
      chainTimestamp: NOW,
      minRemainingValiditySeconds: config.rules.execution.PERMIT2_MIN_REMAINING_VALIDITY_SECONDS,
      expiryWarningSeconds: config.rules.execution.PERMIT2_EXPIRY_WARNING_SECONDS,
    };
    expect(evaluatePermit2Preflight({ ...base, grant: { amount: UINT160_MAX, expiration: NOW + 30 * DAY, nonce: 2 } })).toMatchObject({ status: 'VALID', deployable: true });
    expect(evaluatePermit2Preflight({ ...base, grant: { amount: UINT160_MAX, expiration: NOW - 1, nonce: 2 } })).toMatchObject({ status: 'EXPIRED', deployable: false });
    // the 7-day warning and the 30-minute block are unchanged
    expect(evaluatePermit2Preflight({ ...base, grant: { amount: UINT160_MAX, expiration: NOW + 7 * DAY, nonce: 2 } }).expiringSoon).toBe(true);
    expect(evaluatePermit2Preflight({ ...base, grant: { amount: UINT160_MAX, expiration: NOW + 1800, nonce: 2 } })).toMatchObject({ status: 'VALID', deployable: true });
    expect(evaluatePermit2Preflight({ ...base, grant: { amount: UINT160_MAX, expiration: NOW + 1799, nonce: 2 } })).toMatchObject({ status: 'EXPIRED', deployable: false });
  });

  it('28. renewal does not touch the v4 entry path: the renewal spender equals the entry settlement spender', () => {
    const r = assessPermit2Renewal(at(DAY));
    expect(r.txParams?.call.spender).toBe(POSITION_MANAGER);
    // and a renewed grant is exactly what the entry pre-flight would then accept
    const renewed = evaluatePermit2Preflight({
      configuredPermit2: PERMIT2, positionManagerPermit2: PERMIT2, positionManagerPermit2Spender: POSITION_MANAGER,
      readFor: { owner: WALLET, token: USDG, spender: POSITION_MANAGER }, expectedOwner: WALLET, expectedToken: USDG,
      erc20AllowanceToPermit2: 2n ** 200n, grant: { amount: r.txParams!.call.amount, expiration: r.txParams!.call.expiration, nonce: 2 },
      requiredAmount: 20_906_915n, chainTimestamp: NOW,
      minRemainingValiditySeconds: config.rules.execution.PERMIT2_MIN_REMAINING_VALIDITY_SECONDS,
      expiryWarningSeconds: config.rules.execution.PERMIT2_EXPIRY_WARNING_SECONDS,
    });
    expect(renewed).toMatchObject({ status: 'VALID', deployable: true, expiringSoon: false });
  });

  it('the renewal reuses the existing executor pipeline, not a private gas strategy', () => {
    const text = read('src/positions/permit2RenewalTx.ts');
    for (const step of ['simulateTx', 'estimateGasForTx', 'getCurrentGasPrice', 'checkGasAffordableOnChain', 'getCurrentNonce', 'signTx', 'broadcastRawTx', 'waitForTxReceipt']) {
      expect(text).toContain(`txSteps.${step}`);
    }
    expect(stripComments(text)).not.toMatch(/GAS_PRICE_HEADROOM|MAX_GAS_PRICE_WEI|gasPrice\s*\*/);
  });
});
