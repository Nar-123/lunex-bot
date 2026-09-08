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

  it('rejects a Stock-type asset regardless of every other metric being excellent', async () => {
    const token = makeCandidateToken({ assetType: 'Stock', marketCapUsd: 100_000_000, totalFeeEth: 50 });
    const result = await screenCandidate(token, deps());
    expect(result.passed).toBe(false);
    expect(result.failedRule).toBe('ASSET_TYPE');
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
