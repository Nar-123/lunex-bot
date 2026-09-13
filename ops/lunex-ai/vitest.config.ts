import { defineConfig } from 'vitest/config';

// Separate from the Lunex bot's root vitest.config.ts on purpose: the
// supervisor is a development tool, not part of the trading runtime, and
// its tests must never load Lunex's tests/setup.ts env fixtures.
export default defineConfig({
  test: {
    environment: 'node',
    root: __dirname,
    include: ['tests/**/*.test.ts'],
  },
});
