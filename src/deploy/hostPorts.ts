import { execFile } from 'node:child_process';
import { createHash } from 'node:crypto';
import * as nodeFs from 'node:fs';
import { createPublicClient, http } from 'viem';
import { forbiddenTopLevelReason, isFullCommitSha, normalizeAddress, type AppliedMigration, type DbSnapshot, type EntryType, type GateResult, type HealthFacts, type LayoutFacts, type MigrationRecord, type NonceObservation, type QuiescenceFacts, type RollbackSnapshot, type RollbackSourceFacts, type ServiceSnapshot } from './gate';
import { ROOT_SEAL, verifyRelease, type ManifestFs, type SealPolicy } from './releaseManifest';
import type { DeployPorts, ReadPorts, StagedRelease } from './pipeline';

/**
 * The production host's side of the deployment ports.
 *
 * Runs as `lunex-admin`, whose passwordless sudo is a fixed binary whitelist.
 * Every privileged call is `sudo -n <absolute whitelisted binary> <fixed argv>`
 * through `execFile` -- no shell, no command string, nothing user-supplied that
 * is not validated to a fixed shape (40-hex SHAs, the rollback-dir pattern, a
 * 0x+40-hex address, a 32-hex invocation id, a journal cursor).
 *
 * ## Symlink safety (H-1)
 *
 * The production tree is owned by the service account. Root never follows
 * anything the service account could plant:
 *   - every copy is `rsync -a ... -- <srcRoot>/<item> <dstRoot>/` (NO trailing
 *     slash on the item): the transfer root is the destination root directory
 *     itself, and rsync without --keep-dirlinks REPLACES a symlink found
 *     anywhere below it instead of writing through it (verified: top-level dir,
 *     nested dir and file symlinks are all replaced, the target untouched);
 *   - ownership is set by `rsync --chown` on the receiving side; the `chown`
 *     binary (which dereferences a symlink argument) is never invoked;
 *   - before the first write the service is stopped and start-locked, no
 *     process of the service account exists (so nothing can race a swap), and
 *     the production root, its ancestors and every top-level entry are checked
 *     to be plain files/directories.
 *
 * ## Plan purity (M-5)
 *
 * `createReadPorts` wraps the runner in `readOnlyRunner`, which refuses any
 * invocation that is not a known read (systemctl show, rsync --list-only,
 * sqlite3 -readonly SELECT/PRAGMA *_check, journalctl). The ports touch the
 * filesystem only through `HostFs`, which has no write methods.
 */

export const BIN = {
  sudo: '/usr/bin/sudo',
  systemctl: '/usr/bin/systemctl',
  journalctl: '/usr/bin/journalctl',
  sqlite3: '/usr/bin/sqlite3',
  rsync: '/usr/bin/rsync',
  mkdir: '/usr/bin/mkdir',
  install: '/usr/bin/install',
} as const;

export interface HostLayout {
  prodDir: string;
  dbPath: string;
  releasesDir: string;
  rollbackRoot: string;
  service: string;
  identityUnitPrefix: string;
  lockDir: string;
  lockPath: string;
  procRoot: string;
}

export const TARGET_LAYOUT: HostLayout = {
  prodDir: '/opt/lunex/production/lunex-bot',
  dbPath: '/opt/lunex/production/lunex-bot/data/lunex.db',
  releasesDir: '/opt/lunex/releases',
  rollbackRoot: '/opt/lunex/rollback',
  service: 'lunex-bot',
  identityUnitPrefix: 'lunex-deploy-identity@',
  lockDir: '/run/systemd/system/lunex-bot.service.d',
  lockPath: '/run/systemd/system/lunex-bot.service.d/50-lunex-deploy-lock.conf',
  procRoot: '/proc',
};

/**
 * Runtime drop-in that makes every start of lunex-bot.service fail while a
 * deployment holds the service stopped. A runtime `mask` does NOT work here --
 * the unit file lives in /etc/systemd/system, which outranks /run -- but drop-ins
 * from every directory are merged, so this assertion applies. Byte-identical to
 * ops/deploy/lunex-bot-deploy-lock.conf.
 */
export const START_LOCK_CONTENT = '[Unit]\nAssertPathExists=/nonexistent/lunex-deployment-in-progress\n';

/** Never carried into, deleted from, or restored over production. */
export const FORBIDDEN_ITEMS = new Set(['.env', 'data', 'logs', '.cache', '.config', '.npm', '.npm-cache', '.home', '.lunex-release']);
const OPS_EXCLUDE = '--exclude=/ops/lunex-bot/';

export interface RunResult {
  stdout: string;
}

/** Executes one binary with a fixed argv. Injected so tests can record calls. */
export type Runner = (file: string, args: readonly string[], timeoutMs?: number) => Promise<RunResult>;

export const execRunner: Runner = (file, args, timeoutMs = 120_000) =>
  new Promise((resolve, reject) => {
    execFile(file, args, { timeout: timeoutMs, maxBuffer: 64 * 1024 * 1024, env: { PATH: '/usr/bin:/bin', LANG: 'C.UTF-8' } }, (error, stdout, stderr) => {
      if (error) {
        reject(new Error(`${file} ${args.join(' ')} failed: ${error.message}${stderr ? ` -- ${stderr.trim().slice(0, 400)}` : ''}`));
        return;
      }
      resolve({ stdout });
    });
  });

const READ_SQL = /^\s*(SELECT\b|PRAGMA\s+(integrity|quick)_check\s*;?\s*$)/i;
const WRITE_SQL = /\b(writefile|edit|load_extension|attach|detach|insert|update|delete|replace|create|drop|alter|vacuum|reindex)\b|^\s*\./i;

/** True only for invocations that cannot change host state. */
export function isReadOnlyInvocation(file: string, args: readonly string[]): boolean {
  if (file === BIN.systemctl) return args[0] === 'show';
  if (file !== BIN.sudo || args[0] !== '-n') return false;
  const [, bin, ...rest] = args;
  if (bin === BIN.rsync) return rest[0] === '--list-only';
  if (bin === BIN.journalctl) return !rest.some((a) => /^--(rotate|vacuum|flush|sync|relinquish|setup-keys|update-catalog)/.test(a));
  if (bin === BIN.sqlite3) {
    const sql = rest.at(-1) ?? '';
    return rest.includes('-readonly') && READ_SQL.test(sql) && !WRITE_SQL.test(sql.replace(/'[^']*'/g, "''"));
  }
  return false;
}

/** Refuses (throws) every invocation `isReadOnlyInvocation` does not accept. */
export function readOnlyRunner(run: Runner): Runner {
  return (file, args, timeoutMs) => {
    if (!isReadOnlyInvocation(file, args)) return Promise.reject(new Error(`read-only mode refused: ${file} ${args.join(' ')}`));
    return run(file, args, timeoutMs);
  };
}

function sudo(run: Runner, bin: string, args: readonly string[], timeoutMs?: number): Promise<RunResult> {
  return run(BIN.sudo, ['-n', bin, ...args], timeoutMs);
}

/** Read-only filesystem access; deliberately has no write methods. */
export interface HostFs extends ManifestFs {
  readdirSync(path: string): string[];
  readTextFile(path: string): string;
  statUid(path: string): number;
}

export const nodeHostFs: HostFs = {
  lstatSync: (p) => nodeFs.lstatSync(p),
  readdirSync: (p) => nodeFs.readdirSync(p),
  readFileSync: (p) => nodeFs.readFileSync(p),
  readlinkSync: (p) => nodeFs.readlinkSync(p),
  readTextFile: (p) => nodeFs.readFileSync(p, 'utf8'),
  statUid: (p) => nodeFs.statSync(p).uid,
};

/** Endpoint label safe to log: host only (a URL path can embed a provider key). */
export function rpcLabel(url: string, index: number): string {
  try {
    return `rpc#${index + 1}(${new URL(url).host})`;
  } catch {
    return `rpc#${index + 1}`;
  }
}

/** Removes URLs from error text so a provider key in an RPC path never reaches a log. */
export function redactUrls(message: string): string {
  return message.replace(/https?:\/\/[^\s"'<>]+/gi, '<url>');
}

export type ServiceDetail = ServiceSnapshot & { invocationId: string; dropInPaths: string; result: string };

export function parseSystemctlShow(stdout: string): ServiceDetail {
  const kv = new Map<string, string>();
  for (const line of stdout.split('\n')) {
    const i = line.indexOf('=');
    if (i > 0) kv.set(line.slice(0, i), line.slice(i + 1).trim());
  }
  const num = (k: string) => {
    const raw = kv.get(k);
    const v = raw === undefined || raw === '' ? Number.NaN : Number(raw);
    return Number.isSafeInteger(v) ? v : -1;
  };
  return {
    activeState: kv.get('ActiveState') ?? '',
    subState: kv.get('SubState') ?? '',
    mainPid: num('MainPID'),
    nRestarts: num('NRestarts'),
    invocationId: kv.get('InvocationID') ?? '',
    dropInPaths: kv.get('DropInPaths') ?? '',
    result: kv.get('Result') ?? '',
  };
}

/** The identity probe's JSON line; anything else is rejected. */
export function parseIdentityJournal(stdout: string): { executor: string; chainId: number } {
  const lines = stdout.split('\n').map((l) => l.trim()).filter((l) => l.startsWith('{'));
  for (const line of lines.reverse()) {
    let parsed: unknown;
    try {
      parsed = JSON.parse(line);
    } catch {
      continue;
    }
    if (typeof parsed !== 'object' || parsed === null) continue;
    const p = parsed as Record<string, unknown>;
    if (p.event !== 'deploy_identity') continue;
    const executor = typeof p.executor === 'string' ? normalizeAddress(p.executor) : null;
    if (executor === null || typeof p.chainId !== 'number' || !Number.isSafeInteger(p.chainId)) throw new Error('identity probe output is malformed');
    return { executor, chainId: p.chainId };
  }
  throw new Error('identity probe printed no deploy_identity line');
}

export interface ListingEntry {
  name: string;
  type: EntryType;
  size: number;
}

/** Parses `rsync --list-only` output: "<perms> <size> <date> <time> <name>[ -> target]". */
export function parseListing(stdout: string): ListingEntry[] {
  const out: ListingEntry[] = [];
  for (const line of stdout.split('\n')) {
    const m = /^([-dlcbps])\S{9}\s+([\d,]+)\s+\S+\s+\S+\s(.+)$/.exec(line);
    if (!m?.[1] || !m[2] || m[3] === undefined) continue;
    const t = m[1];
    const type: EntryType = t === 'd' ? 'd' : t === '-' ? 'f' : t === 'l' ? 'l' : 'other';
    const name = type === 'l' ? m[3].split(' -> ')[0] ?? m[3] : m[3];
    if (name === '.') continue;
    out.push({ name, type, size: Number(m[2].replace(/,/g, '')) });
  }
  return out;
}

/** Copy one top-level item into dstRoot without ever writing through a symlink (see module doc). */
export function itemRsyncArgs(srcRoot: string, dstRoot: string, item: string, extra: readonly string[]): string[] {
  if (item === '' || item.includes('/') || item === '.' || item === '..' || FORBIDDEN_ITEMS.has(item) || forbiddenTopLevelReason(item) !== null) {
    throw new Error(`refusing item name ${JSON.stringify(item)}`);
  }
  return [...extra, ...(item === 'ops' ? [OPS_EXCLUDE] : []), '--', `${srcRoot}/${item}`, `${dstRoot}/`];
}

function sqlQuote(s: string): string {
  return `'${s.replace(/'/g, "''")}'`;
}

const ROLLBACK_NAME_RE = /^([0-9a-f]{40})-\d{8}T\d{6}Z$/;
// journald cursor: s=<seqnum id>;i=<seqnum>;b=<boot id>;m=<monotonic>;t=<realtime>;x=<xor hash>
const CURSOR_RE = /^s=[0-9a-f]{32};i=[0-9a-f]{1,16};b=[0-9a-f]{32};m=[0-9a-f]{1,16};t=[0-9a-f]{1,16};x=[0-9a-f]{1,16}$/;

/** The two chain reads the gate needs; a viem PublicClient satisfies it. */
export interface ChainClient {
  getChainId(): Promise<number>;
  getTransactionCount(args: { address: `0x${string}`; blockTag: 'latest' | 'pending' }): Promise<number>;
}

export interface HostPortsConfig {
  layout: HostLayout;
  releaseSha: string;
  previousSha: string;
  /** RELEASE_SHA of the deploy tool's own sealed release (identity unit instance, lock source). */
  toolSha: string;
  expectedManifestSha256: string;
  rpcUrls: readonly string[];
  log: (event: string, data?: Record<string, unknown>) => void;
  run?: Runner;
  /** Test seam: chain readers in place of real RPC clients built from rpcUrls. */
  chainClients?: readonly { label: string; client: ChainClient }[];
  fs?: HostFs;
  seal?: SealPolicy;
  now?: () => Date;
  sleep?: (ms: number) => Promise<void>;
  healthWindowSeconds?: number;
}

function validateConfig(cfg: HostPortsConfig): void {
  for (const sha of [cfg.releaseSha, cfg.previousSha, cfg.toolSha]) if (!isFullCommitSha(sha)) throw new Error('release, previous and tool SHAs must be full 40-hex commit ids');
}

/** Read ports, shared by plan (behind readOnlyRunner) and execute. */
function buildReadPorts(
  cfg: HostPortsConfig,
  run: Runner,
): ReadPorts & { readSmallRootFile(path: string): Promise<string>; listing(path: string): Promise<ListingEntry[]>; readServiceDetail(): Promise<ServiceDetail> } {
  validateConfig(cfg);
  const fs = cfg.fs ?? nodeHostFs;
  const L = cfg.layout;
  const releaseDir = `${L.releasesDir}/${cfg.releaseSha}`;
  const clients: readonly { label: string; client: ChainClient }[] = cfg.chainClients ?? cfg.rpcUrls.map((url, i) => ({
    label: rpcLabel(url, i),
    client: createPublicClient({ transport: http(url, { retryCount: 0, timeout: 20_000, fetchOptions: { headers: { 'user-agent': 'lunex-deploy-gate/2' } } }) }),
  }));
  const rpc = async <T>(fn: () => Promise<T>): Promise<T> => {
    try {
      return await fn();
    } catch (err) {
      throw new Error(redactUrls(err instanceof Error ? err.message : String(err)));
    }
  };
  const sqlite = async (db: string, sql: string, json: boolean): Promise<string> => (await sudo(run, BIN.sqlite3, ['-readonly', '-batch', ...(json ? ['-json'] : []), db, sql])).stdout;
  const listing = async (path: string): Promise<ListingEntry[]> => parseListing((await sudo(run, BIN.rsync, ['--list-only', '--', path])).stdout);

  /**
   * Reads a small root-only file WITHOUT copying it anywhere (M-1): the type is
   * checked to be a regular file first, then sqlite3's readfile() returns the
   * bytes on stdout. There is no intermediate file, so no stale value can exist.
   */
  const readSmallRootFile = async (path: string): Promise<string> => {
    const entries = await listing(path);
    const [only] = entries;
    if (entries.length !== 1 || !only || only.type !== 'f') throw new Error(`${path} is not a regular file (${entries.map((e) => e.type).join(',') || 'missing'})`);
    if (only.size > 4096) throw new Error(`${path} is unexpectedly large (${only.size} bytes)`);
    const out = (await sqlite(':memory:', `SELECT CAST(readfile(${sqlQuote(path)}) AS TEXT);`, false)).trim();
    if (out === '') throw new Error(`${path} could not be read`);
    return out;
  };

  const readService = async () =>
    parseSystemctlShow((await run(BIN.systemctl, ['show', L.service, '-p', 'ActiveState', '-p', 'SubState', '-p', 'MainPID', '-p', 'NRestarts', '-p', 'InvocationID', '-p', 'DropInPaths'])).stdout);

  const readDb = async (): Promise<DbSnapshot> => {
    const integrity = (await sqlite(L.dbPath, 'PRAGMA integrity_check;', false)).trim();
    const out = await sqlite(
      L.dbPath,
      `SELECT (SELECT MIN(paused) FROM "BotSettings") AS paused,
        (SELECT COUNT(*) FROM "Position" WHERE status='OPENING') AS opening,
        (SELECT COUNT(*) FROM "Position" WHERE status='ACTIVE') AS active,
        (SELECT COUNT(*) FROM "Position" WHERE status='CLOSING') AS closing,
        (SELECT COUNT(*) FROM "TransactionAttempt" WHERE status NOT IN ('VERIFIED','FAILED')) AS nonTerminal,
        (SELECT CAST(IFNULL(SUM(CAST(entryUsdgRaw AS INTEGER)),0) AS TEXT) FROM "Position" WHERE status IN ('OPENING','ACTIVE','CLOSING')) AS capital,
        (SELECT COUNT(*) FROM "_prisma_migrations" WHERE finished_at IS NULL OR rolled_back_at IS NOT NULL) AS unfinished;`,
      true,
    );
    const row = (JSON.parse(out) as Record<string, unknown>[])[0];
    if (!row) throw new Error('database summary query returned no row');
    const n = (k: string) => {
      const v = row[k];
      return typeof v === 'number' ? v : -1;
    };
    return {
      integrity,
      paused: typeof row.paused === 'number' ? row.paused : null,
      opening: n('opening'),
      active: n('active'),
      closing: n('closing'),
      nonTerminalAttempts: n('nonTerminal'),
      deployedCapitalRaw: typeof row.capital === 'string' ? row.capital : 'unknown',
      unfinishedMigrations: n('unfinished'),
    };
  };

  const rootOnlyDir = (path: string, mask: number): boolean => {
    try {
      const st = fs.lstatSync(path);
      if (!st.isDirectory() || st.isSymbolicLink() || (st.mode & mask) !== 0) return false;
      return cfg.seal?.requiredOwner === null ? true : st.uid === 0;
    } catch {
      return false;
    }
  };

  return {
    log: cfg.log,
    listing,
    readSmallRootFile,
    readService,
    readServiceDetail: readService,
    readDb,

    async readChainIds() {
      return Promise.all(clients.map(async ({ label, client }) => ({ source: label, chainId: await rpc(() => client.getChainId()) })));
    },

    async readNonces(address: string): Promise<NonceObservation[]> {
      const a = normalizeAddress(address);
      if (a === null) throw new Error(`not an address: ${address}`);
      return Promise.all(
        clients.map(async ({ label, client }) => {
          const [latest, pending] = await Promise.all([
            rpc(() => client.getTransactionCount({ address: a as `0x${string}`, blockTag: 'latest' })),
            rpc(() => client.getTransactionCount({ address: a as `0x${string}`, blockTag: 'pending' })),
          ]);
          return { source: label, latest, pending };
        }),
      );
    },

    async readLedgerMaxNonce(executor: string) {
      // Validated to 0x+40 hex before it is placed in the SQL text.
      const a = normalizeAddress(executor);
      if (a === null) throw new Error(`not an address: ${executor}`);
      const out = await sqlite(L.dbPath, `SELECT MAX(nonce) AS m FROM "TransactionAttempt" WHERE lower(executorAddress) = '${a}' AND nonce IS NOT NULL;`, true);
      const row = (JSON.parse(out) as { m: unknown }[])[0];
      if (!row) throw new Error('ledger query returned no row');
      if (row.m === null) return null;
      if (typeof row.m !== 'number') throw new Error('ledger max nonce is not a number');
      return row.m;
    },

    async readDeployedReleaseSha() {
      return readSmallRootFile(`${L.prodDir}/RELEASE_SHA`);
    },

    readStagedRelease(): Promise<StagedRelease> {
      const meta = `${releaseDir}/.lunex-release`;
      const v = verifyRelease(releaseDir, cfg.expectedManifestSha256, cfg.seal ?? ROOT_SEAL, fs);
      let artifactCommitId = '';
      let stagedReleaseSha = '';
      try {
        artifactCommitId = fs.readTextFile(`${meta}/commit-id`).trim();
        stagedReleaseSha = fs.readTextFile(`${releaseDir}/RELEASE_SHA`).trim();
      } catch (err) {
        v.problems.push(`release metadata unreadable: ${err instanceof Error ? err.message : String(err)}`);
      }
      // The actual top level of the release tree (lstat, never the manifest), for the layout gate.
      const topLevel: { name: string; type: EntryType }[] = [];
      try {
        for (const name of fs.readdirSync(releaseDir)) {
          const st = fs.lstatSync(`${releaseDir}/${name}`);
          topLevel.push({ name, type: st.isSymbolicLink() ? 'l' : st.isDirectory() ? 'd' : st.isFile() ? 'f' : 'other' });
        }
      } catch (err) {
        v.problems.push(`release tree unreadable: ${err instanceof Error ? err.message : String(err)}`);
      }
      return Promise.resolve({ artifactCommitId, stagedReleaseSha, manifestVerified: v.ok && v.problems.length === 0, manifestProblems: v.problems, items: v.items, topLevel });
    },

    async readSchema(): Promise<{ release: MigrationRecord[]; db: AppliedMigration[] }> {
      const dir = `${releaseDir}/prisma/migrations`;
      const release: MigrationRecord[] = [];
      for (const name of fs.readdirSync(dir).sort()) {
        if (!/^\d{14}_[a-z0-9_]+$/.test(name)) continue;
        const sqlPath = `${dir}/${name}/migration.sql`;
        const st = fs.lstatSync(sqlPath);
        if (!st.isFile() || st.isSymbolicLink()) throw new Error(`${name}/migration.sql is not a regular file`);
        release.push({ name, checksum: createHash('sha256').update(fs.readFileSync(sqlPath)).digest('hex') });
      }
      const out = await sqlite(
        L.dbPath,
        'SELECT migration_name AS name, checksum, (finished_at IS NOT NULL) AS finished, (rolled_back_at IS NOT NULL) AS rolledBack FROM "_prisma_migrations" ORDER BY migration_name;',
        true,
      );
      const rows = out.trim() === '' ? [] : (JSON.parse(out) as { name: unknown; checksum: unknown; finished: unknown; rolledBack: unknown }[]);
      const db = rows.map((r) => {
        if (typeof r.name !== 'string' || typeof r.checksum !== 'string') throw new Error('malformed _prisma_migrations row');
        return { name: r.name, checksum: r.checksum, finished: r.finished === 1, rolledBack: r.rolledBack === 1 };
      });
      return { release, db };
    },

    async readProdLayout(): Promise<LayoutFacts> {
      let rootIsRealDirectory = false;
      try {
        const st = fs.lstatSync(L.prodDir);
        rootIsRealDirectory = st.isDirectory() && !st.isSymbolicLink();
      } catch {
        rootIsRealDirectory = false;
      }
      const parts = L.prodDir.split('/').filter((p) => p !== '');
      const ancestors = ['/', ...parts.slice(0, -1).map((_, i) => `/${parts.slice(0, i + 1).join('/')}`)];
      const unsafeAncestors = ancestors.filter((a) => !rootOnlyDir(a, 0o022));
      const entries = rootIsRealDirectory ? (await listing(`${L.prodDir}/`)).map((e) => ({ name: e.name, type: e.type })) : [];
      return { rootIsRealDirectory, unsafeAncestors, entries };
    },

    async readQuiescence(cursor: string): Promise<QuiescenceFacts> {
      if (!CURSOR_RE.test(cursor)) throw new Error('invalid journal cursor');
      const service = await readService();
      // Every process owned by the service account (the owner of the production root).
      const uid = fs.lstatSync(L.prodDir).uid;
      if (uid === 0) throw new Error('production root is owned by root -- cannot identify the service account');
      const serviceAccountPids: number[] = [];
      for (const name of fs.readdirSync(L.procRoot)) {
        if (!/^\d+$/.test(name)) continue;
        try {
          if (fs.statUid(`${L.procRoot}/${name}`) === uid) serviceAccountPids.push(Number(name));
        } catch {
          // the process exited between readdir and stat
        }
      }
      const journal = (await sudo(run, BIN.journalctl, ['-u', `${L.service}.service`, `--after-cursor=${cursor}`, '-o', 'cat', '--no-pager'])).stdout;
      const journalEntriesSinceStop = journal.split('\n').filter((l) => l.trim() !== '').length;
      let lockFile = '';
      try {
        const st = fs.lstatSync(L.lockPath);
        if (st.isFile() && !st.isSymbolicLink() && (cfg.seal?.requiredOwner === null || st.uid === 0)) lockFile = fs.readTextFile(L.lockPath);
      } catch {
        lockFile = '';
      }
      const startLockActive = lockFile === START_LOCK_CONTENT && service.dropInPaths.split(/\s+/).includes(L.lockPath);
      return { service, serviceAccountPids, journalEntriesSinceStop, startLockActive };
    },

    async readRollbackSource(dir: string): Promise<RollbackSourceFacts> {
      const prefix = `${L.rollbackRoot}/`;
      const name = dir.startsWith(prefix) ? dir.slice(prefix.length) : '';
      const nameSha = ROLLBACK_NAME_RE.exec(name)?.[1] ?? null;
      const facts: RollbackSourceFacts = { dir, nameSha, rootSafe: false, dirType: 'missing', appType: 'missing', snapshotReleaseSha: null, items: [], forbiddenItems: [] };
      if (nameSha === null) return facts;
      facts.rootSafe = rootOnlyDir(L.rollbackRoot, 0o077);
      if (!facts.rootSafe) return facts;
      facts.dirType = (await listing(`${L.rollbackRoot}/`)).find((e) => e.name === name)?.type ?? 'missing';
      if (facts.dirType !== 'd') return facts;
      facts.appType = (await listing(`${dir}/`)).find((e) => e.name === 'app')?.type ?? 'missing';
      if (facts.appType !== 'd') return facts;
      facts.snapshotReleaseSha = await readSmallRootFile(`${dir}/app/RELEASE_SHA`).catch(() => null);
      const items = (await listing(`${dir}/app/`)).map((e) => ({ name: e.name, type: e.type }));
      facts.items = items.filter((i) => !FORBIDDEN_ITEMS.has(i.name));
      facts.forbiddenItems = items.filter((i) => FORBIDDEN_ITEMS.has(i.name)).map((i) => i.name);
      return facts;
    },
  };
}

/** Plan: every command passes through readOnlyRunner; no filesystem writes exist. */
export function createReadPorts(cfg: HostPortsConfig): ReadPorts {
  return buildReadPorts(cfg, readOnlyRunner(cfg.run ?? execRunner));
}

export function createDeployPorts(cfg: HostPortsConfig): DeployPorts {
  const run = cfg.run ?? execRunner;
  const read = buildReadPorts(cfg, run);
  const fs = cfg.fs ?? nodeHostFs;
  const L = cfg.layout;
  const now = cfg.now ?? (() => new Date());
  const sleep = cfg.sleep ?? ((ms: number) => new Promise<void>((r) => setTimeout(r, ms)));
  const releaseDir = `${L.releasesDir}/${cfg.releaseSha}`;
  const toolLockSource = `${L.releasesDir}/${cfg.toolSha}/ops/deploy/lunex-bot-deploy-lock.conf`;
  let rollbackDir: string | undefined;
  let envStatAtSnapshot: string | undefined;

  const identical = async (a: string, b: string): Promise<boolean> =>
    (await sudo(run, BIN.rsync, ['-a', '--checksum', '--dry-run', '--itemize-changes', '--', a, b])).stdout.trim() === '';
  const listOne = async (path: string): Promise<string> => (await sudo(run, BIN.rsync, ['--list-only', '--', path])).stdout.trim();
  const daemonReload = () => sudo(run, BIN.systemctl, ['daemon-reload']);

  return {
    ...read,

    async probeIdentity() {
      const unit = `${L.identityUnitPrefix}${cfg.toolSha}.service`;
      // Stop first so `start` is a fresh run (RemainAfterExit keeps a finished probe "active").
      await sudo(run, BIN.systemctl, ['stop', unit], 60_000);
      await sudo(run, BIN.systemctl, ['start', unit], 90_000);
      const s = parseSystemctlShow((await run(BIN.systemctl, ['show', unit, '-p', 'ActiveState', '-p', 'SubState', '-p', 'Result', '-p', 'InvocationID'])).stdout);
      try {
        if (s.activeState !== 'active' || s.subState !== 'exited' || s.result !== 'success') throw new Error(`identity probe ended ${s.activeState}/${s.subState}/${s.result}`);
        if (!/^[0-9a-f]{32}$/.test(s.invocationId)) throw new Error('identity probe has no invocation id');
        const out = await sudo(run, BIN.journalctl, [`_SYSTEMD_INVOCATION_ID=${s.invocationId}`, '-o', 'cat', '--no-pager']);
        return parseIdentityJournal(out.stdout);
      } finally {
        await sudo(run, BIN.systemctl, ['stop', unit], 60_000);
      }
    },

    async lockStart() {
      const st = fs.lstatSync(toolLockSource);
      if (!st.isFile() || st.isSymbolicLink() || fs.readTextFile(toolLockSource) !== START_LOCK_CONTENT) throw new Error('the tool release lock drop-in is missing or altered');
      await sudo(run, BIN.mkdir, ['-p', '-m', '0755', '--', L.lockDir]);
      await sudo(run, BIN.install, ['-m', '0644', '-o', 'root', '-g', 'root', '--', toolLockSource, L.lockPath]);
      await daemonReload();
      const s = await read.readServiceDetail();
      if (!s.dropInPaths.split(/\s+/).includes(L.lockPath) || fs.readTextFile(L.lockPath) !== START_LOCK_CONTENT) throw new Error('start lock did not take effect');
    },

    async unlockStart() {
      // Neutralise the drop-in (an empty drop-in has no effect); the whitelist has no rm.
      await sudo(run, BIN.install, ['-m', '0644', '-o', 'root', '-g', 'root', '--', '/dev/null', L.lockPath]);
      await daemonReload();
      if (fs.readTextFile(L.lockPath) !== '') throw new Error('start lock was not released');
    },

    async stopService() {
      await sudo(run, BIN.systemctl, ['stop', L.service], 120_000);
    },

    async captureJournalCursor() {
      const out = (await sudo(run, BIN.journalctl, ['-u', `${L.service}.service`, '-n', '0', '--show-cursor', '--no-pager'])).stdout;
      const cursor = /^-- cursor: (\S+)$/m.exec(out)?.[1] ?? '';
      if (!CURSOR_RE.test(cursor)) throw new Error('could not capture a journal cursor');
      return cursor;
    },

    async snapshotRollback(items): Promise<RollbackSnapshot> {
      const stamp = now().toISOString().replace(/[-:]/g, '').replace(/\.\d+Z$/, 'Z');
      const dir = `${L.rollbackRoot}/${cfg.previousSha}-${stamp}`;
      await sudo(run, BIN.mkdir, ['-p', '-m', '0700', '--', L.rollbackRoot]);
      const rst = fs.lstatSync(L.rollbackRoot);
      if (!rst.isDirectory() || rst.isSymbolicLink() || (rst.mode & 0o077) !== 0 || (cfg.seal?.requiredOwner !== null && rst.uid !== 0)) throw new Error(`${L.rollbackRoot} is not a root-owned 0700 directory`);
      await sudo(run, BIN.mkdir, ['-m', '0700', '--', dir]); // no -p: never reuse a directory
      await sudo(run, BIN.mkdir, ['-m', '0700', '--', `${dir}/app`]);
      rollbackDir = dir;
      cfg.log('rollback_dir', { dir });

      const data = await read.listing(`${L.prodDir}/data/`);
      if (data.some((e) => /^lunex\.db-(journal|wal)$/.test(e.name))) throw new Error('journal/WAL present next to the production DB');
      // data/ is writable by the (sandboxed) service: a planted symlink would make
      // the "backup" a link and its integrity_check read some other file.
      if (data.find((e) => e.name === 'lunex.db')?.type !== 'f') throw new Error('the production DB is not a regular file');
      await sudo(run, BIN.rsync, ['-a', '--', L.dbPath, `${dir}/production.db`], 300_000);
      const dbCopyIdentical = await identical(L.dbPath, `${dir}/production.db`);
      const dbCopyIntegrity = (await sudo(run, BIN.sqlite3, ['-readonly', '-batch', `${dir}/production.db`, 'PRAGMA integrity_check;'])).stdout.trim();

      const prodEntries = new Set((await read.listing(`${L.prodDir}/`)).map((e) => e.name));
      let appCopyVerified = true;
      for (const { name } of items) {
        if (!prodEntries.has(name)) {
          cfg.log('rollback_item_absent', { item: name });
          continue;
        }
        await sudo(run, BIN.rsync, itemRsyncArgs(L.prodDir, `${dir}/app`, name, ['-a', '--delete']), 900_000);
        const diff = await sudo(run, BIN.rsync, itemRsyncArgs(L.prodDir, `${dir}/app`, name, ['-a', '--delete', '--checksum', '--dry-run', '--itemize-changes']), 900_000);
        if (diff.stdout.trim() !== '') appCopyVerified = false;
      }
      envStatAtSnapshot = await listOne(`${L.prodDir}/.env`);
      return { dir, appCopyVerified, dbCopyIdentical, dbCopyIntegrity };
    },

    async dbUnchangedSinceSnapshot() {
      if (!rollbackDir) throw new Error('no rollback snapshot taken');
      return identical(L.dbPath, `${rollbackDir}/production.db`);
    },

    async replaceArtifact(items) {
      for (const { name } of items) {
        await sudo(run, BIN.rsync, itemRsyncArgs(releaseDir, L.prodDir, name, ['-a', '--delete', '--chown=lunex-bot:lunex-bot']), 900_000);
      }
    },

    async verifyDeployed(items): Promise<GateResult> {
      const gate = 'verify-deployed';
      const drift: string[] = [];
      for (const { name } of items) {
        // -rlpt: content, links, perms, times -- ownership intentionally differs (root -> lunex-bot).
        const out = await sudo(run, BIN.rsync, itemRsyncArgs(releaseDir, L.prodDir, name, ['-rlpt', '--delete', '--checksum', '--dry-run', '--itemize-changes']), 900_000);
        if (out.stdout.trim() !== '') drift.push(name);
      }
      const deployed = await read.readDeployedReleaseSha();
      const envNow = await listOne(`${L.prodDir}/.env`);
      if (drift.length > 0) return { gate, level: 'fail', code: 'DEPLOYED_DRIFT', message: `deployed items differ from the verified release: ${drift.join(', ')}` };
      if (deployed !== cfg.releaseSha) return { gate, level: 'fail', code: 'DEPLOYED_SHA_MISMATCH', message: `production RELEASE_SHA is ${deployed}, expected ${cfg.releaseSha}` };
      if (envStatAtSnapshot === undefined || envNow !== envStatAtSnapshot) return { gate, level: 'fail', code: 'ENV_CHANGED', message: '.env size/mtime changed during the deployment' };
      return { gate, level: 'pass', code: 'DEPLOYED_MATCH', message: `production matches the verified release ${cfg.releaseSha}; .env untouched` };
    },

    async startService() {
      await sudo(run, BIN.systemctl, ['start', L.service], 120_000);
    },

    async collectHealth(): Promise<HealthFacts> {
      const s0 = await read.readServiceDetail();
      await sleep((cfg.healthWindowSeconds ?? 90) * 1000);
      const s1 = await read.readServiceDetail();
      const events: string[] = [];
      const errorEvents: { event: string; messageClass: string }[] = [];
      let fatalStartupLines = 0;
      let signingLines = 0;
      if (/^[0-9a-f]{32}$/.test(s0.invocationId)) {
        const log = (await sudo(run, BIN.journalctl, [`_SYSTEMD_INVOCATION_ID=${s0.invocationId}`, '-o', 'cat', '--no-pager'])).stdout;
        for (const line of log.split('\n')) {
          if (line.includes('[lunex-bot] fatal startup error')) fatalStartupLines += 1;
          if (/signTransaction|sendRawTransaction/.test(line)) signingLines += 1;
          if (!line.startsWith('{')) continue;
          try {
            const j = JSON.parse(line) as { event?: unknown; level?: unknown; message?: unknown };
            if (typeof j.event !== 'string') continue;
            events.push(j.event);
            if (j.level === 'error') errorEvents.push({ event: j.event, messageClass: typeof j.message === 'string' ? j.message.slice(0, 60) : '' });
          } catch {
            // not a structured line
          }
        }
      }
      const db = await read.readDb();
      return { serviceAtEnd: s1, pidAtStart: s0.mainPid, invocationAtStart: s0.invocationId, invocationAtEnd: s1.invocationId, events, errorEvents, fatalStartupLines, signingLines, paused: db.paused };
    },

    async restoreFromRollback(dir, items) {
      if (!ROLLBACK_NAME_RE.test(dir.startsWith(`${L.rollbackRoot}/`) ? dir.slice(L.rollbackRoot.length + 1) : '')) throw new Error(`not a rollback snapshot directory: ${dir}`);
      for (const { name } of items) {
        await sudo(run, BIN.rsync, itemRsyncArgs(`${dir}/app`, L.prodDir, name, ['-a', '--delete']), 900_000);
        const diff = await sudo(run, BIN.rsync, itemRsyncArgs(`${dir}/app`, L.prodDir, name, ['-a', '--delete', '--checksum', '--dry-run', '--itemize-changes']), 900_000);
        if (diff.stdout.trim() !== '') throw new Error(`restored ${name} does not match the snapshot`);
      }
    },
  };
}
