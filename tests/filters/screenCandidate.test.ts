import { describe, expect, it } from 'vitest';
import { screenCandidate, screenCandidates, getPassingCandidates } from '../../src/filters/screenCandidate';
import { makeCandidateToken } from '../fixtures/candidateToken';
import type { ScreeningDeps } from '../../src/filters/types';

function deps(overrides: Partial<{ hasActivePosition: boolean; inCooldown: boolean }> = {}): ScreeningDeps {
  return {
    activePositionChecker: { hasActivePosition: async () => overrides.hasActivePosition ?? false },
    cooldownChecker: {
      getCooldownStatus: async () => ({
        inCooldown: overrides.inCooldown ?? false,
        remainingMs: overrides.inCooldown ? 60_000 : 0,
      }),
    },
  };
}

describe('screenCandidate', () => {
  it('passes a candidate that clears every rule', async () => {
    const result = await screenCandidate(makeCandidateToken(), deps());
    expect(result.passed).toBe(true);
    expect(result.failedRule).toBeUndefined();
    expect(result.checks).toHaveLength(8);
    expect(result.checks.every((c) => c.passed)).toBe(true);
  });

  it('reports the first failing rule in spec-table order (market cap before token age)', async () => {
    const token = makeCandidateToken({
      marketCapUsd: 100, // fails
      createdAt: Date.now(), // also fails (too young)
    });
    const result = await screenCandidate(token, deps());
    expect(result.passed).toBe(false);
    expect(result.failedRule).toBe('MARKET_CAP');
  });

  it('still evaluates and reports every rule even when an early one fails', async () => {
    const token = makeCandidateToken({ marketCapUsd: 100 });
    const result = await screenCandidate(token, deps());
    expect(result.checks).toHaveLength(8);
    expect(result.checks.map((c) => c.rule)).toEqual([
      'MARKET_CAP',
      'TOKEN_AGE',
      'VOLUME',
      'TOTAL_FEE',
      'HOLDER_CONCENTRATION',
      'ASSET_TYPE',
      'DUPLICATE_POSITION',
      'COOLDOWN',
    ]);
  });

  it('fails on duplicate position even if all static rules pass', async () => {
    const result = await screenCandidate(makeCandidateToken(), deps({ hasActivePosition: true }));
    expect(result.passed).toBe(false);
    expect(result.failedRule).toBe('DUPLICATE_POSITION');
  });

  it('fails on cooldown even if all static rules and duplicate check pass', async () => {
    const result = await screenCandidate(makeCandidateToken(), deps({ inCooldown: true }));
    expect(result.passed).toBe(false);
    expect(result.failedRule).toBe('COOLDOWN');
  });

  it('rejects a confirmed Stock candidate regardless of every other metric being excellent, when ASSET_TYPE is enabled', async () => {
    const token = makeCandidateToken({ assetType: 'Stock', stockClassification: 'ROBINHOOD_OFFICIAL_STOCK', marketCapUsd: 100_000_000, totalFeeEth: 50 });
    const result = await screenCandidate(token, deps(), Date.now(), true);
    expect(result.passed).toBe(false);
    expect(result.failedRule).toBe('ASSET_TYPE');
  });

  describe('ASSET_TYPE.ENABLED gating, STOCK_ONLY mode (Phase 12, operator-approved specification revision)', () => {
    it('ENABLED=true rejects a confirmed Stock candidate (hard safety, unchanged by the Phase 12 revision)', async () => {
      const token = makeCandidateToken({ assetType: 'Stock', stockClassification: 'ROBINHOOD_OFFICIAL_STOCK', marketCapUsd: 100_000_000, totalFeeEth: 50 });
      const result = await screenCandidate(token, deps(), Date.now(), true);
      expect(result.passed).toBe(false);
      expect(result.failedRule).toBe('ASSET_TYPE');
      expect(result.checks.find((c) => c.rule === 'ASSET_TYPE')?.passed).toBe(false);
    });

    it('ENABLED=true now ALLOWS a confirmed NON_STOCK candidate, even with assetType="Unknown" -- the actual live-GMGN case, and the whole point of Phase 12', async () => {
      const token = makeCandidateToken({ assetType: 'Unknown', stockClassification: 'NON_STOCK', marketCapUsd: 100_000_000, totalFeeEth: 50 });
      const result = await screenCandidate(token, deps(), Date.now(), true);
      expect(result.passed).toBe(true);
      expect(result.failedRule).toBeUndefined();
    });

    it('ENABLED=true still REJECTS when the Stock classifier could not resolve (UNKNOWN) -- fail-safe, never silently allowed just because assetType also reads "Unknown"', async () => {
      const token = makeCandidateToken({ assetType: 'Unknown', stockClassification: 'UNKNOWN', marketCapUsd: 100_000_000, totalFeeEth: 50 });
      const result = await screenCandidate(token, deps(), Date.now(), true);
      expect(result.passed).toBe(false);
      expect(result.failedRule).toBe('ASSET_TYPE');
    });

    it('ENABLED=false lets an otherwise-passing candidate through regardless of stockClassification', async () => {
      const token = makeCandidateToken({ assetType: 'Unknown', stockClassification: 'UNKNOWN' });
      const result = await screenCandidate(token, deps(), Date.now(), false);
      expect(result.passed).toBe(true);
      expect(result.failedRule).toBeUndefined();
    });

    it('the real config default is ENABLED=true, mode=STOCK_ONLY -- calling screenCandidate with no override reflects that: confirmed NON_STOCK passes', async () => {
      const token = makeCandidateToken({ assetType: 'Unknown', stockClassification: 'NON_STOCK' });
      const result = await screenCandidate(token, deps()); // no 4th arg -- uses config.rules.filters.ASSET_TYPE.ENABLED
      expect(result.passed).toBe(true);
      expect(result.failedRule).toBeUndefined();
    });

    it('reporting stays intact when disabled: ASSET_TYPE still appears in checks[] with its true pass/fail, just non-blocking', async () => {
      const token = makeCandidateToken({ assetType: 'Stock', stockClassification: 'ROBINHOOD_OFFICIAL_STOCK' });
      const result = await screenCandidate(token, deps(), Date.now(), false);
      expect(result.checks).toHaveLength(8);
      const assetTypeCheck = result.checks.find((c) => c.rule === 'ASSET_TYPE');
      expect(assetTypeCheck?.passed).toBe(false); // honestly reported as a confirmed Stock, would fail...
      expect(assetTypeCheck?.reason).toMatch(/rejected/);
      expect(result.passed).toBe(true); // ...but did not block the candidate
      expect(result.failedRule).toBeUndefined();
    });

    it('disabling ASSET_TYPE does not rewrite token.assetType or touch any other rule', async () => {
      const token = makeCandidateToken({ assetType: 'Unknown' });
      const result = await screenCandidate(token, deps(), Date.now(), false);
      expect(token.assetType).toBe('Unknown'); // never mapped to Meme/Project
      expect(result.checks.map((c) => c.rule)).toEqual([
        'MARKET_CAP',
        'TOKEN_AGE',
        'VOLUME',
        'TOTAL_FEE',
        'HOLDER_CONCENTRATION',
        'ASSET_TYPE',
        'DUPLICATE_POSITION',
        'COOLDOWN',
      ]);
      expect(result.checks.every((c) => c.rule === 'ASSET_TYPE' || c.passed)).toBe(true);
    });

    it('other rules still block normally with ASSET_TYPE disabled -- MARKET_CAP failure is not swallowed', async () => {
      const token = makeCandidateToken({ assetType: 'Unknown', marketCapUsd: 100 }); // fails MARKET_CAP too
      const result = await screenCandidate(token, deps(), Date.now(), false);
      expect(result.passed).toBe(false);
      expect(result.failedRule).toBe('MARKET_CAP'); // first failure in spec-table order, ASSET_TYPE never gets a chance to matter
    });
  });
});

describe('screenCandidates / getPassingCandidates', () => {
  it('filters a ranked list down to only the passing candidates, preserving order', async () => {
    const good = makeCandidateToken({ address: '0xgood', symbol: 'GOOD', rank: 1 });
    const bad = makeCandidateToken({ address: '0xbad', symbol: 'BAD', rank: 2, marketCapUsd: 1 });
    const alsoGood = makeCandidateToken({ address: '0xalsogood', symbol: 'ALSOGOOD', rank: 3 });

    const tokens = [good, bad, alsoGood];
    const results = await screenCandidates(tokens, deps());
    const passing = getPassingCandidates(tokens, results);

    expect(passing.map((t) => t.symbol)).toEqual(['GOOD', 'ALSOGOOD']);
  });
});
