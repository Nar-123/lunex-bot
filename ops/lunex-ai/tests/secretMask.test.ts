import { describe, expect, it } from 'vitest';
import { collectSecretValues, createMasker, MASK } from '../src/secretMask';

const TG_TOKEN = '8123456789:AAHfakeFAKEfakeFAKEfakeFAKEfake_1234';
const ROUTER_KEY = 'tr-live-9f8e7d6c5b4a39281706f5e4d3c2b1a0';

describe('collectSecretValues', () => {
  it('collects values of secret-named variables only, skipping short values', () => {
    const values = collectSecretValues({
      TELEGRAM_BOT_TOKEN: TG_TOKEN,
      TOKENROUTER_API_KEY: ROUTER_KEY,
      LUNEX_AI_MODEL: 'z-ai/glm-5.3-free',
      JWT_SECRET: 'short',
      PATH: '/usr/bin:/bin',
    });
    expect(values).toEqual([TG_TOKEN, ROUTER_KEY]);
  });
});

describe('createMasker', () => {
  const mask = createMasker([TG_TOKEN, ROUTER_KEY]);

  it('masks exact known secret values wherever they appear', () => {
    const out = mask(`url=https://api.telegram.org/bot${TG_TOKEN}/getUpdates key ${ROUTER_KEY}`);
    expect(out).not.toContain(TG_TOKEN);
    expect(out).not.toContain(ROUTER_KEY);
  });

  it.each([
    ['telegram token shape', '999999999:AAbbccddeeffgghhiijjkkllmmnnooppqqrr'],
    ['bearer token', 'Authorization: Bearer abcdefghijklmnop.qrstuvwxyz'],
    ['sk- key', 'sk-abcdefghijklmnopqrstuvwxyz123456'],
    ['github token', `ghp_${'a'.repeat(36)}`],
    ['bcrypt hash', `$2b$12$${'a'.repeat(53)}`],
    ['PEM private key', '-----BEGIN PRIVATE KEY-----\nMIIEvQIBADANBg\n-----END PRIVATE KEY-----'],
    ['private key assignment', `PRIVATE_KEY=0x${'ab'.repeat(32)}`],
    ['privateKey object field', `privateKey: '0x${'cd'.repeat(32)}'`],
    ['env-style secret assignment', 'UNISWAP_API_KEY=live-key-123456789'],
  ])('masks secrets it has never seen: %s', (_label, secret) => {
    const out = mask(`before ${secret} after`);
    expect(out).toContain(MASK);
    expect(out).not.toContain(secret);
  });

  it('keeps transaction hashes and pool ids readable (no key context)', () => {
    const txHash = `0x${'de'.repeat(32)}`;
    const line = `+ const TX_HASH = '${txHash}'; poolId: '0x${'aa'.repeat(32)}'`;
    expect(mask(line)).toBe(line);
  });

  it('is stable when applied twice', () => {
    const once = mask(`TOKENROUTER_API_KEY=${ROUTER_KEY}`);
    expect(mask(once)).toBe(once);
  });
});
