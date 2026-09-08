import { defineConfig } from '@playwright/test';

/**
 * Module 12's one new piece of test infrastructure (confirmed with the
 * user via question -- nothing already installed can substitute for
 * driving a real browser). `tests/ui/smoke.spec.ts` manages its own
 * server lifecycle (real API + real built ui/dist, throwaway SQLite,
 * cleaned up after) rather than Playwright's built-in `webServer` option
 * -- same explicit-setup/teardown convention every prior module's smoke
 * script already uses in this project.
 *
 * Requires `npm run build` (backend + ui/dist) to have been run first --
 * this config does not build anything itself.
 */
export default defineConfig({
  testDir: './tests/ui',
  timeout: 30_000,
  fullyParallel: false, // one shared server per test file -- see smoke.spec.ts's beforeAll/afterAll
  reporter: 'list',
  use: {
    headless: true,
  },
});
