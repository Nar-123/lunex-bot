import { describe, expect, it, vi, beforeEach } from 'vitest';
import type { Address } from 'viem';

const readContract = vi.fn();
vi.mock('../../src/blockchain/viemClient', () => ({
  getPublicClient: () => ({ readContract }),
}));

// Imported AFTER the mock is registered (hoisted by vitest regardless of import order, but kept explicit for readability).
import { ownerOfNft } from '../../src/blockchain/erc721';

const CONTRACT = '0x1111111111111111111111111111111111111111' as Address;

describe('ownerOfNft -- P1-8: distinguishes a CONFIRMED nonexistent token from every other kind of failure', () => {
  beforeEach(() => {
    readContract.mockReset();
  });

  it('a confirmed nonexistent token (real ERC721 revert) -> returns null, never throws', async () => {
    readContract.mockRejectedValue(new Error('execution reverted: ERC721: invalid token ID'));
    const owner = await ownerOfNft(CONTRACT, 999n);
    expect(owner).toBeNull();
  });

  it('a revert with a different message shape (still contains "revert") -> returns null', async () => {
    readContract.mockRejectedValue(new Error('ContractFunctionRevertedError: reverted with custom error'));
    const owner = await ownerOfNft(CONTRACT, 1n);
    expect(owner).toBeNull();
  });

  it('an RPC/transport failure (no "revert" in the message) -> THROWS, never returns null', async () => {
    readContract.mockRejectedValue(new Error('fetch failed: ECONNRESET'));
    await expect(ownerOfNft(CONTRACT, 1n)).rejects.toThrow('ECONNRESET');
  });

  it('a request timeout -> THROWS, never returns null', async () => {
    readContract.mockRejectedValue(new Error('The request took too long to respond (timeout)'));
    await expect(ownerOfNft(CONTRACT, 1n)).rejects.toThrow(/timeout/);
  });

  it('a malformed/unexpected error shape (not an Error instance) -> THROWS (re-thrown as-is), never silently returns null', async () => {
    readContract.mockRejectedValue('a plain string rejection, not an Error');
    await expect(ownerOfNft(CONTRACT, 1n)).rejects.toBe('a plain string rejection, not an Error');
  });

  it('a genuine successful read -> returns the real owner address, no classification involved', async () => {
    const REAL_OWNER = '0x2222222222222222222222222222222222222222' as Address;
    readContract.mockResolvedValue(REAL_OWNER);
    const owner = await ownerOfNft(CONTRACT, 1n);
    expect(owner).toBe(REAL_OWNER);
  });
});
