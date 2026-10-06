/**
 * Production deployment CLI for the target host. Run as `lunex-admin` from the
 * deploy tool's own sealed release, /opt/lunex/releases/<TOOL_SHA>/dist/deploy/cli.js.
 *
 *   plan             100% read-only: no systemctl mutation, no identity probe, no file writes.
 *                    --expected-release-sha --expected-previous-sha --expected-executor
 *                    --expected-chain-id --rpc (1+, https) --expected-manifest-sha256
 *   verify-identity  runs the identity probe unit (a systemd start) and compares
 *                    --expected-executor --expected-chain-id
 *   execute          plan flags + --session-dir + --confirm-release <same release sha>
 *   rollback         --expected-previous-sha --rollback-dir --session-dir
 *                    --confirm-rollback <same previous sha>
 *
 * There is no default command and no default for any SHA. See ops/deploy/README.md.
 */
import * as nodeFs from 'node:fs';
import { isAbsolute, resolve } from 'node:path';
import { isFullCommitSha, normalizeAddress } from './gate';
import { createDeployPorts, createReadPorts, TARGET_LAYOUT, type HostPortsConfig } from './hostPorts';
import { runDeployment, runPlan, runRollback, type DeployOutcome, type DeployPorts, type ReadPorts } from './pipeline';

export type Command = 'plan' | 'verify-identity' | 'execute' | 'rollback';

export interface CliOptions {
  command: Command;
  expectedReleaseSha?: string;
  expectedPreviousSha?: string;
  expectedExecutor?: string;
  expectedChainId?: number;
  expectedManifestSha256?: string;
  rpcUrls: string[];
  sessionDir?: string;
  rollbackDir?: string;
}

export class UsageError extends Error {}

const FLAGS: Record<Command, readonly string[]> = {
  plan: ['--expected-release-sha', '--expected-previous-sha', '--expected-executor', '--expected-chain-id', '--rpc', '--expected-manifest-sha256'],
  'verify-identity': ['--expected-executor', '--expected-chain-id'],
  execute: ['--expected-release-sha', '--expected-previous-sha', '--expected-executor', '--expected-chain-id', '--rpc', '--expected-manifest-sha256', '--session-dir', '--confirm-release'],
  rollback: ['--expected-previous-sha', '--rollback-dir', '--session-dir', '--confirm-rollback'],
};

/** Strict parsing: per-command flags, every flag required, no defaults, no repeats (except --rpc). */
export function parseArgs(argv: readonly string[]): CliOptions {
  const [command, ...rest] = argv;
  if (command !== 'plan' && command !== 'verify-identity' && command !== 'execute' && command !== 'rollback') {
    throw new UsageError('first argument must be plan, verify-identity, execute or rollback');
  }
  const allowed = new Set(FLAGS[command]);
  const single = new Map<string, string>();
  const rpcUrls: string[] = [];
  for (let i = 0; i < rest.length; i += 2) {
    const flag = rest[i] ?? '';
    const value = rest[i + 1];
    if (!allowed.has(flag)) throw new UsageError(`${flag || '(empty)'} is not valid for ${command}`);
    if (value === undefined || value.startsWith('--')) throw new UsageError(`${flag} needs a value`);
    if (flag === '--rpc') rpcUrls.push(value);
    else if (single.has(flag)) throw new UsageError(`${flag} given twice`);
    else single.set(flag, value);
  }
  for (const f of FLAGS[command]) {
    if (f === '--rpc') {
      if (rpcUrls.length === 0) throw new UsageError('at least one --rpc is required');
    } else if (!single.has(f)) throw new UsageError(`${f} is required for ${command}`);
  }
  const get = (f: string) => single.get(f);
  const opts: CliOptions = { command, rpcUrls };
  const release = get('--expected-release-sha');
  const previous = get('--expected-previous-sha');
  if (release !== undefined) {
    if (!isFullCommitSha(release)) throw new UsageError('--expected-release-sha must be a full 40-hex commit id');
    opts.expectedReleaseSha = release;
  }
  if (previous !== undefined) {
    if (!isFullCommitSha(previous)) throw new UsageError('--expected-previous-sha must be a full 40-hex commit id');
    opts.expectedPreviousSha = previous;
  }
  if (release !== undefined && release === previous) throw new UsageError('release and previous release are the same commit');
  const executor = get('--expected-executor');
  if (executor !== undefined) {
    if (normalizeAddress(executor) === null) throw new UsageError('--expected-executor must be a 20-byte hex address');
    opts.expectedExecutor = executor;
  }
  const chain = get('--expected-chain-id');
  if (chain !== undefined) {
    if (!/^[1-9][0-9]{0,15}$/.test(chain) || !Number.isSafeInteger(Number(chain))) throw new UsageError('--expected-chain-id must be a positive integer');
    opts.expectedChainId = Number(chain);
  }
  const manifest = get('--expected-manifest-sha256');
  if (manifest !== undefined) {
    if (!/^[0-9a-f]{64}$/.test(manifest)) throw new UsageError('--expected-manifest-sha256 must be 64 lowercase hex');
    opts.expectedManifestSha256 = manifest;
  }
  for (const u of rpcUrls) {
    let parsed: URL;
    try {
      parsed = new URL(u);
    } catch {
      throw new UsageError('--rpc must be a URL');
    }
    if (parsed.protocol !== 'https:') throw new UsageError('--rpc must use https');
  }
  const session = get('--session-dir');
  if (session !== undefined) {
    if (!isAbsolute(session)) throw new UsageError('--session-dir must be absolute');
    opts.sessionDir = session;
  }
  if (command === 'execute' && get('--confirm-release') !== release) throw new UsageError('--confirm-release must repeat the exact --expected-release-sha');
  const rollbackDir = get('--rollback-dir');
  if (rollbackDir !== undefined) opts.rollbackDir = rollbackDir;
  if (command === 'rollback' && get('--confirm-rollback') !== previous) throw new UsageError('--confirm-rollback must repeat the exact --expected-previous-sha');
  return opts;
}

export function exitCodeFor(outcome: DeployOutcome): number {
  switch (outcome.status) {
    case 'PLAN_OK':
      return 0;
    case 'DEPLOYED':
    case 'ROLLED_BACK':
      return outcome.needsVerification ? 4 : 0;
    case 'ABORTED':
      return 2;
    case 'FAILED_AFTER_REPLACE':
    case 'ROLLBACK_FAILED':
      return 3;
  }
}

export interface CliDeps {
  write(line: string): void;
  resolveToolSha(): string;
  /** Creates/validates the 0700 session dir and returns an appender for its deploy.log. Never used by plan. */
  openSessionLog(dir: string): (line: string) => void;
  createReadPorts(cfg: HostPortsConfig): ReadPorts;
  createDeployPorts(cfg: HostPortsConfig): DeployPorts;
}

/**
 * The tool must run from its own sealed release, <releasesDir>/<sha>/dist/deploy,
 * whose RELEASE_SHA names the identity-unit instance and the lock source.
 */
function resolveToolShaFromDisk(): string {
  const root = resolve(__dirname, '..', '..');
  const sha = nodeFs.readFileSync(resolve(root, 'RELEASE_SHA'), 'utf8').trim();
  if (!isFullCommitSha(sha) || root !== `${TARGET_LAYOUT.releasesDir}/${sha}`) {
    throw new Error(`the deploy tool must run from ${TARGET_LAYOUT.releasesDir}/<its RELEASE_SHA>, not ${root}`);
  }
  return sha;
}

function openSessionLogOnDisk(dir: string): (line: string) => void {
  nodeFs.mkdirSync(dir, { recursive: true, mode: 0o700 });
  const st = nodeFs.lstatSync(dir);
  if (st.isSymbolicLink() || !st.isDirectory()) throw new Error(`${dir} is not a directory`);
  if (typeof process.getuid === 'function' && st.uid !== process.getuid()) throw new Error(`${dir} is not owned by this user`);
  if ((st.mode & 0o077) !== 0) throw new Error(`${dir} must be mode 0700`);
  const file = `${dir}/deploy.log`;
  return (line) => {
    nodeFs.appendFileSync(file, `${line}\n`, { mode: 0o600 });
  };
}

export const realCliDeps: CliDeps = {
  write: (line) => {
    process.stdout.write(`${line}\n`);
  },
  resolveToolSha: resolveToolShaFromDisk,
  openSessionLog: openSessionLogOnDisk,
  createReadPorts,
  createDeployPorts,
};

export async function runCli(argv: readonly string[], deps: CliDeps): Promise<number> {
  let opts: CliOptions;
  try {
    opts = parseArgs(argv);
  } catch (err) {
    deps.write(JSON.stringify({ event: 'usage_error', message: err instanceof Error ? err.message : String(err) }));
    return 64;
  }
  const toolSha = deps.resolveToolSha();
  // plan and verify-identity log to stdout only; execute/rollback also keep a session log.
  const append = opts.command === 'execute' || opts.command === 'rollback' ? deps.openSessionLog(opts.sessionDir ?? '') : null;
  const log = (event: string, data?: Record<string, unknown>) => {
    const line = JSON.stringify({ ts: new Date().toISOString(), event, ...data });
    deps.write(line);
    append?.(line);
  };
  log('deploy_tool_start', { command: opts.command, tool: toolSha });
  const zero = '0'.repeat(64);
  const base = {
    layout: TARGET_LAYOUT,
    toolSha,
    rpcUrls: opts.rpcUrls,
    log,
    expectedManifestSha256: opts.expectedManifestSha256 ?? zero,
    releaseSha: opts.expectedReleaseSha ?? opts.expectedPreviousSha ?? toolSha,
    previousSha: opts.expectedPreviousSha ?? toolSha,
  };

  if (opts.command === 'verify-identity') {
    const ports = deps.createDeployPorts(base);
    try {
      const id = await ports.probeIdentity();
      const ok = id.executor === normalizeAddress(opts.expectedExecutor ?? '') && id.chainId === opts.expectedChainId;
      log('identity', { configuredExecutor: id.executor, configuredChainId: id.chainId, matches: ok });
      return ok ? 0 : 2;
    } catch (err) {
      log('identity_failed', { message: err instanceof Error ? err.message : String(err) });
      return 2;
    }
  }

  let outcome: DeployOutcome;
  if (opts.command === 'rollback') {
    outcome = await runRollback({ expectedPreviousSha: opts.expectedPreviousSha ?? '', rollbackDir: opts.rollbackDir ?? '' }, deps.createDeployPorts(base));
  } else {
    const input = {
      expectedReleaseSha: opts.expectedReleaseSha ?? '',
      expectedPreviousSha: opts.expectedPreviousSha ?? '',
      expectedExecutor: opts.expectedExecutor ?? '',
      expectedChainId: opts.expectedChainId ?? 0,
    };
    outcome = opts.command === 'plan' ? await runPlan(input, deps.createReadPorts(base)) : await runDeployment(input, deps.createDeployPorts(base));
  }
  log('deploy_tool_result', { status: outcome.status, abortedAt: outcome.abortedAt, service: outcome.service, needsVerification: outcome.needsVerification, rollbackDir: outcome.rollbackDir });
  return exitCodeFor(outcome);
}

if (require.main === module) {
  runCli(process.argv.slice(2), realCliDeps).then(
    (code) => {
      process.exitCode = code;
    },
    (err: unknown) => {
      process.stderr.write(`deploy tool failed: ${err instanceof Error ? err.message : String(err)}\n`);
      process.exitCode = 1;
    },
  );
}
