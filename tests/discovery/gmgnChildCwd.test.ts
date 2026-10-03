import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { execFile } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, relative, resolve, isAbsolute } from 'node:path';
import { promisify } from 'node:util';
import { GmgnCliExecutionError, gmgnChildRuntimeDir, runGmgnCliJson } from '../../src/discovery/cliExec';
import { buildGmgnChildEnv, GMGN_CHILD_ENV_PASSTHROUGH } from '../../src/discovery/childEnv';
import { mapTrendingResponseToPartialCandidates } from '../../src/discovery/gmgnMapper';

/**
 * Regression tests for the gmgn-cli dotenv leak, run against REAL child
 * processes (no child_process mock). gmgn-cli@1.5.7's config.js loads
 * `~/.config/gmgn/.env` (override) and then `${process.cwd()}/.env`, and the
 * production service's WorkingDirectory and HOME are both the tree that
 * holds `PRIVATE_KEY`.
 *
 * The fake CLI below loads configuration exactly the way gmgn-cli does,
 * using the real dotenv package, and reports what it ended up seeing.
 */

const execFileAsync = promisify(execFile);
const FAST_OPTS = { timeoutMs: 15_000, maxRetries: 0, retryBaseDelayMs: 1 };
const GMGN_ARGS = ['market', 'trending', '--chain', 'robinhood', '--interval', '6h', '--limit', '10', '--raw'];
const TEST_API_KEY = 'test-gmgn-api-key-not-real';

interface ChildReport {
  cwd: string;
  homedir: string;
  envHome: string | null;
  envUserProfile: string | null;
  prodEnvMarker: string | null;
  prodGmgnHomeMarker: string | null;
  sawPrivateKey: boolean;
  sawJwtSecret: boolean;
  sawTelegramToken: boolean;
  gmgnApiKey: string | null;
  lang: string | null;
  tz: string | null;
  envKeys: string[];
  argv: string[];
}

let root: string;
let prodDir: string;
let fakeCli: string;
let ranFlag: string;
let originalCwd: string;

function real(p: string): string {
  const r = realpathSync.native(p);
  return process.platform === 'win32' ? r.toLowerCase() : r;
}

function isInside(child: string, parent: string): boolean {
  const rel = relative(real(parent), real(child));
  return rel === '' || (!rel.startsWith('..') && !isAbsolute(rel));
}

/**
 * The parent environment the production service holds: secrets included, and
 * HOME/USERPROFILE pointing at the production tree, exactly as the service
 * account's passwd entry does on the host.
 */
function parentEnv(): NodeJS.ProcessEnv {
  return {
    PATH: process.env.PATH,
    SystemRoot: process.env.SystemRoot,
    HOME: prodDir,
    USERPROFILE: prodDir,
    LANG: 'C.UTF-8',
    TZ: 'UTC',
    PRIVATE_KEY: '0x' + 'ab'.repeat(32),
    JWT_SECRET: 'parent-jwt-secret',
    TELEGRAM_BOT_TOKEN: '123456789:parent-telegram-token-not-real-xxxxxxx',
  };
}

function prodChildEnv(): NodeJS.ProcessEnv {
  return buildGmgnChildEnv(parentEnv(), TEST_API_KEY);
}

beforeAll(() => {
  root = mkdtempSync(join(tmpdir(), 'lunex-gmgn-cwd-test-'));
  prodDir = join(root, 'production', 'lunex-bot');
  mkdirSync(join(prodDir, '.config', 'gmgn'), { recursive: true });
  // Stand-in for the production .env: every value here must stay out of the child.
  writeFileSync(
    join(prodDir, '.env'),
    [
      'PRIVATE_KEY=0xPRODUCTION_KEY_MUST_NEVER_REACH_GMGN',
      'JWT_SECRET=production-jwt',
      'TELEGRAM_BOT_TOKEN=987654321:production-token',
      'LUNEX_PROD_ENV_MARKER=loaded',
      '',
    ].join('\n'),
  );
  // Stand-in for a gmgn global config under the production HOME. gmgn-cli
  // loads it with override: true, so it would even replace our GMGN_API_KEY.
  writeFileSync(
    join(prodDir, '.config', 'gmgn', '.env'),
    ['GMGN_API_KEY=production-home-gmgn-key', 'LUNEX_PROD_GMGN_HOME_MARKER=loaded', 'PRIVATE_KEY=0xFROM_PRODUCTION_HOME', ''].join('\n'),
  );
  ranFlag = join(root, 'fake-cli-ran.flag');
  fakeCli = join(root, 'fake-gmgn-cli.cjs');
  writeFileSync(
    fakeCli,
    `const fs = require('fs');
const path = require('path');
const os = require('os');
fs.writeFileSync(${JSON.stringify(ranFlag)}, 'ran');
const dotenv = require(${JSON.stringify(require.resolve('dotenv'))});
// Same order as gmgn-cli@1.5.7 dist/config.js; quiet only silences dotenv 17's stdout tip.
dotenv.config({ path: path.join(os.homedir(), '.config', 'gmgn', '.env'), override: true, quiet: true });
dotenv.config({ quiet: true });
const mode = process.argv[2];
if (mode === 'fail') { process.stderr.write('simulated gmgn-cli failure\\n'); process.exit(1); }
if (mode === 'fixture') { process.stdout.write(fs.readFileSync(process.argv[3], 'utf8')); process.exit(0); }
process.stdout.write(JSON.stringify({
  cwd: process.cwd(),
  homedir: os.homedir(),
  envHome: process.env.HOME ?? null,
  envUserProfile: process.env.USERPROFILE ?? null,
  prodEnvMarker: process.env.LUNEX_PROD_ENV_MARKER ?? null,
  prodGmgnHomeMarker: process.env.LUNEX_PROD_GMGN_HOME_MARKER ?? null,
  sawPrivateKey: process.env.PRIVATE_KEY !== undefined,
  sawJwtSecret: process.env.JWT_SECRET !== undefined,
  sawTelegramToken: process.env.TELEGRAM_BOT_TOKEN !== undefined,
  gmgnApiKey: process.env.GMGN_API_KEY ?? null,
  lang: process.env.LANG ?? null,
  tz: process.env.TZ ?? null,
  envKeys: Object.keys(process.env).sort(),
  argv: process.argv.slice(3),
}));
`,
  );
});

afterAll(() => {
  rmSync(root, { recursive: true, force: true });
});

beforeEach(() => {
  // Reproduce the production condition: the Lunex process runs with the
  // production tree (which holds .env) as its working directory.
  originalCwd = process.cwd();
  process.chdir(prodDir);
  rmSync(ranFlag, { force: true });
});

afterEach(() => {
  process.chdir(originalCwd);
});

async function runReport(env?: NodeJS.ProcessEnv): Promise<ChildReport> {
  const opts = env === undefined ? FAST_OPTS : { ...FAST_OPTS, env };
  return (await runGmgnCliJson(process.execPath, [fakeCli, 'report', ...GMGN_ARGS], opts)) as ChildReport;
}

describe('gmgn-cli child runtime isolation (dotenv leak regression)', () => {
  it('CONTROL: a child that inherits the production cwd and HOME DOES load both production files -- the detector works', async () => {
    // What execFile did before the fix: no `cwd`, HOME passed through. If this
    // ever stops reporting the markers, every "not loaded" assertion below
    // would be meaningless.
    const { stdout } = await execFileAsync(process.execPath, [fakeCli, 'report'], { env: prodChildEnv() });
    const report = JSON.parse(stdout) as ChildReport;
    expect(real(report.cwd)).toBe(real(prodDir));
    expect(real(report.homedir)).toBe(real(prodDir));
    expect(report.prodEnvMarker).toBe('loaded');
    expect(report.prodGmgnHomeMarker).toBe('loaded');
    expect(report.gmgnApiKey).toBe('production-home-gmgn-key');
    expect(report.sawPrivateKey).toBe(true);
  });

  it('A: the child cwd is the neutral runtime directory, never in or under the production cwd', async () => {
    const report = await runReport(prodChildEnv());
    expect(real(process.cwd())).toBe(real(prodDir)); // the parent really is in the production tree
    expect(isInside(report.cwd, prodDir)).toBe(false);
    expect(real(report.cwd)).toBe(real(gmgnChildRuntimeDir()));
  });

  it('B: the child HOME is the neutral runtime directory, never the production HOME', async () => {
    const report = await runReport(prodChildEnv());
    expect(isInside(report.homedir, prodDir)).toBe(false);
    expect(real(report.homedir)).toBe(real(gmgnChildRuntimeDir()));
    expect(report.envHome).not.toBeNull();
    expect(real(report.envHome as string)).toBe(real(gmgnChildRuntimeDir()));
    expect(report.envUserProfile).not.toBeNull();
    expect(real(report.envUserProfile as string)).toBe(real(gmgnChildRuntimeDir()));
  });

  it('B: the default env path (options.env omitted) also gets the neutral HOME', async () => {
    const report = await runReport();
    expect(real(report.homedir)).toBe(real(gmgnChildRuntimeDir()));
  });

  it('C: the child cannot load the production .env through dotenv default behaviour', async () => {
    const report = await runReport(prodChildEnv());
    expect(report.prodEnvMarker).toBeNull();
    expect(report.sawPrivateKey).toBe(false);
    expect(report.sawJwtSecret).toBe(false);
    expect(report.sawTelegramToken).toBe(false);
  });

  it('C: the default env path (options.env omitted) leaks neither parent secrets nor the production .env', async () => {
    // process.env here carries tests/setup.ts's fake PRIVATE_KEY/JWT_SECRET.
    expect(process.env.PRIVATE_KEY).toBeDefined();
    const report = await runReport();
    expect(report.prodEnvMarker).toBeNull();
    expect(report.sawPrivateKey).toBe(false);
    expect(report.sawJwtSecret).toBe(false);
  });

  it('D: the child cannot load the production ~/.config/gmgn/.env through HOME inheritance', async () => {
    const report = await runReport(prodChildEnv());
    expect(report.prodGmgnHomeMarker).toBeNull();
    expect(report.sawPrivateKey).toBe(false);
  });

  it('E: GMGN_API_KEY still reaches the child, and a production gmgn config cannot override it', async () => {
    const report = await runReport(prodChildEnv());
    expect(report.gmgnApiKey).toBe(TEST_API_KEY);
  });

  it('F: allowlisted non-secret variables still reach the child, and nothing outside the allowlist does', async () => {
    const report = await runReport(prodChildEnv());
    expect(report.envKeys).toContain('PATH');
    expect(report.lang).toBe('C.UTF-8');
    expect(report.tz).toBe('UTC');
    const allowed = [...GMGN_CHILD_ENV_PASSTHROUGH, 'GMGN_API_KEY'];
    // On Windows libuv copies a fixed set of per-session variables into every
    // child whose env was given explicitly (uv_spawn's required vars). None is
    // a secret and none exists on the Linux production host.
    if (process.platform === 'win32') {
      allowed.push('HOMEDRIVE', 'HOMEPATH', 'LOGONSERVER', 'SYSTEMDRIVE', 'SYSTEMROOT', 'TEMP', 'USERDOMAIN', 'USERNAME', 'USERPROFILE', 'WINDIR');
    }
    const norm = (k: string) => (process.platform === 'win32' ? k.toUpperCase() : k);
    const allowedSet = new Set(allowed.map(norm));
    expect(report.envKeys.filter((k) => !allowedSet.has(norm(k)))).toEqual([]);
  });

  it('G: the GMGN command arguments reach the child unchanged', async () => {
    const report = await runReport(prodChildEnv());
    expect(report.argv).toEqual(GMGN_ARGS);
  });

  it('H: successful gmgn-cli output is parsed exactly as before', async () => {
    const fixturePath = resolve(originalCwd, 'tests/discovery/fixtures/gmgn_trending.json');
    const expected: unknown = JSON.parse(readFileSync(fixturePath, 'utf8'));
    const body = await runGmgnCliJson(process.execPath, [fakeCli, 'fixture', fixturePath], {
      ...FAST_OPTS,
      env: prodChildEnv(),
    });
    expect(body).toEqual(expected);
    const ctx = { chainId: 4663, discoveredAt: 1_700_000_000_000 };
    expect(mapTrendingResponseToPartialCandidates(body, ctx)).toEqual(mapTrendingResponseToPartialCandidates(expected, ctx));
  });

  it('I: a failing CLI is still a GmgnCliExecutionError (fail closed)', async () => {
    await expect(runGmgnCliJson(process.execPath, [fakeCli, 'fail'], { ...FAST_OPTS, env: prodChildEnv() })).rejects.toThrow(
      GmgnCliExecutionError,
    );
  });

  it('I: a .env planted in the runtime directory fails closed without spawning the CLI', async () => {
    const planted = join(gmgnChildRuntimeDir(), '.env');
    writeFileSync(planted, 'LUNEX_PROD_ENV_MARKER=planted\n');
    try {
      await expect(runReport(prodChildEnv())).rejects.toThrow(GmgnCliExecutionError);
      expect(existsSync(ranFlag)).toBe(false);
    } finally {
      rmSync(planted, { force: true });
    }
  });

  it('I: a .config/gmgn/.env planted under the runtime HOME fails closed without spawning the CLI', async () => {
    const configDir = join(gmgnChildRuntimeDir(), '.config');
    mkdirSync(join(configDir, 'gmgn'), { recursive: true });
    writeFileSync(join(configDir, 'gmgn', '.env'), 'LUNEX_PROD_GMGN_HOME_MARKER=planted\n');
    try {
      await expect(runReport(prodChildEnv())).rejects.toThrow(GmgnCliExecutionError);
      expect(existsSync(ranFlag)).toBe(false);
    } finally {
      rmSync(configDir, { recursive: true, force: true });
    }
  });

  it.skipIf(process.platform === 'win32')('J: the runtime directory is private to the service account (mode 0700)', async () => {
    expect(statSync(gmgnChildRuntimeDir()).mode & 0o777).toBe(0o700);
    // and a directory loosened after creation is refused, not used
    const { chmodSync } = await import('node:fs');
    chmodSync(gmgnChildRuntimeDir(), 0o755);
    try {
      await expect(runReport(prodChildEnv())).rejects.toThrow(GmgnCliExecutionError);
      expect(existsSync(ranFlag)).toBe(false);
    } finally {
      chmodSync(gmgnChildRuntimeDir(), 0o700);
    }
  });

  it('K: the runtime directory is re-created if it disappears', async () => {
    const dir = gmgnChildRuntimeDir();
    // Guard the delete below: a broken implementation must fail this test,
    // never make it remove a real directory.
    expect(isInside(dir, tmpdir())).toBe(true);
    expect(isInside(dir, prodDir)).toBe(false);
    expect(isInside(dir, originalCwd)).toBe(false);
    rmSync(dir, { recursive: true, force: true });
    const report = await runReport(prodChildEnv());
    expect(existsSync(report.cwd)).toBe(true);
    expect(real(report.homedir)).toBe(real(report.cwd));
    expect(isInside(report.cwd, prodDir)).toBe(false);
    expect(report.prodEnvMarker).toBeNull();
    expect(report.prodGmgnHomeMarker).toBeNull();
    if (process.platform !== 'win32') {
      expect(statSync(report.cwd).mode & 0o777).toBe(0o700);
    }
  });
});
