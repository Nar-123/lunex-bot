import { execFile } from 'node:child_process';
import { existsSync, lstatSync, mkdtempSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { isAbsolute, join, relative, resolve, sep } from 'node:path';
import { buildGmgnChildEnv } from './childEnv';
export class GmgnCliExecutionError extends Error {
  constructor(
    message: string,
    public readonly command: string,
    public readonly args: readonly string[],
    override readonly cause?: unknown,
  ) {
    super(message);
    this.name = 'GmgnCliExecutionError';
  }
}

/**
 * Argument allowlists for every value that reaches `gmgn-cli`'s argv.
 *
 * `execFile` (used below, never `exec`) never spawns a shell, so classic
 * shell-metacharacter injection isn't reachable through this code path
 * either way. These validators guard against a narrower but real risk:
 * *argument injection* -- a value crafted to be parsed as a flag instead
 * of a plain value (e.g. an address field that was actually the string
 * `--config=/etc/passwd`). We only ever pass three kinds of values as CLI
 * arguments: a chain slug we chose ourselves, an interval we chose
 * ourselves, and an EVM address GMGN itself returned (which must already
 * be a well-formed 20-byte hex address to mean anything) -- token
 * name/symbol (genuinely free-form, attacker-controlled) are never passed
 * as CLI arguments at all, only ever displayed after `sanitizeDisplayText`.
 */
const EVM_ADDRESS_RE = /^0x[0-9a-fA-F]{40}$/;
// Must start with a letter/digit (never `-`) so a slug can never be
// misread by the CLI's own argument parser as a flag (e.g. "--flag").
const CHAIN_SLUG_RE = /^[a-z0-9][a-z0-9_-]{0,31}$/;
// gmgn-cli `--interval` accepts 1m/5m/1h/6h/24h -- the NdH/NdD shape.
const INTERVAL_RE = /^[0-9]{1,2}[hHdDmM]$/;

export function assertValidEvmAddress(value: string): string {
  if (!EVM_ADDRESS_RE.test(value)) {
    throw new Error(`Refusing to use "${value}" as a CLI argument: not a well-formed EVM address`);
  }
  return value;
}

export function assertValidChainSlug(value: string): string {
  if (!CHAIN_SLUG_RE.test(value)) {
    throw new Error(`Refusing to use "${value}" as a CLI argument: not an allowlisted chain-slug shape`);
  }
  return value;
}

export function assertValidInterval(value: string): string {
  if (!INTERVAL_RE.test(value)) {
    throw new Error(`Refusing to use "${value}" as a CLI argument: not an allowlisted interval shape`);
  }
  return value;
}

export function assertValidLimit(value: number): number {
  if (!Number.isInteger(value) || value < 1 || value > 100) {
    throw new Error(`Refusing to use ${value} as a CLI limit argument: out of allowed range`);
  }
  return value;
}

export interface RunGmgnCliOptions {
  timeoutMs: number;
  maxRetries: number;
  retryBaseDelayMs: number;
  /**
   * The child's COMPLETE environment (it replaces, never extends, the
   * parent's). Omitted falls back to `buildGmgnChildEnv(process.env)` -- the
   * same deny-by-default allowlist -- so no call path can leak the executor
   * key or the other service secrets into a third-party CLI.
   */
  env?: NodeJS.ProcessEnv;
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

const IS_WINDOWS = process.platform === 'win32';
// npm's Windows shims follow the exact layout `<name>.cmd` / `<name>.ps1` /
// extensionless sh next to `node_modules/<name>/package.json`, whose `bin`
// field names the real JS entry point.
const NPM_GLOBAL_ROOTS = [
  process.env.npm_config_prefix,
  process.env.APPDATA ? `${process.env.APPDATA}${sep}npm` : undefined,
  process.env.NPM_CONFIG_PREFIX,
].filter((p): p is string => Boolean(p));

function readBinEntryFromPackageJson(pkgPath: string): string | undefined {
  try {
    const bin = (JSON.parse(readFileSync(pkgPath, 'utf-8')) as { bin?: unknown }).bin;
    if (typeof bin === 'string' && bin.length > 0) return bin;
    if (bin && typeof bin === 'object' && !Array.isArray(bin)) {
      const entries = Object.values(bin).filter((v): v is string => typeof v === 'string' && v.length > 0);
      return entries[0];
    }
  } catch {
    // unreadable/corrupt package.json -- not resolvable, fall through
  }
  return undefined;
}

/**
 * Windows only: `execFile` (deliberately shell-free, see the module doc)
 * cannot execute npm's `gmgn-cli.cmd` shims -- Node spawns them without a
 * shell and gets ENOENT. Instead of dropping the no-shell guarantee (e.g.
 * `shell: true`, which would re-open the argument-injection surface the
 * argv allowlists above exist to close), resolve the shim to the real JS
 * entry (`node_modules/gmgn-cli/dist/index.js`) and spawn
 * `node <entry> <argv>` -- argv is passed through verbatim, so every
 * pre-call validation still covers exactly what is executed.
 * Unix is unaffected: `gmgn-cli` is a shebang script `execFile` can run.
 *
 * `roots` is injectable so tests can point resolution at a synthetic npm
 * layout instead of the machine's real global install.
 */
export function resolveWindowsCliEntry(
  cliPath: string,
  roots: readonly string[] = NPM_GLOBAL_ROOTS,
): { command: string; args: string[] } {
  // Bare command name only (e.g. "gmgn-cli", GMGN_CLI_PATH's default) --
  // an explicit path is the operator's choice and stays untouched.
  if (!cliPath.includes(sep) && !cliPath.includes('/')) {
    for (const root of roots) {
      const pkgDir = resolve(root, 'node_modules', cliPath);
      const binEntry = readBinEntryFromPackageJson(join(pkgDir, 'package.json'));
      if (!binEntry) continue;
      // resolve() normalizes ../ and either separator; the containment
      // check keeps the entry inside the package dir (a bin field
      // pointing elsewhere is not a layout npm produced).
      const entry = resolve(pkgDir, binEntry);
      if (entry.startsWith(pkgDir + sep) && existsSync(entry)) {
        return { command: process.execPath, args: [entry] };
      }
    }
  }
  // Unresolvable (e.g. a custom GMGN_CLI_PATH) -- spawn as-is and let the
  // resulting ENOENT surface as a GmgnCliExecutionError like any other
  // process-level failure, with the user's path visible in the message.
  return { command: cliPath, args: [] };
}

/**
 * Private runtime directory for every `gmgn-cli` child: it is the child's
 * working directory AND its HOME.
 *
 * `buildGmgnChildEnv` keeps the executor key and the other service secrets
 * out of the child's ENVIRONMENT, but that alone is not enough: gmgn-cli's
 * own `config.js` (verified against the installed 1.5.7) loads two dotenv
 * files on start-up --
 *   1. `~/.config/gmgn/.env` with `override: true`, resolved via `homedir()`;
 *   2. `${process.cwd()}/.env` (dotenv's default path).
 * The service's WorkingDirectory and its HOME are both the production tree,
 * whose `.env` holds `PRIVATE_KEY`. A child that inherited either would load
 * production files straight back into the third-party process, undoing the
 * allowlist -- and the override in (1) could even replace the GMGN_API_KEY
 * we pass explicitly.
 *
 * `mkdtemp` creates the directory fresh with mode 0700, so no other account
 * can plant a dotenv file in it. It is created lazily, reused for the life of
 * the process, and re-created if something (e.g. tmpfiles cleanup) removed
 * it. Nothing Lunex itself reads is resolved against this directory.
 */
let gmgnRuntimeDir: string | undefined;

export function gmgnChildRuntimeDir(): string {
  if (gmgnRuntimeDir === undefined || !existsSync(gmgnRuntimeDir)) {
    gmgnRuntimeDir = mkdtempSync(join(tmpdir(), 'lunex-gmgn-'));
  }
  return gmgnRuntimeDir;
}

// The files gmgn-cli's two dotenv calls would read when cwd = HOME = the
// runtime directory.
const GMGN_DOTENV_FILES = ['.env', join('.config', 'gmgn', '.env')];

/**
 * Checked before every spawn; any failure refuses the call (fail closed)
 * rather than running the CLI somewhere it could read secrets from.
 */
function assertSafeRuntimeDir(dir: string): void {
  const st = lstatSync(dir);
  if (st.isSymbolicLink() || !st.isDirectory()) {
    throw new Error(`refusing to run gmgn-cli: runtime directory ${dir} is not a plain directory`);
  }
  if (!IS_WINDOWS) {
    if ((st.mode & 0o077) !== 0) {
      throw new Error(`refusing to run gmgn-cli: runtime directory ${dir} is not private (mode ${(st.mode & 0o777).toString(8)})`);
    }
    if (typeof process.getuid === 'function' && st.uid !== process.getuid()) {
      throw new Error(`refusing to run gmgn-cli: runtime directory ${dir} is not owned by this process`);
    }
  }
  // e.g. TMPDIR pointed into the service tree: never run the CLI there.
  const rel = relative(resolve(process.cwd()), resolve(dir));
  if (rel === '' || !(rel === '..' || rel.startsWith(`..${sep}`) || isAbsolute(rel))) {
    throw new Error(`refusing to run gmgn-cli: runtime directory ${dir} is inside the service working directory`);
  }
  for (const file of GMGN_DOTENV_FILES) {
    if (existsSync(join(dir, file))) {
      throw new Error(`refusing to run gmgn-cli: its runtime directory contains ${file}`);
    }
  }
}

function execFileOnce(
  cliPath: string,
  args: readonly string[],
  timeoutMs: number,
  env: NodeJS.ProcessEnv,
  runtimeDir: string,
): Promise<string> {
  assertSafeRuntimeDir(runtimeDir);
  // Enforced here, at the single spawn point, so it holds whatever env the
  // caller built: `homedir()` reads HOME on POSIX and USERPROFILE on Windows.
  const childEnv: NodeJS.ProcessEnv = { ...env, HOME: runtimeDir, USERPROFILE: runtimeDir };
  // Resolve per-call rather than at module load so a missing CLI surfaces
  // as the same GmgnCliExecutionError path on every attempt.
  const resolved = IS_WINDOWS ? resolveWindowsCliEntry(cliPath) : { command: cliPath, args: [] as string[] };
  const argv = [...resolved.args, ...args];
  return new Promise((resolve, reject) => {
    execFile(
      resolved.command,
      argv,
      { timeout: timeoutMs, env: childEnv, cwd: runtimeDir, maxBuffer: 10 * 1024 * 1024 },
      (error, stdout) => {
        if (error) {
          // execFile's error is an ExecFileException (an Error carrying
          // stdout/stderr); assert the shape rather than trusting it, so a
          // non-Error rejection can never reach a `catch (err)` that
          // assumes `.message` exists.
          reject(error instanceof Error ? error : new Error('gmgn-cli child process failed with a non-Error value'));
          return;
        }
        resolve(stdout);
      },
    );
  });
}

/**
 * Runs `gmgn-cli` with a fixed, pre-validated argv array (never a shell
 * string) and JSON stdout parsing, with bounded retry/backoff for
 * transient failures (network blips, brief rate limiting). Throws
 * `GmgnCliExecutionError` on any process-level failure (non-zero exit,
 * spawn error, timeout, unparseable stdout) after retries are exhausted --
 * callers must never treat that as "zero results".
 */
export async function runGmgnCliJson(
  cliPath: string,
  args: readonly string[],
  options: RunGmgnCliOptions,
): Promise<unknown> {
  let lastError: unknown;
  for (let attempt = 0; attempt <= options.maxRetries; attempt++) {
    try {
      // `options.env` omitted must NOT mean "inherit every Lunex secret" --
      // fall back to the same allowlist `GmgnCliClient` passes explicitly.
      // The runtime directory is resolved and checked inside this try, so a
      // failure is a GmgnCliExecutionError like any other -- never a fallback
      // to the service's own (production) working directory or HOME.
      const stdout = await execFileOnce(
        cliPath,
        args,
        options.timeoutMs,
        options.env ?? buildGmgnChildEnv(process.env),
        gmgnChildRuntimeDir(),
      );
      try {
        return JSON.parse(stdout);
      } catch (parseErr) {
        throw new GmgnCliExecutionError(
          `gmgn-cli returned non-JSON stdout for: ${cliPath} ${args.join(' ')}`,
          cliPath,
          args,
          parseErr,
        );
      }
    } catch (err) {
      lastError = err;
      if (attempt < options.maxRetries) {
        await sleep(options.retryBaseDelayMs * 2 ** attempt);
        continue;
      }
    }
  }
  if (lastError instanceof GmgnCliExecutionError) throw lastError;
  throw new GmgnCliExecutionError(
    `gmgn-cli command failed after ${options.maxRetries + 1} attempt(s): ${cliPath} ${args.join(' ')}`,
    cliPath,
    args,
    lastError,
  );
}
