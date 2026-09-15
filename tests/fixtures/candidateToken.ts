import type { CandidateToken } from '../../src/discovery/types';

/** A candidate that passes every static filter rule by default; override fields per test. */
export function makeCandidateToken(overrides: Partial<CandidateToken> = {}): CandidateToken {
  const now = Date.now();
  return {
    address: '0x' + '33'.repeat(20),
    chainId: 1337,
    symbol: 'TEST',
    name: 'Test Token',
    assetType: 'Meme',
    marketCapUsd: 2_000_000,
    volumeUsd: 100_000,
    totalFeeEth: 1,
    createdAt: now - 2 * 24 * 60 * 60 * 1000,
    top10HolderConcentrationPct: 0.2,
    rank: 1,
    discoveredAt: now,
    source: 'GMGN',
    // Phase 12: STOCK_ONLY mode reads `stockClassification`, not the
    // flattened `assetType` string -- set here so this fixture keeps
    // "passes every static filter rule by default" true under the new
    // default mode without every existing call site needing an update.
    stockClassification: 'NON_STOCK',
    ...overrides,
  };
}
