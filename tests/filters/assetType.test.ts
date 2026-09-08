import { describe, expect, it } from 'vitest';
import { checkAssetType } from '../../src/filters/rules/assetType';
import { makeCandidateToken } from '../fixtures/candidateToken';

describe('checkAssetType', () => {
  it.each(['Meme', 'Project'] as const)('passes for allowed type "%s"', (assetType) => {
    expect(checkAssetType(makeCandidateToken({ assetType })).passed).toBe(true);
  });

  it.each([
    'Stock',
    'ETF',
    'Index',
    'RWA',
    'Tokenized Equity',
    'Wrapped Stock',
    'Unknown',
  ] as const)('fails for rejected type "%s"', (assetType) => {
    expect(checkAssetType(makeCandidateToken({ assetType })).passed).toBe(false);
  });
});
