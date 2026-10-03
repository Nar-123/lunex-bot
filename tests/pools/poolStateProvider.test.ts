import { describe, expect, it } from 'vitest';
import type { Address } from 'viem';
import { __internal, checkStateViewBinding } from '../../src/pools/poolStateProvider';

const { compress, wordPosition, bitPosition, setBitsToCompressedTicks, tickWindowForWords, BITS_PER_WORD } = __internal;

describe('checkStateViewBinding', () => {
  const poolManager: Address = '0x8366a39cc670b4001a1121b8f6a443a643e40951';

  it('passes silently when StateView is bound to the configured PoolManager', () => {
    expect(() => checkStateViewBinding(poolManager, poolManager)).not.toThrow();
  });

  it('is checksum/case-insensitive', () => {
    const upperCase = (poolManager.toUpperCase().replace('0X', '0x')) as Address;
    expect(() => checkStateViewBinding(upperCase, poolManager)).not.toThrow();
  });

  it('throws with a clear, actionable message on a mismatch', () => {
    const wrongPoolManager: Address = '0x0000000000000000000000000000000000000001';
    expect(() => checkStateViewBinding(wrongPoolManager, poolManager)).toThrow(/UNISWAP_V4_STATE_VIEW_ADDRESS/);
  });
});

describe('tick bitmap math', () => {
  it('compresses a positive tick that is an exact multiple of spacing', () => {
    expect(compress(120, 60)).toBe(2);
  });

  it('compresses a negative tick that is an exact multiple of spacing', () => {
    expect(compress(-120, 60)).toBe(-2);
  });

  it('floors toward negative infinity for non-exact negative ticks (matches Solidity tick compression)', () => {
    expect(compress(-1, 60)).toBe(-1);
    expect(compress(-59, 60)).toBe(-1);
    expect(compress(-61, 60)).toBe(-2);
  });

  it('computes word position for a compressed tick', () => {
    expect(wordPosition(0)).toBe(0);
    expect(wordPosition(256)).toBe(1);
    expect(wordPosition(-1)).toBe(-1);
    expect(wordPosition(-257)).toBe(-2);
  });

  it('computes a non-negative bit position even for negative compressed ticks', () => {
    expect(bitPosition(0)).toBe(0);
    expect(bitPosition(255)).toBe(255);
    expect(bitPosition(256)).toBe(0);
    expect(bitPosition(-1)).toBe(255);
  });

  it('extracts every set bit from a bitmap word as compressed tick indices', () => {
    const bitmap = (1n << 0n) | (1n << 5n) | (1n << 255n);
    expect(setBitsToCompressedTicks(0, bitmap)).toEqual([0, 5, 255]);
  });

  it('offsets extracted ticks by the word index', () => {
    const bitmap = 1n << 3n;
    expect(setBitsToCompressedTicks(2, bitmap)).toEqual([2 * 256 + 3]);
  });

  it('returns an empty array for an all-zero bitmap', () => {
    expect(setBitsToCompressedTicks(0, 0n)).toEqual([]);
  });
});

describe('tickWindowForWords -- the range the tick list is provably complete for', () => {
  it('covers exactly the scanned words, inclusive of both edge bits', () => {
    // One word either side of word 0, tickSpacing 1: compressed ticks
    // -256 .. 511, i.e. the first bit of the lowest word through the last
    // bit of the highest.
    expect(tickWindowForWords(0, 1, 1)).toEqual({ lowerTick: -256, upperTick: 511 });
  });

  it('scales with tick spacing', () => {
    expect(tickWindowForWords(0, 1, 60)).toEqual({ lowerTick: -256 * 60, upperTick: 511 * 60 });
  });

  it('follows the centre word', () => {
    expect(tickWindowForWords(3, 0, 1)).toEqual({ lowerTick: 3 * BITS_PER_WORD, upperTick: 3 * BITS_PER_WORD + 255 });
  });

  it('handles negative centre words without an off-by-one', () => {
    expect(tickWindowForWords(-1, 0, 1)).toEqual({ lowerTick: -256, upperTick: -1 });
  });

  it('always produces a non-empty, correctly ordered window', () => {
    for (const centre of [-5, -1, 0, 1, 7]) {
      for (const range of [0, 1, 10]) {
        const w = tickWindowForWords(centre, range, 60);
        expect(w.lowerTick).toBeLessThan(w.upperTick);
      }
    }
  });
});
