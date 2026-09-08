import { describe, expect, it } from 'vitest';
import { tokenIdToSalt } from '../../src/monitoring/positionStateReader';

describe('tokenIdToSalt', () => {
  it('encodes a small tokenId as a left-padded 32-byte hex value', () => {
    expect(tokenIdToSalt('42')).toBe('0x000000000000000000000000000000000000000000000000000000000000002a');
  });

  it('encodes tokenId 0', () => {
    expect(tokenIdToSalt('0')).toBe('0x0000000000000000000000000000000000000000000000000000000000000000');
  });

  it('encodes a large tokenId without truncation', () => {
    const tokenId = '123456789012345678901234567890';
    const salt = tokenIdToSalt(tokenId);
    expect(BigInt(salt)).toBe(BigInt(tokenId));
    expect(salt.length).toBe(2 + 64); // 0x + 32 bytes
  });
});
