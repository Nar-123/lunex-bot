import { afterEach, describe, expect, it, vi } from 'vitest';

/**
 * Wiring test for the two clients themselves: the failover transport is useless
 * if the client every read goes through is still built from a single endpoint.
 *
 * Config is MOCKED rather than driven through `process.env`: the real config is
 * read once at import time, so an env-based version depends on module-import
 * order across the whole suite (it passed alone and flaked in a full run).
 * `vi.doMock` + `vi.resetModules` makes the endpoint list an explicit input.
 * No network and no live RPC.
 */
const PRIMARY = 'https://primary.rpc.invalid';
const FB1 = 'https://fallback-one.rpc.invalid';
const FB2 = 'https://fallback-two.rpc.invalid';
const TEST_KEY = `0x${'11'.repeat(32)}` as const;

interface TransportShape {
  type?: string;
  transports?: { value?: { url?: string } }[];
}

/** Loads the clients fresh against a mocked config with the given endpoints. */
async function loadClients(rpcUrl: string, rpcFallbackUrls: string[]) {
  vi.resetModules();
  vi.doMock('../../src/config', () => ({
    config: {
      chain: { chainId: 4663, rpcUrl, rpcFallbackUrls },
      executorPrivateKey: TEST_KEY,
    },
  }));
  const [{ getPublicClient }, { getWalletClient }] = await Promise.all([
    import('../../src/blockchain/viemClient'),
    import('../../src/blockchain/walletClient'),
  ]);
  return { getPublicClient, getWalletClient };
}

afterEach(() => {
  vi.doUnmock('../../src/config');
  vi.resetModules();
});

describe('client transport wiring', () => {
  it('the public client composes the PRIMARY plus every configured fallback, in order', async () => {
    const { getPublicClient } = await loadClients(PRIMARY, [FB1, FB2]);

    const transport = getPublicClient().transport as TransportShape;

    expect(transport.type).toBe('fallback');
    expect(transport.transports).toHaveLength(3);
    expect(transport.transports?.map((t) => t.value?.url)).toEqual([PRIMARY, FB1, FB2]);
  });

  it('with no fallbacks configured it still works, using the primary alone', async () => {
    const { getPublicClient } = await loadClients(PRIMARY, []);

    const transport = getPublicClient().transport as TransportShape;

    expect(transport.type).toBe('fallback');
    expect(transport.transports).toHaveLength(1);
    expect(transport.transports?.[0]?.value?.url).toBe(PRIMARY);
  });

  it('duplicate and malformed configured fallbacks are filtered before the client is built', async () => {
    const { getPublicClient } = await loadClients(PRIMARY, [FB1, PRIMARY, 'not-a-url', '', FB1]);

    const transport = getPublicClient().transport as TransportShape;

    expect(transport.transports?.map((t) => t.value?.url)).toEqual([PRIMARY, FB1]);
  });

  it('the wallet client (local signing only) uses the same endpoint policy -- no bypass path', async () => {
    const { getWalletClient } = await loadClients(PRIMARY, [FB1, FB2]);

    const transport = getWalletClient().transport as TransportShape;

    expect(transport.type).toBe('fallback');
    expect(transport.transports?.map((t) => t.value?.url)).toEqual([PRIMARY, FB1, FB2]);
  });
});
