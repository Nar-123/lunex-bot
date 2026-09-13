import { execFile } from 'node:child_process';

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
 * arguments: a chain slug we chose ourselves, a timeframe we chose
 * ourselves, and an EVM address GMGN itself returned (which must already
 * be a well-formed 20-byte hex address to mean anything) -- token
 * name/symbol (genuinely free-form, attacker-controlled) are never passed
 * as CLI arguments at all, only ever displayed after `sanitizeDisplayText`.
 */
const EVM_ADDRESS_RE = /^0x[0-9a-fA-F]{40}$/;
// Must start with a letter/digit (never `-`) so a slug can never be
// misread by the CLI's own argument parser as a flag (e.g. "--flag").
const CHAIN_SLUG_RE = /^[a-z0-9][a-z0-9_-]{0,31}$/;
const TIMEFRAME_RE = /^[0-9]{1,2}[hHdD]$/;

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

export function assertValidTimeframe(value: string): string {
  if (!TIMEFRAME_RE.test(value)) {
    throw new Error(`Refusing to use "${value}" as a CLI argument: not an allowlisted timeframe shape`);
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
  env?: NodeJS.ProcessEnv;
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function execFileOnce(
  cliPath: string,
  args: readonly string[],
  timeoutMs: number,
  env: NodeJS.ProcessEnv,
): Promise<string> {
  return new Promise((resolve, reject) => {
    execFile(
      cliPath,
      args as string[],
      { timeout: timeoutMs, env, maxBuffer: 10 * 1024 * 1024 },
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
      const stdout = await execFileOnce(cliPath, args, options.timeoutMs, options.env ?? process.env);
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
