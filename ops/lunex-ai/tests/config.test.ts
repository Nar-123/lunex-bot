import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { ConfigError, DEFAULT_MODEL, DEFAULT_TOKENROUTER_BASE_URL, loadConfig, parseAdminIds } from '../src/config';

const TOKEN = '123456789:AAconfigSECRETconfigSECRETconfigSECRET';
const KEY = 'trk-config-SECRET-0123456789abcdef';

const base = (extra: Record<string, string> = {}): NodeJS.ProcessEnv => ({
  TELEGRAM_BOT_TOKEN: TOKEN,
  TELEGRAM_ADMIN_ID: '111',
  TOKENROUTER_API_KEY: KEY,
  ...extra,
});

function configError(env: NodeJS.ProcessEnv): ConfigError {
  try {
    loadConfig(env);
  } catch (err) {
    if (err instanceof ConfigError) return err;
    throw err;
  }
  throw new Error('expected a ConfigError');
}

describe('loadConfig', () => {
  it('applies documented defaults', () => {
    const config = loadConfig(base());
    expect(config).toMatchObject({
      telegramAdminIds: [111],
      tokenRouterBaseUrl: DEFAULT_TOKENROUTER_BASE_URL,
      model: DEFAULT_MODEL,
      workspaceDir: path.resolve('/opt/lunex/workspace/lunex'),
      aiHomeDir: path.resolve('/opt/lunex/ai'),
      integrationBranch: 'ai/develop',
      autonomousIdle: true,
      replyToUnauthorized: false,
    });
    expect(config.stateDir).toBe(path.join(path.resolve('/opt/lunex/workspace/lunex'), '.ai', 'state'));
    expect(config.deniedRoots).toEqual(expect.arrayContaining(['/opt/lunex/production', '/opt/lunex/trading', '/opt/finance-bot', '/opt/guardian', '/root'].map((p) => path.resolve(p))));
  });

  it.each(['TELEGRAM_BOT_TOKEN', 'TELEGRAM_ADMIN_ID', 'TOKENROUTER_API_KEY'])('requires %s', (name) => {
    const env = base();
    delete env[name];
    expect(configError(env).message).toBe(`${name} is required but not set`);
  });

  it.each([
    ['workspace inside production', { LUNEX_AI_WORKSPACE: '/opt/lunex/production/lunex' }],
    ['workspace inside trading', { LUNEX_AI_WORKSPACE: '/opt/lunex/trading' }],
    ['workspace containing production', { LUNEX_AI_WORKSPACE: '/opt/lunex' }],
    ['AI home inside /root', { LUNEX_AI_HOME: '/root/ai' }],
    ['workspace inside an extra denied path', { LUNEX_AI_WORKSPACE: '/opt/other-bots/lunex', LUNEX_AI_EXTRA_DENIED_PATHS: '/opt/other-bots' }],
  ])('refuses to start with %s', (_label, extra) => {
    expect(configError(base(extra)).message).toMatch(/overlaps a denied path/);
  });

  it('requires an https TokenRouter base URL and strips a trailing slash', () => {
    expect(configError(base({ TOKENROUTER_BASE_URL: 'http://api.tokenrouter.io/v1' })).message).toMatch(/https/);
    expect(loadConfig(base({ TOKENROUTER_BASE_URL: 'https://api.tokenrouter.io/v1/' })).tokenRouterBaseUrl).toBe('https://api.tokenrouter.io/v1');
  });

  it('reads the base URL from LUNEX_AI_BASE_URL or TOKENROUTER_BASE_URL, and refuses two different values', () => {
    expect(loadConfig(base({ LUNEX_AI_BASE_URL: 'https://api.tokenrouter.com/v1' })).tokenRouterBaseUrl).toBe('https://api.tokenrouter.com/v1');
    expect(loadConfig(base({ TOKENROUTER_BASE_URL: 'https://gateway.example/v1' })).tokenRouterBaseUrl).toBe('https://gateway.example/v1');
    expect(loadConfig(base({ LUNEX_AI_BASE_URL: 'https://a.example/v1', TOKENROUTER_BASE_URL: 'https://a.example/v1/' })).tokenRouterBaseUrl).toBe('https://a.example/v1');
    expect(configError(base({ LUNEX_AI_BASE_URL: 'https://a.example/v1', TOKENROUTER_BASE_URL: 'https://b.example/v1' })).message).toMatch(/both set and differ/);
    expect(configError(base({ LUNEX_AI_BASE_URL: 'http://a.example/v1' })).message).toMatch(/https/);
  });

  it.each(['/opt/finance-bot', '/opt/guardian'])('always denies %s, even when not listed in the environment', (denied) => {
    expect(configError(base({ LUNEX_AI_WORKSPACE: `${denied}/lunex` })).message).toMatch(/overlaps a denied path/);
  });

  it('validates numeric and boolean tuning variables', () => {
    expect(configError(base({ LUNEX_AI_MAX_AGENT_STEPS: '0' })).message).toMatch(/LUNEX_AI_MAX_AGENT_STEPS/);
    expect(configError(base({ LUNEX_AI_AUTONOMOUS_IDLE: 'yes' })).message).toMatch(/LUNEX_AI_AUTONOMOUS_IDLE/);
    expect(loadConfig(base({ LUNEX_AI_AUTONOMOUS_IDLE: 'false', LUNEX_AI_MAX_AGENT_STEPS: '25' }))).toMatchObject({ autonomousIdle: false, maxAgentSteps: 25 });
  });

  it('never includes a secret value in any configuration error', () => {
    const failures = [
      base({ TELEGRAM_ADMIN_ID: `@${TOKEN}` }),
      base({ TOKENROUTER_BASE_URL: `http://${KEY}.example` }),
      base({ LUNEX_AI_WORKSPACE: '/opt/lunex/production' }),
      { TELEGRAM_BOT_TOKEN: TOKEN },
    ];
    for (const env of failures) {
      const message = configError(env).message;
      expect(message).not.toContain(TOKEN);
      expect(message).not.toContain(KEY);
    }
  });
});

describe('parseAdminIds', () => {
  it('accepts one or more numeric ids', () => {
    expect(parseAdminIds('111')).toEqual([111]);
    expect(parseAdminIds(' 111, 222 ,333')).toEqual([111, 222, 333]);
  });

  it.each(['', ',', '@lunex_admin', '111,abc', '12.5', '-5'])('rejects %j', (raw) => {
    expect(() => parseAdminIds(raw)).toThrow(ConfigError);
  });
});
