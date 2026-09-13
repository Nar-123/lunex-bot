/// <reference lib="dom" />
// The reference above is scoped to THIS file only -- needed because
// `page.evaluate(() => sessionStorage...)` callbacks below run in the
// BROWSER, but this file itself is type-checked under the backend
// tsconfig.json (no DOM lib globally, deliberately -- see tsconfig.ui.json
// for where ui/'s own browser code is checked instead).
import { test, expect } from '@playwright/test';
import { execSync } from 'node:child_process';
import { existsSync, rmSync, mkdirSync } from 'node:fs';
import path from 'node:path';
import type { Server } from 'node:http';

/**
 * Module 12's real, repeatable, browser-driven end-to-end check (Decision
 * 1) -- real API server, real built `ui/dist`, a real headless Chromium
 * tab, real login, real click-through of every view, a real settings
 * submit verified against a fresh Prisma read afterward. Requires
 * `npm run build` to have already produced `dist/` and `ui/dist/` --
 * this spec does not build anything itself (see `playwright.config.ts`).
 *
 * Same throwaway-DB-per-run, clean-up-after convention every prior
 * module's smoke script in this project already uses -- `process.env` is
 * set BEFORE any `dist/` module is required (env.ts's `loadEnv()` runs
 * once at first import), migrations are applied programmatically, and
 * everything (DB file, server) is torn down in `afterAll` regardless of
 * pass/fail.
 */

const DB_PATH = path.resolve(__dirname, '../../data/ui-smoke-test.db');
const PORT = 18446;
const ADMIN_PASSWORD = 'SmokeTest123!';
// bcrypt hash of ADMIN_PASSWORD above -- same fixture hash used by every prior module's smoke script.
const ADMIN_PASSWORD_HASH = '$2b$10$dAw9YFtm8gqk4rp5IaPype4YfZP3rB0ufKfJ/mrD.gCfVDAYf.0D2';

process.env.NODE_ENV = 'production';
process.env.LOG_LEVEL = 'error';
process.env.API_PORT = String(PORT);
process.env.API_HOST = '127.0.0.1';
process.env.RPC_URL = 'https://ui-smoke-test-rpc.invalid';
process.env.CHAIN_ID = '4663';
process.env.PRIVATE_KEY = '0x' + '11'.repeat(32);
process.env.USDG_TOKEN_ADDRESS = '0x' + '22'.repeat(20);
process.env.UNISWAP_V4_POSITION_MANAGER_ADDRESS = '0x58daec3116aae6d93017baaea7749052e8a04fa7';
process.env.UNISWAP_API_KEY = 'ui-smoke-test-uniswap-api-key-not-for-real-use';
process.env.DATABASE_PROVIDER = 'sqlite';
process.env.DATABASE_URL = `file:${DB_PATH}`;
process.env.AUTH_ADMIN_USERNAME = 'ui-smoke-admin';
process.env.AUTH_ADMIN_PASSWORD_HASH = ADMIN_PASSWORD_HASH;
process.env.AUTH_ADMIN_PASSWORD = ADMIN_PASSWORD;
process.env.JWT_SECRET = 'ui-smoke-test-jwt-secret-value-1234';
process.env.LOGIN_RATE_LIMIT_MAX_ATTEMPTS = '50';
process.env.TELEGRAM_BOT_TOKEN = '';
process.env.TELEGRAM_AUTHORIZED_USER_IDS = '';

let server: Server;
let deps: import('../../src/composition/types').AppDeps;
let baseUrl: string;

test.describe('ui/ end-to-end smoke test', () => {
  test.beforeAll(async () => {
    mkdirSync(path.dirname(DB_PATH), { recursive: true });
    if (existsSync(DB_PATH)) rmSync(DB_PATH);

    execSync('npx prisma migrate deploy', { cwd: path.resolve(__dirname, '../..'), stdio: 'inherit' });

    // Required AFTER env vars are set, AFTER migrations -- these
    // transitively load src/config (frozen at first import).
    // eslint-disable-next-line @typescript-eslint/no-var-requires
    const { createRealAppDeps } = require('../../dist/composition/deps');
    // eslint-disable-next-line @typescript-eslint/no-var-requires
    const { startApiServer } = require('../../dist/api/server');

    deps = createRealAppDeps();
    server = await startApiServer(deps);
    const address = server.address();
    const port = typeof address === 'object' && address ? address.port : PORT;
    baseUrl = `http://127.0.0.1:${port}`;

    // Seed data the read-only views need to show something real:
    // one CLOSED position (History view) and one stuck TransactionAttempt (Stuck view).
    const created = await deps.positions.create({
      tokenAddress: '0x0000000000000000000000000000000000000002',
      tokenSymbol: 'SMOKE',
      tokenDecimals: 18,
      pool: {
        poolId: '0xaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa',
        currency0: '0x0000000000000000000000000000000000000002',
        currency1: '0x2222222222222222222222222222222222222222',
        fee: 3000,
        tickSpacing: 60,
        hooks: '0x0000000000000000000000000000000000000000',
      },
      tickLower: -6960,
      tickUpper: -60,
      entryUsdgRaw: 1000n * 10n ** 18n,
      entrySqrtPriceX96: 2n ** 96n,
      entryTick: 0,
      openIdempotencyKey: 'ui-smoke:1',
    });
    await deps.positions.markActive(created.id, '1', new Date());
    await deps.positions.markClosing(created.id, 'ui-smoke:close:1');
    await deps.positions.markClosed(created.id, new Date(), 'HARD_STOP_LOSS');

    const attempt = await deps.txAttempts.create('ui-smoke:stuck:1', 'test');
    await deps.txAttempts.update(attempt.id, { status: 'SENT', attemptCount: 10, firstAttemptedAt: new Date(Date.now() - 20 * 60 * 1000) });
  });

  test.afterAll(async () => {
    await new Promise<void>((resolve, reject) => server.close((err) => (err ? reject(err) : resolve())));
    // eslint-disable-next-line @typescript-eslint/no-var-requires
    const { disconnectPrismaClient } = require('../../dist/storage/prismaClient');
    await disconnectPrismaClient();
    if (existsSync(DB_PATH)) rmSync(DB_PATH);
  });

  test('login screen loads at /app, no auth required for the static shell', async ({ page }) => {
    await page.goto(`${baseUrl}/app`);
    await expect(page.locator('#login-form')).toBeVisible();
  });

  test('a wrong password shows an inline error, does not proceed', async ({ page }) => {
    await page.goto(`${baseUrl}/app`);
    await page.fill('input[name="username"]', 'ui-smoke-admin');
    await page.fill('input[name="password"]', 'wrong-password');
    await page.click('button[type="submit"]');
    await expect(page.locator('.field-error')).toBeVisible();
    await expect(page.locator('#app-shell')).toBeHidden();
  });

  test('real login, then every read-only view shows real data from the real DB', async ({ page }) => {
    await page.goto(`${baseUrl}/app`);
    await page.fill('input[name="username"]', 'ui-smoke-admin');
    await page.fill('input[name="password"]', ADMIN_PASSWORD);
    await page.click('button[type="submit"]');
    await expect(page.locator('#app-shell')).toBeVisible();

    // Cooldowns -- no RPC dependency, safe to assert content directly.
    await page.click('button[data-view="cooldowns"]');
    await expect(page.locator('main')).toContainText('Tidak ada token dalam cooldown');

    // Stuck -- reflects the seeded TransactionAttempt.
    await page.click('button[data-view="stuck"]');
    await expect(page.locator('main')).toContainText('ui-smoke:stuck:1');

    // History -- reflects the seeded CLOSED position. Seeded without measured
    // proceeds, it honestly shows the unmeasured disclosure (a measured close
    // would show the receipt-derived PnL number instead).
    await page.click('button[data-view="history"]');
    await expect(page.locator('main')).toContainText('SMOKE');
    await expect(page.locator('main')).toContainText('HARD_STOP_LOSS');
    await expect(page.locator('main')).toContainText('belum tersedia');

    // Logs -- the server has already logged at least a startup event.
    await page.click('button[data-view="logs"]');
    await expect(page.locator('main table')).toBeVisible();
  });

  test('settings: reads current values, client-side cross-field validation matches the real frozen threshold, PATCH persists to real SQLite', async ({ page }) => {
    await page.goto(`${baseUrl}/app`);
    await page.fill('input[name="username"]', 'ui-smoke-admin');
    await page.fill('input[name="password"]', ADMIN_PASSWORD);
    await page.click('button[type="submit"]');
    await page.click('button[data-view="settings"]');

    const hardStopLossInput = page.locator('input[name="hardStopLossPct"]');
    await expect(hardStopLossInput).toHaveValue('-6'); // DEFAULT_SETTINGS, TIER 3 (Meridian-aligned), was -15

    // TIER 3 removed the cross-field rule (see ui/src/validators.ts): -5%
    // is now a legal value, so the form must show NO error for it. The
    // per-field bound is still live and is proven right below.
    await hardStopLossInput.fill('-5');
    await hardStopLossInput.blur();
    await expect(page.locator('[data-error-for="hardStopLossPct"]')).toHaveText('');

    // ...but a positive stop is still rejected client-side.
    await hardStopLossInput.fill('5');
    await hardStopLossInput.blur();
    await expect(page.locator('[data-error-for="hardStopLossPct"]')).not.toHaveText('');

    await hardStopLossInput.fill('-20');
    await page.locator('input[name="maxActivePositions"]').fill('7');
    await page.click('#settings-form button[type="submit"]');
    await expect(page.locator('#settings-form-status')).toContainText('Tersimpan');

    const settings = await deps.settings.get();
    expect(settings.hardStopLossPct).toBeCloseTo(-0.2);
    expect(settings.maxActivePositions).toBe(7);
  });

  test('pause/resume: confirm dialog gates the action -- accepting it calls the real endpoint, persisted to real SQLite', async ({ page }) => {
    await page.goto(`${baseUrl}/app`);
    await page.fill('input[name="username"]', 'ui-smoke-admin');
    await page.fill('input[name="password"]', ADMIN_PASSWORD);
    await page.click('button[type="submit"]');

    page.once('dialog', (dialog) => dialog.accept());
    await page.click('#pause-btn');
    await page.waitForTimeout(300);

    const settingsAfterPause = await deps.settings.get();
    expect(settingsAfterPause.paused).toBe(true);

    page.once('dialog', (dialog) => dialog.dismiss());
    await page.click('#resume-btn');
    await page.waitForTimeout(300);

    const settingsAfterDismiss = await deps.settings.get();
    expect(settingsAfterDismiss.paused).toBe(true); // dismissed -- resume did NOT happen

    page.once('dialog', (dialog) => dialog.accept());
    await page.click('#resume-btn');
    await page.waitForTimeout(300);

    const settingsAfterResume = await deps.settings.get();
    expect(settingsAfterResume.paused).toBe(false);
  });

  test('Decision 4: an invalid/expired token bounces back to the login screen -- NO auto-relogin attempt', async ({ page }) => {
    await page.goto(`${baseUrl}/app`);
    await page.fill('input[name="username"]', 'ui-smoke-admin');
    await page.fill('input[name="password"]', ADMIN_PASSWORD);
    await page.click('button[type="submit"]');
    await expect(page.locator('#app-shell')).toBeVisible();

    // Simulate an expired/invalid token -- overwrite the stored one directly.
    await page.evaluate(() => sessionStorage.setItem('lunex_ui_token', 'invalid.invalid.invalid'));
    await page.click('button[data-view="positions"]'); // triggers a real 401 from the real API

    await expect(page.locator('#login-screen')).toBeVisible();
    await expect(page.locator('#app-shell')).toBeHidden();
    const tokenAfter = await page.evaluate(() => sessionStorage.getItem('lunex_ui_token'));
    expect(tokenAfter).toBeNull(); // cleared, not retried
  });
});
