import { describe, expect, it } from 'vitest';
import { filterToClosingPositions } from '../../src/exits/stuckSwapRetries';

describe('filterToClosingPositions -- H16', () => {
  it('excludes a position id that is no longer in the currently-CLOSING set (e.g. it CLOSED)', () => {
    const result = filterToClosingPositions(['pos-closed', 'pos-still-closing'], ['pos-still-closing']);
    expect(result).toEqual(['pos-still-closing']);
  });

  it('returns an empty list when nothing is currently CLOSING, even if the raw list is non-empty', () => {
    expect(filterToClosingPositions(['pos-1', 'pos-2'], [])).toEqual([]);
  });

  it('returns everything unchanged when every raw id is currently CLOSING', () => {
    expect(filterToClosingPositions(['a', 'b'], ['a', 'b', 'c'])).toEqual(['a', 'b']);
  });
});
