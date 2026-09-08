import { describe, expect, it, vi } from 'vitest';
import { GmgnCliClient } from '../../src/discovery/gmgnCliClient';
import type { RunCliFn } from '../../src/discovery/gmgnCliClient';

function trending(symbols: string[]) {
  return {
    data: symbols.map((symbol) => ({
      address: '0x' + symbol.padStart(40, '0'),
      symbol,
      name: `${symbol} Token`,
      market_cap: 2_000_000,
      volume_usd: 100_000,
      gas_fee: 1,
      top_10_holder_rate: 0.1,
      asset_type: 'meme',
    })),
  };
}

const FAST_OPTS = { timeoutMs: 1000, maxRetries: 0, retryBaseDelayMs: 1 };

describe('GmgnCliClient.getTopTokens', () => {
  it('calls market trending then token info per candidate, merging createdAt', async () => {
    const calls: string[][] = [];
    const runCli: RunCliFn = vi.fn(async (_cliPath, args) => {
      calls.push([...args]);
      if (args[0] === 'market') return trending(['AAA', 'BBB']);
      return { address: args[args.indexOf('--address') + 1], creation_timestamp: 1_700_000_000 };
    });

    const client = new GmgnCliClient('gmgn-cli', '', FAST_OPTS, runCli);
    const tokens = await client.getTopTokens({ timeframe: '6h', limit: 10 });

    expect(tokens).toHaveLength(2);
    expect(tokens[0]?.symbol).toBe('AAA');
    expect(tokens[0]?.createdAt).toBe(1_700_000_000 * 1000);
    expect(calls.filter((c) => c[0] === 'market')).toHaveLength(1);
    expect(calls.filter((c) => c[0] === 'token')).toHaveLength(2);
  });

  it('throws (never returns []) when the trending response schema is invalid', async () => {
    const runCli: RunCliFn = vi.fn(async () => ({ unexpected: 'shape' }));
    const client = new GmgnCliClient('gmgn-cli', '', FAST_OPTS, runCli);
    await expect(client.getTopTokens({ timeframe: '6h', limit: 10 })).rejects.toThrow();
  });

  it('excludes only the candidate whose token-info lookup fails, keeps the rest', async () => {
    const bbbAddress = '0x' + 'BBB'.padStart(40, '0');
    const runCli: RunCliFn = vi.fn(async (_cliPath, args) => {
      if (args[0] === 'market') return trending(['AAA', 'BBB', 'CCC']);
      const address = args[args.indexOf('--address') + 1] as string;
      if (address === bbbAddress) {
        throw new Error('simulated token-info failure');
      }
      return { address, creation_timestamp: 1_700_000_000 };
    });

    const onFailure = vi.fn();
    const client = new GmgnCliClient('gmgn-cli', '', FAST_OPTS, runCli, onFailure);
    const tokens = await client.getTopTokens({ timeframe: '6h', limit: 10 });

    expect(tokens.map((t) => t.symbol)).toEqual(['AAA', 'CCC']);
    expect(onFailure).toHaveBeenCalledTimes(1);
  });

  it('never passes symbol/name as a CLI argument', async () => {
    const runCli: RunCliFn = vi.fn(async (_cliPath, args) => {
      if (args[0] === 'market') {
        return {
          data: [
            {
              address: '0x' + '11'.repeat(20),
              symbol: '--evil-flag',
              name: '<script>alert(1)</script>',
              market_cap: 2_000_000,
              volume_usd: 100_000,
              gas_fee: 1,
              top_10_holder_rate: 0.1,
              asset_type: 'meme',
            },
          ],
        };
      }
      return { address: args[args.indexOf('--address') + 1], creation_timestamp: 1_700_000_000 };
    });

    const client = new GmgnCliClient('gmgn-cli', '', FAST_OPTS, runCli);
    await client.getTopTokens({ timeframe: '6h', limit: 10 });

    for (const call of (runCli as ReturnType<typeof vi.fn>).mock.calls) {
      const args = call[1] as string[];
      expect(args).not.toContain('--evil-flag');
      expect(args.join(' ')).not.toMatch(/<script>/);
    }
  });
});
