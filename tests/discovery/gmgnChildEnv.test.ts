import { describe, expect, it, vi } from 'vitest';
import { GMGN_CHILD_ENV_PASSTHROUGH, buildGmgnChildEnv } from '../../src/discovery/childEnv';
import { GmgnCliClient } from '../../src/discovery/gmgnCliClient';
import type { RunGmgnCliOptions } from '../../src/discovery/cliExec';

/**
 * `gmgn-cli` is third-party npm code spawned on every discovery cycle. It
 * previously inherited `{ ...process.env }`, i.e. the executor's PRIVATE_KEY
 * and every other service secret. These tests pin the allowlist from both
 * ends: the secrets must be absent, and the one secret the CLI genuinely
 * needs must still arrive.
 */

/** Every secret this service actually holds, as named in `.env`/`src/config/env.ts`. */
const LUNEX_SECRETS = {
  PRIVATE_KEY: `0x${'ab'.repeat(32)}`,
  JWT_SECRET: 'jwt-secret-value',
  AUTH_ADMIN_PASSWORD: 'admin-password',
  AUTH_ADMIN_PASSWORD_HASH: `$2b$12$${'a'.repeat(53)}`,
  TELEGRAM_BOT_TOKEN: '999999999:AAbbccddeeffgghh',
  UNISWAP_API_KEY: 'uniswap-api-key',
  DATABASE_URL: 'file:/opt/lunex/production/lunex-bot/prisma/production.db',
  RPC_URL: 'https://provider.example/v2/provider-api-key',
  RPC_FALLBACK_URLS: 'https://fallback.example/v2/another-key',
  AI_TELEGRAM_BOT_TOKEN: '111111111:CCddeeff',
  AI_TOKEN_ROUTER_KEY: 'token-router-key',
  LUNEX_AI_API_TOKEN: 'ai-api-token',
} as const;

const PARENT = {
  ...LUNEX_SECRETS,
  PATH: '/usr/local/bin:/usr/bin:/bin',
  HOME: '/home/lunex-bot',
  LANG: 'en_US.UTF-8',
  TZ: 'UTC',
  TMPDIR: '/tmp',
  NODE_ENV: 'production',
} as NodeJS.ProcessEnv;

describe('buildGmgnChildEnv -- deny by default', () => {
  it('passes NO Lunex secret to the child', () => {
    const env = buildGmgnChildEnv(PARENT, 'gmgn-key');

    for (const name of Object.keys(LUNEX_SECRETS)) {
      expect(env, `${name} must not reach the child`).not.toHaveProperty(name);
    }
    // Also assert by VALUE, so a secret smuggled in under a different key name
    // (or an accidental `{ ...parent }` regression) still fails.
    const values = Object.values(env).filter((v): v is string => typeof v === 'string');
    for (const [name, secret] of Object.entries(LUNEX_SECRETS)) {
      expect(values, `${name}'s value must not appear anywhere in the child env`).not.toContain(secret);
    }
  });

  it('still passes GMGN_API_KEY -- the one secret the CLI needs', () => {
    expect(buildGmgnChildEnv(PARENT, 'gmgn-key').GMGN_API_KEY).toBe('gmgn-key');
  });

  it('omits GMGN_API_KEY entirely when none is configured, rather than setting it empty', () => {
    const env = buildGmgnChildEnv(PARENT, '');

    expect(env).not.toHaveProperty('GMGN_API_KEY');
    expect(buildGmgnChildEnv(PARENT)).not.toHaveProperty('GMGN_API_KEY');
  });

  it('preserves the runtime variables the CLI needs to run at all', () => {
    const env = buildGmgnChildEnv(PARENT, 'k');

    expect(env.PATH).toBe(PARENT.PATH);
    expect(env.HOME).toBe(PARENT.HOME);
    expect(env.LANG).toBe(PARENT.LANG);
    expect(env.TZ).toBe(PARENT.TZ);
    expect(env.TMPDIR).toBe(PARENT.TMPDIR);
    expect(env.NODE_ENV).toBe('production');
  });

  it('omits allowlisted variables that are not set in the parent (never undefined-valued keys)', () => {
    const env = buildGmgnChildEnv({ PATH: '/bin' }, 'k');

    expect(Object.keys(env).sort()).toEqual(['GMGN_API_KEY', 'PATH']);
  });

  it('the child env contains ONLY allowlisted names plus GMGN_API_KEY', () => {
    const allowed = new Set<string>([...GMGN_CHILD_ENV_PASSTHROUGH, 'GMGN_API_KEY']);

    for (const key of Object.keys(buildGmgnChildEnv(PARENT, 'k'))) {
      expect(allowed.has(key), `${key} is not allowlisted`).toBe(true);
    }
  });

  it('does not forward proxy variables, which can embed credentials', () => {
    const env = buildGmgnChildEnv({ ...PARENT, HTTPS_PROXY: 'http://user:pass@proxy:8080' }, 'k');

    expect(env).not.toHaveProperty('HTTPS_PROXY');
  });

  it('cannot be widened by adding a new secret to the parent environment', () => {
    // The regression guard proper: a future `.env` variable must not leak just
    // because it exists -- the allowlist has to be edited deliberately.
    const env = buildGmgnChildEnv({ ...PARENT, SOME_FUTURE_SECRET: 'sensitive' }, 'k');

    expect(env).not.toHaveProperty('SOME_FUTURE_SECRET');
  });
});

describe('GmgnCliClient -- what the spawned process actually receives', () => {
  it('passes the allowlisted env (not process.env) to every CLI invocation', async () => {
    // Put a recognizable secret in the REAL process env: the client reads
    // `process.env` itself, so this proves the wiring, not just the helper.
    vi.stubEnv('PRIVATE_KEY', `0x${'cd'.repeat(32)}`);
    vi.stubEnv('JWT_SECRET', 'real-process-jwt-secret');
    const seen: NodeJS.ProcessEnv[] = [];
    const runCli = vi.fn(async (_path: string, args: readonly string[], options: RunGmgnCliOptions) => {
      seen.push(options.env ?? {});
      // `market trending` first, then one `token info` per candidate --
      // envelope shapes as captured from real gmgn-cli 1.6.2 (see
      // `gmgnCliClient.test.ts`'s fixture).
      if (args[0] === 'market') {
        return {
          code: 0,
          message: 'success',
          reason: '',
          data: {
            rank: [
              {
                address: `0x${'0'.repeat(40)}`,
                symbol: 'AAA',
                name: 'AAA Token',
                chain: 'robinhood',
                market_cap: 2_000_000,
                volume: 100_000,
                gas_fee: 1,
                top_10_holder_rate: 0.1,
                rank: 1,
              },
            ],
          },
        };
      }
      return { address: `0x${'0'.repeat(40)}`, creation_timestamp: 1_700_000_000 };
    });

    const client = new GmgnCliClient(
      'gmgn-cli',
      'the-gmgn-key',
      { timeoutMs: 1_000, maxRetries: 0, retryBaseDelayMs: 1 },
      runCli as never,
      () => undefined,
    );
    await client.getTopTokens({ interval: '24h', limit: 5 });

    expect(seen.length).toBeGreaterThan(0);
    for (const env of seen) {
      expect(env).not.toHaveProperty('PRIVATE_KEY');
      expect(env).not.toHaveProperty('JWT_SECRET');
      expect(Object.values(env)).not.toContain('real-process-jwt-secret');
      expect(env.GMGN_API_KEY).toBe('the-gmgn-key');
    }
    vi.unstubAllEnvs();
  });
});
