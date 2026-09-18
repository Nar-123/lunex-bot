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
    ]);
    expect(snapshot).toEqual({ freeUsdgBalance: USDG(650), totalDeployedUsdg: USDG(650), activePositionsCount: 3 });
  });

  it('never reports a negative free balance', () => {
    expect(deriveCapitalSnapshot(USDG(100), [{ id: 'a', status: 'OPENING', entryUsdgRaw: USDG(350) }]).freeUsdgBalance).toBe(0n);
  });

  it('keeps the portfolio base invariant as OPENING reservations are added -- concurrent reservations can never inflate it (the 1050-vs-950 bug)', () => {
    const rows = [
      { id: 'b', status: 'OPENING', entryUsdgRaw: USDG(350) },
      { id: 'c', status: 'OPENING', entryUsdgRaw: USDG(350) },
    ];
    const fresh = deriveCapitalSnapshot(USDG(1000), rows);
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
