import { describe, expect, it } from 'vitest';
import { envSchema } from '../../src/config/env';

/**
 * Regression test for the `z.coerce.boolean()` class of bug (Module 10
 * follow-up audit): `Boolean("false")` is `true` in JavaScript, so a
 * coerced-boolean env field silently flips ON when explicitly set to the
 * STRING "false" -- exactly what `.env.example` did for 4 fields
 * (`API_TRUST_PROXY`, `ETH_GAS_RESERVE_ENABLED`, `EXIT_IMPACT_CHECK_ENABLED`,
 * `EXIT_MIN_RECEIVED_PROTECTION_ENABLED`) before this fix.
 *
 * Deliberately GENERIC, not a hardcoded list of those 4 names: this test
 * parses a minimal valid env object once to discover which fields are
 * boolean-TYPED on the OUTPUT (`typeof value === 'boolean'`), then re-parses
 * that same base object with each discovered field overridden to the
 * strings "false"/"true"/an invalid value, in turn. A future boolean field
 * (e.g. added for `telegram/`/`ui/`) is automatically covered the moment
 * it exists -- nobody needs to remember to update this file.
 */

const BASE_VALID_ENV: Record<string, string> = {
  RPC_URL: 'https://test-rpc.invalid',
  CHAIN_ID: '4663',
  PRIVATE_KEY: '0x' + '11'.repeat(32),
  USDG_TOKEN_ADDRESS: '0x' + '22'.repeat(20),
  DATABASE_URL: 'file:./data/test.db',
  AUTH_ADMIN_USERNAME: 'test-admin',
  AUTH_ADMIN_PASSWORD_HASH: '$2b$12$' + 'a'.repeat(53),
  JWT_SECRET: 'test-jwt-secret-not-for-real-use',
};

function discoverBooleanFields(): string[] {
  const parsed = envSchema.parse(BASE_VALID_ENV);
  return Object.entries(parsed)
    .filter(([, value]) => typeof value === 'boolean')
    .map(([key]) => key);
}

describe('env.ts boolean fields -- generic "false"/"true" string round-trip', () => {
  const booleanFields = discoverBooleanFields();

  it('discovered at least the four fields known to have been affected by the z.coerce.boolean() bug', () => {
    // Not a hardcoded source of truth for the schema (see doc comment above) --
    // just a floor, so this test file itself fails loudly if the schema is
    // ever refactored in a way that stops exposing these as plain booleans.
    expect(booleanFields).toEqual(
      expect.arrayContaining(['API_TRUST_PROXY', 'ETH_GAS_RESERVE_ENABLED', 'EXIT_IMPACT_CHECK_ENABLED', 'EXIT_MIN_RECEIVED_PROTECTION_ENABLED']),
    );
  });

  it.each(booleanFields.length > 0 ? booleanFields : ['<no boolean fields discovered -- see above>'])(
    'the STRING "false" parses to false, and "true" parses to true, for %s',
    (fieldName) => {
      const withFalse = envSchema.parse({ ...BASE_VALID_ENV, [fieldName]: 'false' });
      expect((withFalse as Record<string, unknown>)[fieldName]).toBe(false);

      const withTrue = envSchema.parse({ ...BASE_VALID_ENV, [fieldName]: 'true' });
      expect((withTrue as Record<string, unknown>)[fieldName]).toBe(true);
    },
  );

  it.each(booleanFields.length > 0 ? booleanFields : ['<no boolean fields discovered -- see above>'])(
    'an invalid string (neither "true" nor "false") is REJECTED for %s, not silently coerced -- this is what a bare z.coerce.boolean() regression would fail to catch',
    (fieldName) => {
      const result = envSchema.safeParse({ ...BASE_VALID_ENV, [fieldName]: 'yes' });
      expect(result.success).toBe(false);
    },
  );

  it('sanity: at least one boolean field was actually discovered (this test file is not silently a no-op)', () => {
    expect(booleanFields.length).toBeGreaterThan(0);
  });
});
