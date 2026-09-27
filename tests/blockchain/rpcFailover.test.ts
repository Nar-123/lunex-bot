import http from 'node:http';
import type { AddressInfo } from 'node:net';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { createPublicClient, getAddress, type Address } from 'viem';
import { buildRpcTransport, resolveRpcEndpoints, RPC_PASS_RETRIES, RPC_REQUEST_TIMEOUT_MS } from '../../src/blockchain/rpcTransport';
import { verifyExecutionTargets } from '../../src/swap/verifyExecutionTargets';
import { SWAP_PROXY_EXECUTE_SELECTOR } from '../../src/swap/executionTargets';

/**
 * RPC failover. The primary provider returned `429 Monthly capacity limit
 * exceeded` on 2026-09-26 while two healthy endpoints were configured, and every
 * chain read failed because the client used a single `http()` transport.
 *
 * These tests run REAL viem transports against REAL local HTTP servers, so they
 * exercise viem's own error classification (which failures move to the next
 * endpoint and which do not) rather than a mock of it. No live RPC is used.
 */
const CHAIN_ID_HEX = '0x1237'; // 4663
const ROUTER = getAddress('0x8876789976dEcBfCbBbe364623C63652db8C0904');
const PROXY = getAddress('0x0000000085E102724e78eCd2F45DC9cA239Affad');
const POOL_MANAGER = getAddress('0x1111111111111111111111111111111111111111');
const WALLET = getAddress('0x65299018ABAaa6bD89aabF689dbEf21Be99ef1Ea');

type Behaviour =
  | { kind: 'healthy' }
  | { kind: 'status'; status: number; body?: string }
  | { kind: 'hang' }
  | { kind: 'socket-close' };

interface FakeNode {
  url: string;
  hits: () => number;
  methods: () => string[];
  close: () => Promise<void>;
}

const servers: FakeNode[] = [];

/** A minimal JSON-RPC endpoint whose failure mode is configurable. */
async function startNode(behaviour: Behaviour = { kind: 'healthy' }): Promise<FakeNode> {
  let hits = 0;
  const methods: string[] = [];
  const server = http.createServer((req, res) => {
    hits += 1;
    let raw = '';
    req.on('data', (c) => { raw += String(c); });
    req.on('end', () => {
      if (behaviour.kind === 'hang') return; // never responds -> the transport times out
      if (behaviour.kind === 'socket-close') { req.socket.destroy(); return; }
      if (behaviour.kind === 'status') {
        res.writeHead(behaviour.status, { 'content-type': 'application/json' });
        res.end(behaviour.body ?? JSON.stringify({ jsonrpc: '2.0', id: 1, error: { code: behaviour.status, message: 'provider unavailable' } }));
        return;
      }
      let body: unknown;
      try { body = JSON.parse(raw); } catch { body = {}; }
      const calls = Array.isArray(body) ? body : [body];
      const answer = (call: { id?: number; method?: string; params?: unknown[] }): unknown => {
        const method = String(call.method);
        methods.push(method);
        const result = ((): unknown => {
          switch (method) {
            case 'eth_chainId': return CHAIN_ID_HEX;
            case 'eth_blockNumber': return '0x10';
            case 'eth_getBalance': return '0x2386f26fc10000';
            case 'eth_getTransactionCount': return '0x64';
            // includes the SwapProxy execute() selector so the real verifier's
            // bytecode check is satisfied by this fake node
            case 'eth_getCode': return `0x60016000f3${SWAP_PROXY_EXECUTE_SELECTOR.slice(2)}`;
            case 'eth_call': return '0x' + POOL_MANAGER.slice(2).toLowerCase().padStart(64, '0');
            case 'eth_getTransactionReceipt': return { transactionHash: `0x${'ab'.repeat(32)}`, status: '0x1', blockNumber: '0x10', blockHash: `0x${'cd'.repeat(32)}`, transactionIndex: '0x0', from: WALLET, to: ROUTER, cumulativeGasUsed: '0x1', gasUsed: '0x1', contractAddress: null, logs: [], logsBloom: `0x${'00'.repeat(256)}`, effectiveGasPrice: '0x1', type: '0x2' };
            case 'eth_getBlockByNumber': return { number: '0x10', hash: `0x${'11'.repeat(32)}`, parentHash: `0x${'22'.repeat(32)}`, timestamp: '0x66000000', gasLimit: '0x1c9c380', gasUsed: '0x0', miner: WALLET, extraData: '0x', baseFeePerGas: '0x1', difficulty: '0x0', totalDifficulty: '0x0', size: '0x0', transactions: [], uncles: [], nonce: '0x0000000000000000', sha3Uncles: `0x${'33'.repeat(32)}`, logsBloom: `0x${'00'.repeat(256)}`, transactionsRoot: `0x${'44'.repeat(32)}`, stateRoot: `0x${'55'.repeat(32)}`, receiptsRoot: `0x${'66'.repeat(32)}`, mixHash: `0x${'77'.repeat(32)}` };
            default: return '0x';
          }
        })();
        return { jsonrpc: '2.0', id: call.id ?? 1, result };
      };
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify(Array.isArray(body) ? calls.map(answer) : answer(calls[0] as never)));
    });
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const { port } = server.address() as AddressInfo;
  const node: FakeNode = {
    url: `http://127.0.0.1:${port}`,
    hits: () => hits,
    methods: () => [...methods],
    close: () => new Promise<void>((resolve) => { server.closeAllConnections?.(); server.close(() => resolve()); }),
  };
  servers.push(node);
  return node;
}

afterEach(async () => {
  await Promise.all(servers.splice(0).map((s) => s.close()));
});

/** A client over the given endpoints, with a short timeout so "hang" tests stay fast. */
const clientOver = (urls: string[], timeoutMs = 300) =>
  createPublicClient({ transport: buildRpcTransport(urls, { timeoutMs }) });

describe('resolveRpcEndpoints -- ordering, dedupe and validation', () => {
  it('keeps the primary first and the fallbacks in configured order', () => {
    const r = resolveRpcEndpoints('https://primary.example', ['https://fb1.example', 'https://fb2.example']);
    expect(r.urls).toEqual(['https://primary.example', 'https://fb1.example', 'https://fb2.example']);
    expect(r.dropped).toEqual([]);
  });

  it('an empty fallback list is fine -- the primary alone is used', () => {
    expect(resolveRpcEndpoints('https://primary.example').urls).toEqual(['https://primary.example']);
    expect(resolveRpcEndpoints('https://primary.example', []).urls).toEqual(['https://primary.example']);
  });

  it('drops duplicates (including one equal to the primary) without reordering', () => {
    const r = resolveRpcEndpoints('https://primary.example', ['https://fb1.example', 'https://primary.example', 'https://fb1.example']);
    expect(r.urls).toEqual(['https://primary.example', 'https://fb1.example']);
    expect(r.dropped).toEqual([{ index: 1, reason: 'duplicate' }, { index: 2, reason: 'duplicate' }]);
  });

  it('skips empty and malformed fallback entries, reporting index + reason only (never the URL)', () => {
    const r = resolveRpcEndpoints('https://primary.example', ['', '   ', 'not-a-url', 'ws://nope.example', 'https://ok.example']);
    expect(r.urls).toEqual(['https://primary.example', 'https://ok.example']);
    expect(r.dropped).toEqual([
      { index: 0, reason: 'empty' },
      { index: 1, reason: 'empty' },
      { index: 2, reason: 'malformed' },
      { index: 3, reason: 'malformed' },
    ]);
    expect(JSON.stringify(r.dropped)).not.toContain('example');
  });

  it('a missing or malformed PRIMARY fails closed -- a fallback is never silently promoted', () => {
    for (const bad of ['', '   ', 'not-a-url', 'ws://x.example']) {
      expect(() => resolveRpcEndpoints(bad, ['https://healthy.example'])).toThrow(/RPC_URL is missing or not an http\(s\) URL/);
    }
  });

  it('trims surrounding whitespace on usable entries', () => {
    expect(resolveRpcEndpoints('  https://primary.example  ', [' https://fb.example ']).urls).toEqual(['https://primary.example', 'https://fb.example']);
  });
});

describe('failover semantics (real viem transports, real local HTTP)', () => {
  it('A. primary healthy -> only the primary is used', async () => {
    const primary = await startNode();
    const fb = await startNode();
    const client = clientOver([primary.url, fb.url]);

    expect(await client.getChainId()).toBe(4663);

    expect(primary.hits()).toBe(1);
    expect(fb.hits()).toBe(0);
  });

  it('B. primary 429 -> fallback #1 serves the request', async () => {
    const primary = await startNode({ kind: 'status', status: 429, body: JSON.stringify({ jsonrpc: '2.0', id: 1, error: { code: 429, message: 'Monthly capacity limit exceeded' } }) });
    const fb = await startNode();
    const client = clientOver([primary.url, fb.url]);

    expect(await client.getChainId()).toBe(4663);

    expect(primary.hits()).toBeGreaterThanOrEqual(1);
    expect(fb.hits()).toBe(1);
  });

  it('C. primary 500 -> fallback #1 serves the request', async () => {
    const primary = await startNode({ kind: 'status', status: 500 });
    const fb = await startNode();
    expect(await clientOver([primary.url, fb.url]).getChainId()).toBe(4663);
    expect(fb.hits()).toBe(1);
  });

  it('D. primary hangs (timeout) -> fallback #1 serves the request', async () => {
    const primary = await startNode({ kind: 'hang' });
    const fb = await startNode();
    expect(await clientOver([primary.url, fb.url], 150).getChainId()).toBe(4663);
    expect(fb.hits()).toBe(1);
  });

  it('E. primary drops the socket (network error) -> fallback #1 serves the request', async () => {
    const primary = await startNode({ kind: 'socket-close' });
    const fb = await startNode();
    expect(await clientOver([primary.url, fb.url]).getChainId()).toBe(4663);
    expect(fb.hits()).toBe(1);
  });

  it('F. primary and fallback #1 both fail -> fallback #2 serves the request, in order', async () => {
    const primary = await startNode({ kind: 'status', status: 429 });
    const fb1 = await startNode({ kind: 'status', status: 503 });
    const fb2 = await startNode();
    expect(await clientOver([primary.url, fb1.url, fb2.url]).getChainId()).toBe(4663);
    expect(fb2.hits()).toBe(1);
    // order respected: both earlier endpoints were tried before fb2
    expect(primary.hits()).toBeGreaterThanOrEqual(1);
    expect(fb1.hits()).toBeGreaterThanOrEqual(1);
  });

  it('G. every endpoint fails -> the read FAILS, with no fabricated result', async () => {
    const a = await startNode({ kind: 'status', status: 429 });
    const b = await startNode({ kind: 'status', status: 502 });
    const client = clientOver([a.url, b.url]);

    await expect(client.getChainId()).rejects.toThrow();

    // both endpoints were attempted, and nothing was invented
    expect(a.hits()).toBeGreaterThanOrEqual(1);
    expect(b.hits()).toBeGreaterThanOrEqual(1);
  });

  it('bounded attempts: at most (passRetries + 1) attempts per endpoint, no retry storm', async () => {
    const a = await startNode({ kind: 'status', status: 429 });
    const b = await startNode({ kind: 'status', status: 429 });
    await expect(clientOver([a.url, b.url]).getChainId()).rejects.toThrow();
    const max = RPC_PASS_RETRIES + 1;
    expect(a.hits()).toBeLessThanOrEqual(max);
    expect(b.hits()).toBeLessThanOrEqual(max);
    expect(RPC_REQUEST_TIMEOUT_MS).toBeLessThanOrEqual(10_000);
  });

  it('a REVERTING eth_call is a real answer -- it is not re-asked on another provider', async () => {
    // viem's fallback rethrows deterministic errors (execution reverted) instead
    // of shopping them around, which is what keeps a refused simulation refused.
    const primary = await startNode({
      kind: 'status',
      status: 200,
      body: JSON.stringify({ jsonrpc: '2.0', id: 1, error: { code: 3, message: 'execution reverted: TRANSFER_FROM_FAILED' } }),
    });
    const fb = await startNode();
    const client = clientOver([primary.url, fb.url]);

    await expect(client.call({ to: ROUTER, data: '0xdeadbeef' })).rejects.toThrow(/reverted/i);

    expect(fb.hits()).toBe(0); // never asked
  });
});

describe('the reads Lunex actually depends on all fail over', () => {
  it('chainId, getCode, getBalance, transactionCount, call, receipt and block reads', async () => {
    const dead = await startNode({ kind: 'status', status: 429 });
    const live = await startNode();
    const client = clientOver([dead.url, live.url]);

    expect(await client.getChainId()).toBe(4663);
    expect(await client.getCode({ address: ROUTER })).toContain('60016000f3');
    expect(await client.getBalance({ address: WALLET })).toBe(10_000_000_000_000_000n);
    expect(await client.getTransactionCount({ address: WALLET })).toBe(100);
    expect((await client.call({ to: ROUTER, data: '0x1234' })).data).toBeDefined();
    expect((await client.getTransactionReceipt({ hash: `0x${'ab'.repeat(32)}` })).status).toBe('success');
    expect((await client.getBlock({ blockNumber: 16n })).number).toBe(16n);

    const served = live.methods();
    for (const m of ['eth_chainId', 'eth_getCode', 'eth_getBalance', 'eth_getTransactionCount', 'eth_call', 'eth_getTransactionReceipt', 'eth_getBlockByNumber']) {
      expect(served, m).toContain(m);
    }
  });
});

describe('execution-target startup verification survives a dead primary', () => {
  it('primary 429 + healthy fallback -> verifyExecutionTargets still passes, with no loss of checks', async () => {
    const dead = await startNode({ kind: 'status', status: 429 });
    const live = await startNode();
    const client = clientOver([dead.url, live.url]);

    // the real verification logic, reading through the failover transport
    const report = await verifyExecutionTargets(
      { chainId: 4663, universalRouters: [ROUTER], swapProxies: [PROXY] },
      {
        getChainId: () => client.getChainId(),
        getCode: (address: Address) => client.getCode({ address }),
        readPoolManager: async () => POOL_MANAGER,
      },
      POOL_MANAGER,
    );

    expect(report.ok).toBe(true);
    expect(report.chainId).toBe(4663);
    expect(report.failures).toEqual([]);
    expect(report.checked).toHaveLength(2); // router + proxy, nothing skipped
    expect(live.methods()).toContain('eth_getCode');
  });
});

describe('buildRpcTransport composition', () => {
  it('refuses to build with no endpoints', () => {
    expect(() => buildRpcTransport([])).toThrow(/no endpoints/);
  });

  it('asks the endpoints in the given order, exactly once each per pass', async () => {
    const order: string[] = [];
    const fake = (url: string) => () => ({
      config: { key: url, name: url, request: async () => { order.push(url); throw new Error('down'); }, type: 'http' as const },
      request: async () => { order.push(url); throw new Error('down'); },
      value: undefined,
    });
    const transport = buildRpcTransport(['a', 'b', 'c'], { transportFactory: fake as never, passRetries: 0 });
    const instance = transport({ chain: undefined });
    await expect(instance.request({ method: 'eth_chainId' })).rejects.toThrow();
    expect(order).toEqual(['a', 'b', 'c']);
  });
});
