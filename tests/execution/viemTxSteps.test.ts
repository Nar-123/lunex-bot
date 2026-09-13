import { describe, expect, it, vi } from 'vitest';
import { isDefinitiveSimulationRevert } from '../../src/execution/viemTxSteps';

describe('isDefinitiveSimulationRevert -- H2: conservative classification, default is TRANSIENT/resumable', () => {
  it.each([
    'execution reverted',
    'VM Exception while processing transaction: reverted with reason string \'INSUFFICIENT_LIQUIDITY\'',
    'reverted with custom error \'Unauthorized()\'',
    'CALL_EXCEPTION: execution reverted',
  ])('classifies a genuine on-chain revert message as DEFINITIVE: %s', (message) => {
    expect(isDefinitiveSimulationRevert(message)).toBe(true);
  });

  it.each([
    'RPC timeout',
    'HTTP 429: Too Many Requests',
    'HTTP 500: Internal Server Error',
    'HTTP 502: Bad Gateway',
    'ECONNRESET',
    'ECONNREFUSED',
    'connection reset by peer',
    'network error',
    'provider unavailable',
    'fetch failed',
    'socket hang up',
    'something the classifier has genuinely never seen before',
  ])('classifies a transient/unrecognized message as NOT definitive (resumable): %s', (message) => {
    expect(isDefinitiveSimulationRevert(message)).toBe(false);
  });
});

describe('simulateTx -- H2: transient/RPC errors are rethrown (resumable), genuine reverts return ok:false (definitive)', () => {
  async function simulateWithClientError(errorMessage: string) {
    vi.resetModules();
    vi.doMock('../../src/blockchain/viemClient', () => ({
      getPublicClient: () => ({
        call: vi.fn(async () => {
          throw new Error(errorMessage);
        }),
      }),
    }));
    const { simulateTx } = await import('../../src/execution/viemTxSteps');
    const tx = { to: '0x1111111111111111111111111111111111111111' as const, data: '0xabcdef' as const, value: 0n };
    return simulateTx(tx);
  }

  it('a genuine revert returns ok:false (definitive), never thrown', async () => {
    const result = await simulateWithClientError('execution reverted: INSUFFICIENT_LIQUIDITY');
    expect(result).toEqual({ ok: false, reason: 'execution reverted: INSUFFICIENT_LIQUIDITY' });
  });

  it.each(['RPC timeout', 'HTTP 429', 'HTTP 500', 'ECONNRESET', 'provider unavailable'])(
    'a transient RPC error (%s) is RETHROWN, never returned as ok:false -- executeCriticalTransaction must treat it as resumable',
    async (errorMessage) => {
      await expect(simulateWithClientError(errorMessage)).rejects.toThrow(errorMessage);
    },
  );
});
