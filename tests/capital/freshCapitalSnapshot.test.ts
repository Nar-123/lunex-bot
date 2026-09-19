import { describe, expect, it } from 'vitest';
import { checkCapitalStateConsistent, deriveCapitalSnapshot } from '../../src/capital/freshCapitalSnapshot';
import { decideCapitalAllocation } from '../../src/capital/decideCapitalAllocation';
import type { CapitalRules } from '../../src/capital/types';
import { isCapitalLockContention } from '../../src/positions/positionRepository';

const USDG = (n: number): bigint => BigInt(n) * 10n ** 18n;

const PROD_RULES: CapitalRules = {
  MAX_ACTIVE_POSITIONS: 3,
  POSITION_SIZE_PCT_OF_FREE_BALANCE: 0.35,
  MAX_TOTAL_DEPLOYED_PCT_OF_PORTFOLIO: 0.95,
  ETH_GAS_RESERVE_ENABLED: false,
  ETH_GAS_RESERVE_MIN: 0,
};

describe('deriveCapitalSnapshot -- P1-1: one formula for sizing AND the write-time re-check', () => {
  it('subtracts OPENING reservations from the RAW balance and counts every non-closed row as deployed', () => {
    const snapshot = deriveCapitalSnapshot(USDG(1000), [
      { id: 'a', status: 'OPENING', entryUsdgRaw: USDG(350) },
      { id: 'b', status: 'ACTIVE', entryUsdgRaw: USDG(200) },
      { id: 'c', status: 'CLOSING', entryUsdgRaw: USDG(100) },
    ], []);
    expect(snapshot).toEqual({ freeUsdgBalance: USDG(650), totalDeployedUsdg: USDG(650), activePositionsCount: 3 });
  });

  it('never reports a negative free balance', () => {
    expect(deriveCapitalSnapshot(USDG(100), [{ id: 'a', status: 'OPENING', entryUsdgRaw: USDG(350) }], null).freeUsdgBalance).toBe(0n);
  });

  it('keeps the portfolio base invariant as OPENING reservations are added -- concurrent reservations can never inflate it (the 1050-vs-950 bug)', () => {
    const rows = [
      { id: 'b', status: 'OPENING', entryUsdgRaw: USDG(350) },
      { id: 'c', status: 'OPENING', entryUsdgRaw: USDG(350) },
    ];
    const fresh = deriveCapitalSnapshot(USDG(1000), rows, null);
    expect(fresh.freeUsdgBalance + fresh.totalDeployedUsdg).toBe(USDG(1000));
    const decision = decideCapitalAllocation(fresh, PROD_RULES);
    // remaining = 950 - 700 = 250: a caller pre-sized at 350 no longer fits.
    expect(decision).toEqual({ ok: true, positionSizeUsdgRaw: USDG(250) });

    // The pre-fix pairing (stale free 1000 + fresh deployed 700) -> phantom
    // base 1700: target 35% * 1700 = 595, remaining 0.95 * 1700 - 700 = 915,
    // so it would have approved up to 595 -- a pre-sized 350 "fits" and the
    // book ends at 1050 against a real 950 cap.
    const legacy = decideCapitalAllocation({ freeUsdgBalance: USDG(1000), totalDeployedUsdg: USDG(700), activePositionsCount: 2 }, PROD_RULES);
    expect(legacy).toEqual({ ok: true, positionSizeUsdgRaw: USDG(595) });
  });
});

describe('checkCapitalStateConsistent -- P1-1: can a balance read before the lock still be paired with the rows read under it?', () => {
  const observed = new Map([
    ['a', 'OPENING'],
    ['b', 'ACTIVE'],
  ]);

  it('accepts an unchanged row set', () => {
    expect(
      checkCapitalStateConsistent(observed, [
        { id: 'a', status: 'OPENING', entryUsdgRaw: 1n },
        { id: 'b', status: 'ACTIVE', entryUsdgRaw: 1n },
      ]),
    ).toEqual({ ok: true });
  });

  it('accepts NEW rows that are still OPENING (concurrent reservations -- recalculated, not rejected)', () => {
    expect(
      checkCapitalStateConsistent(observed, [
        { id: 'a', status: 'OPENING', entryUsdgRaw: 1n },
        { id: 'b', status: 'ACTIVE', entryUsdgRaw: 1n },
        { id: 'new', status: 'OPENING', entryUsdgRaw: 1n },
      ]),
    ).toEqual({ ok: true });
  });

  it('rejects an observed OPENING row that became ACTIVE (its mint may have debited the wallet after the balance read)', () => {
    const result = checkCapitalStateConsistent(observed, [
      { id: 'a', status: 'ACTIVE', entryUsdgRaw: 1n },
      { id: 'b', status: 'ACTIVE', entryUsdgRaw: 1n },
    ]);
    expect(result.ok).toBe(false);
  });

  it('rejects a NEW row that is already past OPENING', () => {
    const result = checkCapitalStateConsistent(observed, [
      { id: 'a', status: 'OPENING', entryUsdgRaw: 1n },
      { id: 'b', status: 'ACTIVE', entryUsdgRaw: 1n },
      { id: 'new', status: 'ACTIVE', entryUsdgRaw: 1n },
    ]);
    expect(result.ok).toBe(false);
  });

  it('rejects an observed row that left the non-closed set (closed/failed -- balance may have changed)', () => {
    const result = checkCapitalStateConsistent(observed, [{ id: 'a', status: 'OPENING', entryUsdgRaw: 1n }]);
    expect(result.ok).toBe(false);
  });
});

describe('isCapitalLockContention -- P1-1: lock contention is classified for fail-closed handling', () => {
  it.each([
    'SQLITE_BUSY: database is locked',
    'database is locked',
    'Transaction API error: Unable to start a transaction in the given time.',
    'Invalid `prisma.$transaction()` invocation: P2028',
    'Operation has timed out',
  ])('treats %j as contention', (message) => {
    expect(isCapitalLockContention(message)).toBe(true);
  });

  it('does not swallow unrelated errors (they still propagate)', () => {
    expect(isCapitalLockContention('Unique constraint failed on the fields: (`openIdempotencyKey`)')).toBe(false);
    expect(isCapitalLockContention('Record to update not found.')).toBe(false);
  });
});

describe('H2: CLOSING positions that already returned USDG are never counted twice (assessRemainingExposure / deriveCapitalSnapshot)', () => {
  const KEY = 'exit:b:1';
  const closing = (entry = USDG(350)) => ({ id: 'b', status: 'CLOSING', entryUsdgRaw: entry, closeIdempotencyKey: KEY });
  const attempt = (suffix: string, status: string, verifyData: unknown = null) => ({ idempotencyKey: `${KEY}:${suffix}`, status, verifyData });
  const verifiedRemove = (usdg: bigint, token = 0n) => attempt('removeLiquidity', 'VERIFIED', { liquidityZero: true, usdgProceedsRaw: usdg, tokenProceedsRaw: token });

  it('ACTIVE: carried at entry, free + deployed = wallet + entry (unchanged)', () => {
    const s = deriveCapitalSnapshot(USDG(650), [{ id: 'a', status: 'ACTIVE', entryUsdgRaw: USDG(350) }], []);
    expect(s).toEqual({ freeUsdgBalance: USDG(650), totalDeployedUsdg: USDG(350), activePositionsCount: 1 });
  });

  it('CLOSING before remove-liquidity (no leg, or pre-broadcast leg, or FAILED leg): still fully deployed -- the LP is intact', () => {
    for (const legs of [[], [attempt('removeLiquidity', 'PENDING')], [attempt('removeLiquidity', 'NONCE_ASSIGNED')], [attempt('removeLiquidity', 'FAILED')]]) {
      expect(deriveCapitalSnapshot(USDG(650), [closing()], legs)).toEqual({ freeUsdgBalance: USDG(650), totalDeployedUsdg: USDG(350), activePositionsCount: 1 });
    }
  });

  it('REGRESSION (the concrete H2 case): wallet back to 1000 after the burn returned 350, position still CLOSING -> the allocator sees 1000, NOT 1350', () => {
    const s = deriveCapitalSnapshot(USDG(1000), [closing()], [verifiedRemove(USDG(350))]);
    expect(s).toEqual({ freeUsdgBalance: USDG(1000), totalDeployedUsdg: 0n, activePositionsCount: 1 }); // slot still occupied until CLOSED
    expect(s.freeUsdgBalance + s.totalDeployedUsdg).toBe(USDG(1000));
    // The pre-H2 figure for the same state:
    const legacy = deriveCapitalSnapshot(USDG(1000), [{ id: 'b', status: 'ACTIVE', entryUsdgRaw: USDG(350) }], []);
    expect(legacy.freeUsdgBalance + legacy.totalDeployedUsdg).toBe(USDG(1350));
  });

  it('CLOSING after remove with TOKEN swap pending: only the unrecovered cost basis stays deployed (entry 350, 200 USDG back -> 150), the 200 is counted once, in the wallet', () => {
    const s = deriveCapitalSnapshot(USDG(850), [closing()], [verifiedRemove(USDG(200), USDG(3))]); // 650 + 200 returned
    expect(s.totalDeployedUsdg).toBe(USDG(150));
    expect(s.freeUsdgBalance + s.totalDeployedUsdg).toBe(USDG(1000));
  });

  it('swap VERIFIED but the process died before markClosed: fully converted -> nothing deployed, whether proceeds beat the entry or fell short (a shortfall is a realized loss already in the wallet, not exposure)', () => {
    const swap = attempt('swap:0', 'VERIFIED', { usdgIncreaseRaw: USDG(160), usdgProceedsRaw: USDG(160) });
    expect(deriveCapitalSnapshot(USDG(1010), [closing()], [verifiedRemove(USDG(200), USDG(3)), swap]).totalDeployedUsdg).toBe(0n);
    const partial = attempt('swap:0', 'VERIFIED', { usdgIncreaseRaw: USDG(100), usdgProceedsRaw: USDG(100) });
    expect(deriveCapitalSnapshot(USDG(950), [closing()], [verifiedRemove(USDG(200), USDG(3)), partial]).totalDeployedUsdg).toBe(0n);
  });

  it('a FAILED swap and approve legs never move the figure (no USDG delivered through a verified receipt / approvals move no USDG)', () => {
    const legs = [verifiedRemove(USDG(200), USDG(3)), attempt('approve:0', 'VERIFIED', { allowanceRaw: 1n }), attempt('swap:0', 'FAILED'), attempt('approve:1', 'SENT')];
    const s = deriveCapitalSnapshot(USDG(850), [closing()], legs);
    expect(s.totalDeployedUsdg).toBe(USDG(150));
    expect(s.accountingUnresolvedReason).toBeUndefined();
  });

  it.each(['SIGNED', 'SENT', 'CONFIRMED'])('remove-liquidity %s (possibly mined, not verified) -> UNRESOLVED, and the allocator fails closed', (status) => {
    const s = deriveCapitalSnapshot(USDG(1000), [closing()], [attempt('removeLiquidity', status)]);
    expect(s.accountingUnresolvedReason).toMatch(new RegExp(`removeLiquidity is ${status}`));
    const decision = decideCapitalAllocation(s, PROD_RULES);
    expect(decision.ok).toBe(false);
    if (!decision.ok) expect(decision.reason).toMatch(/capital accounting unresolved \(fail-closed\)/);
  });

  it.each(['SIGNED', 'SENT', 'CONFIRMED'])('swap %s after a verified remove -> UNRESOLVED (its USDG may already be in the wallet)', (status) => {
    const s = deriveCapitalSnapshot(USDG(1000), [closing()], [verifiedRemove(USDG(200), USDG(3)), attempt('swap:1', status)]);
    expect(s.accountingUnresolvedReason).toMatch(/swap:1 is/);
    expect(decideCapitalAllocation(s, PROD_RULES).ok).toBe(false);
  });

  it('a VERIFIED remove whose USDG proceeds were never measured (legacy attempt) -> UNRESOLVED, never guessed', () => {
    const s = deriveCapitalSnapshot(USDG(1000), [closing()], [attempt('removeLiquidity', 'VERIFIED', { liquidityZero: true })]);
    expect(s.accountingUnresolvedReason).toMatch(/never measured/);
  });

  it('exit-leg attempts not provided at all + a CLOSING row -> UNRESOLVED (never silently back to the double-counting figure)', () => {
    const s = deriveCapitalSnapshot(USDG(1000), [closing()], null);
    expect(s.accountingUnresolvedReason).toMatch(/not provided/);
    expect(decideCapitalAllocation(s, PROD_RULES).ok).toBe(false);
  });

  it("only THIS close's legs count: attempts from an earlier, reverted close (a different closeIdempotencyKey) are ignored", () => {
    const stale = { idempotencyKey: 'exit:b:0:removeLiquidity', status: 'VERIFIED', verifyData: { liquidityZero: true, usdgProceedsRaw: USDG(350) } };
    const staleInFlight = { idempotencyKey: 'exit:b:0:swap:0', status: 'SENT', verifyData: null };
    const s = deriveCapitalSnapshot(USDG(650), [closing()], [stale, staleInFlight]);
    expect(s).toEqual({ freeUsdgBalance: USDG(650), totalDeployedUsdg: USDG(350), activePositionsCount: 1 });
  });

  it('35% sizing is NOT inflated by returned USDG: A ACTIVE 350, B CLOSING with 345 USDG back (5 TOKEN pending), true portfolio 1000 -> next size 350 (35%), not the pre-H2 470.75', () => {
    const rows = [{ id: 'a', status: 'ACTIVE', entryUsdgRaw: USDG(350) }, closing()];
    const wallet = USDG(1000) - USDG(350) - USDG(350) + USDG(345); // 645
    const s = deriveCapitalSnapshot(wallet, rows, [verifiedRemove(USDG(345), 5n)]);
    expect(s.freeUsdgBalance + s.totalDeployedUsdg).toBe(USDG(1000));
    expect(decideCapitalAllocation(s, PROD_RULES)).toEqual({ ok: true, positionSizeUsdgRaw: USDG(350) });
    // pre-H2: deployed 700 + wallet 645 = phantom base 1345 -> 35% = 470.75
    const legacy = decideCapitalAllocation({ freeUsdgBalance: wallet, totalDeployedUsdg: USDG(700), activePositionsCount: 2 }, PROD_RULES);
    expect(legacy).toEqual({ ok: true, positionSizeUsdgRaw: (USDG(1345) * 35n) / 100n });
  });

  it('95% cap cannot be bypassed while CLOSING positions hold returned USDG: filling positions one by one, TRUE exposure never exceeds 95% and no size exceeds 35% of the TRUE portfolio', () => {
    // True portfolio 2000: B (entry 600) is CLOSING with 590 USDG back and 10 of TOKEN still to swap.
    const TRUE_PORTFOLIO = USDG(2000);
    const rows: Array<{ id: string; status: string; entryUsdgRaw: bigint; closeIdempotencyKey?: string }> = [closing(USDG(600))];
    let wallet = TRUE_PORTFOLIO - USDG(10); // the only thing outside the wallet is B's unswapped TOKEN (cost 10)
    const legs = [verifiedRemove(USDG(590), 7n)];
    for (let i = 0; i < 5; i++) {
      const s = deriveCapitalSnapshot(wallet, rows, legs);
      const decision = decideCapitalAllocation(s, PROD_RULES);
      if (!decision.ok) break;
      expect(decision.positionSizeUsdgRaw * 100n <= TRUE_PORTFOLIO * 35n).toBe(true);
      rows.push({ id: `n${i}`, status: 'ACTIVE', entryUsdgRaw: decision.positionSizeUsdgRaw });
      wallet -= decision.positionSizeUsdgRaw;
      const trueDeployed = TRUE_PORTFOLIO - wallet; // everything not in the wallet is at risk
      expect(trueDeployed * 100n <= TRUE_PORTFOLIO * 95n).toBe(true);
    }
    expect(rows.length).toBe(3); // B + 2 new: the 3-position cap still counts the CLOSING slot
  });
});
