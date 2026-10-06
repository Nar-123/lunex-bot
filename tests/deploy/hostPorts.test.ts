import { describe, expect, it } from 'vitest';
import { createHash } from 'node:crypto';
import {
  BIN,
  createDeployPorts,
  createReadPorts,
  isReadOnlyInvocation,
  itemRsyncArgs,
  parseListing,
  readOnlyRunner,
  redactUrls,
  rpcLabel,
  START_LOCK_CONTENT,
  TARGET_LAYOUT,
  type HostFs,
  type HostPortsConfig,
  type Runner,
} from '../../src/deploy/hostPorts';

const RELEASE = 'fb4d3306d32f61f093b41507b5e1a548cdb61863';
const PREVIOUS = 'cde2ba8a2a3393dfedf795a8f571b174e337380d';
const TOOL = 'a'.repeat(40);
const EXECUTOR = '0x25598234C6E74370e42F3B3D7646581C68656d39';
const L = TARGET_LAYOUT;
const SNAP = `${L.rollbackRoot}/${PREVIOUS}-20261003T000000Z`;
const BOT_UID = 995;
const CURSOR = `s=${"1".repeat(32)};i=4a2;b=${"2".repeat(32)};m=7f3c;t=63f1a2b3c4d5;x=9e8d7c6b5a4f3e2d`;

// ---------------------------------------------------------------- fake host

interface Node {
  type: 'f' | 'd' | 'l';
  mode: number;
  uid: number;
  content?: string;
}

function fakeFs(nodes: Record<string, Node>): HostFs {
  const get = (p: string): Node => {
    const n = nodes[p];
    if (!n) throw Object.assign(new Error(`ENOENT ${p}`), { code: 'ENOENT' });
    return n;
  };
  const stat = (n: Node) => ({ isFile: () => n.type === 'f', isDirectory: () => n.type === 'd', isSymbolicLink: () => n.type === 'l', mode: n.mode, uid: n.uid, gid: n.uid, size: n.content?.length ?? 0 });
  return {
    lstatSync: (p) => stat(get(p)),
    readdirSync: (p) => {
      get(p);
      const prefix = p.endsWith('/') ? p : `${p}/`;
      return [...new Set(Object.keys(nodes).filter((k) => k.startsWith(prefix)).map((k) => k.slice(prefix.length).split('/')[0] ?? ''))].filter((s) => s !== '');
    },
    readFileSync: (p) => Buffer.from(get(p).content ?? ''),
    readlinkSync: () => '/elsewhere',
    readTextFile: (p) => get(p).content ?? '',
    statUid: (p) => get(p).uid,
  };
}

const dirLine = (name: string) => `drwxr-xr-x          4,096 2026/09/30 00:00:00 ${name}`;
const fileLine = (name: string, size = 41) => `-rw-r--r--         ${size} 2026/09/30 00:00:00 ${name}`;
const linkLine = (name: string) => `lrwxrwxrwx              9 2026/09/30 00:00:00 ${name} -> /etc`;

interface HostState {
  listings: Record<string, string[]>;
  files: Record<string, string>;
  service: string;
  journal?: string;
  sqlRows?: Record<string, string>;
}

function baseNodes(): Record<string, Node> {
  return {
    '/': { type: 'd', mode: 0o755, uid: 0 },
    '/opt': { type: 'd', mode: 0o755, uid: 0 },
    '/opt/lunex': { type: 'd', mode: 0o755, uid: 0 },
    '/opt/lunex/production': { type: 'd', mode: 0o755, uid: 0 },
    [L.prodDir]: { type: 'd', mode: 0o750, uid: BOT_UID },
    [L.rollbackRoot]: { type: 'd', mode: 0o700, uid: 0 },
    '/proc': { type: 'd', mode: 0o555, uid: 0 },
    '/proc/1': { type: 'd', mode: 0o555, uid: 0 },
    '/proc/self': { type: 'l', mode: 0o777, uid: 0 },
    [`${L.releasesDir}/${TOOL}/ops/deploy/lunex-bot-deploy-lock.conf`]: { type: 'f', mode: 0o444, uid: 0, content: START_LOCK_CONTENT },
    [L.lockPath]: { type: 'f', mode: 0o644, uid: 0, content: START_LOCK_CONTENT },
  };
}

function host(state: Partial<HostState> = {}, nodes: Record<string, Node> = baseNodes()) {
  const calls: { file: string; args: readonly string[] }[] = [];
  const s: HostState = {
    listings: {
      [`${L.prodDir}/RELEASE_SHA`]: [fileLine('RELEASE_SHA')],
      [`${L.prodDir}/`]: [dirLine('.'), dirLine('dist'), dirLine('ops'), fileLine('RELEASE_SHA'), fileLine('.env', 10984), dirLine('data')],
      ...state.listings,
    },
    files: { [`${L.prodDir}/RELEASE_SHA`]: `${PREVIOUS}\n`, ...state.files },
    service: state.service ?? `ActiveState=inactive\nSubState=dead\nMainPID=0\nNRestarts=0\nInvocationID=\nDropInPaths=${L.lockPath}\n`,
    journal: state.journal ?? '',
    sqlRows: state.sqlRows ?? {},
  };
  const run: Runner = async (file, args) => {
    calls.push({ file, args });
    if (file === BIN.systemctl && args[0] === 'show') return { stdout: s.service };
    if (file !== BIN.sudo) return { stdout: '' };
    const [, bin, ...rest] = args;
    if (bin === BIN.rsync && rest[0] === '--list-only') return { stdout: (s.listings[rest[2] ?? ''] ?? []).join('\n') };
    if (bin === BIN.sqlite3) {
      const sql = rest.at(-1) ?? '';
      const rf = /readfile\('([^']*)'\)/.exec(sql);
      if (rf?.[1] !== undefined) return { stdout: s.files[rf[1]] ?? '\n' };
      for (const [k, v] of Object.entries(s.sqlRows ?? {})) if (sql.includes(k)) return { stdout: v };
      if (sql.includes('integrity_check')) return { stdout: 'ok\n' };
      return { stdout: '[]' };
    }
    if (bin === BIN.journalctl) return { stdout: s.journal ?? '' };
    return { stdout: '' };
  };
  const cfg: HostPortsConfig = {
    layout: L,
    releaseSha: RELEASE,
    previousSha: PREVIOUS,
    toolSha: TOOL,
    expectedManifestSha256: 'e'.repeat(64),
    rpcUrls: ['https://rpc.example.invalid/key-in-path'],
    log: () => undefined,
    run,
    fs: fakeFs(nodes),
    sleep: async () => undefined,
    now: () => new Date('2026-10-03T00:00:00Z'),
  };
  return { cfg, calls, state: s };
}

const sudoCalls = (calls: { file: string; args: readonly string[] }[], bin: string) => calls.filter((c) => c.file === BIN.sudo && c.args[1] === bin).map((c) => c.args.slice(2));

// ---------------------------------------------------------------- tests

describe('read-only command guard (M-5)', () => {
  it.each([
    [BIN.systemctl, ['show', 'lunex-bot', '-p', 'ActiveState']],
    [BIN.sudo, ['-n', BIN.rsync, '--list-only', '--', '/x']],
    [BIN.sudo, ['-n', BIN.sqlite3, '-readonly', '-batch', '/db', 'SELECT 1;']],
    [BIN.sudo, ['-n', BIN.sqlite3, '-readonly', '-batch', '/db', 'PRAGMA integrity_check;']],
    [BIN.sudo, ['-n', BIN.sqlite3, '-readonly', '-batch', ':memory:', "SELECT CAST(readfile('/opt/x') AS TEXT);"]],
    [BIN.sudo, ['-n', BIN.journalctl, '-u', 'lunex-bot.service', '-o', 'cat']],
  ])('accepts read %s %j', (file, args) => {
    expect(isReadOnlyInvocation(file, args)).toBe(true);
  });

  it.each([
    [BIN.systemctl, ['start', 'lunex-bot']],
    [BIN.sudo, ['-n', BIN.systemctl, 'stop', 'lunex-bot']],
    [BIN.sudo, ['-n', BIN.systemctl, 'mask', '--runtime', 'lunex-bot']],
    [BIN.sudo, ['-n', BIN.systemctl, 'daemon-reload']],
    [BIN.sudo, ['-n', BIN.rsync, '-a', '--', '/a', '/b']],
    [BIN.sudo, ['-n', BIN.rsync, '-a', '--dry-run', '--', '/a', '/b']],
    [BIN.sudo, ['-n', BIN.sqlite3, '-batch', '/db', 'SELECT 1;']],
    [BIN.sudo, ['-n', BIN.sqlite3, '-readonly', '/db', "SELECT writefile('/etc/x', 'y');"]],
    [BIN.sudo, ['-n', BIN.sqlite3, '-readonly', '/db', "ATTACH '/other.db' AS o;"]],
    [BIN.sudo, ['-n', BIN.sqlite3, '-readonly', '/db', '.shell id']],
    [BIN.sudo, ['-n', BIN.sqlite3, '-readonly', '/db', 'SELECT 1; INSERT INTO t VALUES (1);']],
    [BIN.sudo, ['-n', BIN.sqlite3, '-readonly', '/db', 'PRAGMA writable_schema=ON;']],
    [BIN.sudo, ['-n', BIN.mkdir, '-p', '/x']],
    [BIN.sudo, ['-n', BIN.install, '/dev/null', '/x']],
    [BIN.sudo, ['-n', BIN.journalctl, '--rotate']],
    [BIN.sudo, ['-n', BIN.journalctl, '--vacuum-time=1s']],
    [BIN.sudo, ['/usr/bin/rsync', '--list-only', '/x']],
    ['/bin/sh', ['-c', 'id']],
  ])('refuses mutation %s %j', (file, args) => {
    expect(isReadOnlyInvocation(file, args)).toBe(false);
  });

  it('readOnlyRunner throws and never reaches the real runner for a mutation', async () => {
    let reached = false;
    const guarded = readOnlyRunner(async () => {
      reached = true;
      return { stdout: '' };
    });
    await expect(guarded(BIN.sudo, ['-n', BIN.systemctl, 'stop', 'lunex-bot'])).rejects.toThrow(/read-only mode refused/);
    expect(reached).toBe(false);
  });
});

describe('RELEASE_SHA read without an intermediate file (M-1)', () => {
  it('regular source: returns the live value via readfile, after a type check', async () => {
    const { cfg, calls } = host();
    expect(await createReadPorts(cfg).readDeployedReleaseSha()).toBe(PREVIOUS);
    expect(sudoCalls(calls, BIN.rsync)[0]).toEqual(['--list-only', '--', `${L.prodDir}/RELEASE_SHA`]);
    expect(sudoCalls(calls, BIN.sqlite3)[0]?.at(-1)).toBe(`SELECT CAST(readfile('${L.prodDir}/RELEASE_SHA') AS TEXT);`);
    // nothing but these two reads, and no copy anywhere
    expect(calls).toHaveLength(2);
  });

  it('a stale copy elsewhere is irrelevant -- there is no copy to go stale', async () => {
    const nodes = { ...baseNodes(), '/home/lunex-admin/session/deployed-RELEASE_SHA': { type: 'f' as const, mode: 0o644, uid: 1003, content: `${RELEASE}\n` } };
    const { cfg } = host({}, nodes);
    expect(await createReadPorts(cfg).readDeployedReleaseSha()).toBe(PREVIOUS);
  });

  it.each([
    ['a symlink source', [linkLine('RELEASE_SHA')]],
    ['a directory source', [dirLine('RELEASE_SHA')]],
    ['a missing source', []],
    ['an oversized source', [fileLine('RELEASE_SHA', 5_000_000)]],
  ])('%s fails closed before any read', async (_l, listing) => {
    const { cfg, calls } = host({ listings: { [`${L.prodDir}/RELEASE_SHA`]: listing } });
    await expect(createReadPorts(cfg).readDeployedReleaseSha()).rejects.toThrow();
    expect(sudoCalls(calls, BIN.sqlite3)).toHaveLength(0);
  });

  it('a file that vanishes between the type check and the read fails (empty readfile), never a stale value', async () => {
    const { cfg } = host({ files: { [`${L.prodDir}/RELEASE_SHA`]: '\n' } });
    await expect(createReadPorts(cfg).readDeployedReleaseSha()).rejects.toThrow(/could not be read/);
  });
});

describe('symlink-safe production writes (H-1)', () => {
  it('copies name the item WITHOUT a trailing slash into the destination ROOT, set ownership via rsync --chown', () => {
    expect(itemRsyncArgs('/rel', '/prod', 'dist', ['-a', '--delete', '--chown=lunex-bot:lunex-bot'])).toEqual(['-a', '--delete', '--chown=lunex-bot:lunex-bot', '--', '/rel/dist', '/prod/']);
    expect(itemRsyncArgs('/rel', '/prod', 'ops', ['-a'])).toEqual(['-a', '--exclude=/ops/lunex-bot/', '--', '/rel/ops', '/prod/']);
  });

  it.each(['', '.', '..', '../etc', 'a/b', '.env', 'data', 'logs'])('refuses item name %j', (name) => {
    expect(() => itemRsyncArgs('/rel', '/prod', name, ['-a'])).toThrow(/refusing item/);
  });

  it('replaceArtifact never invokes chown and never writes through an item path with a trailing slash', async () => {
    const { cfg, calls } = host();
    await createDeployPorts(cfg).replaceArtifact([
      { name: 'dist', type: 'd' },
      { name: 'ops', type: 'd' },
      { name: 'RELEASE_SHA', type: 'f' },
    ]);
    expect(calls.some((c) => c.args.includes('/usr/bin/chown'))).toBe(false);
    for (const args of sudoCalls(calls, BIN.rsync)) {
      const src = args.at(-2) ?? '';
      expect(src.endsWith('/')).toBe(false);
      expect(args.at(-1)).toBe(`${L.prodDir}/`);
      expect(args).toContain('--chown=lunex-bot:lunex-bot');
    }
  });

  it('the layout read reports a top-level symlink so the gate can refuse it', async () => {
    const { cfg } = host({ listings: { [`${L.prodDir}/`]: [dirLine('.'), linkLine('dist'), dirLine('ops')] } });
    const layout = await createReadPorts(cfg).readProdLayout();
    expect(layout.entries.find((e) => e.name === 'dist')?.type).toBe('l');
    expect(layout.unsafeAncestors).toEqual([]);
  });

  it('an ancestor that is a symlink, writable, or not root-owned is reported', async () => {
    const nodes = { ...baseNodes(), '/opt/lunex': { type: 'd' as const, mode: 0o777, uid: 0 }, '/opt/lunex/production': { type: 'l' as const, mode: 0o777, uid: 0 } };
    const { cfg } = host({}, nodes);
    expect((await createReadPorts(cfg).readProdLayout()).unsafeAncestors).toEqual(['/opt/lunex', '/opt/lunex/production']);
  });

  it('a production root that is a symlink is not listed at all', async () => {
    const nodes = { ...baseNodes(), [L.prodDir]: { type: 'l' as const, mode: 0o777, uid: BOT_UID } };
    const { cfg, calls } = host({}, nodes);
    const layout = await createReadPorts(cfg).readProdLayout();
    expect(layout.rootIsRealDirectory).toBe(false);
    expect(calls).toHaveLength(0);
  });
});

describe('quiescence facts (M-2)', () => {
  it('finds service-account processes in /proc and counts journal activity after the cursor', async () => {
    const nodes = { ...baseNodes(), '/proc/4242': { type: 'd' as const, mode: 0o555, uid: BOT_UID } };
    const { cfg, calls } = host({ journal: 'Starting lunex-bot.service...\nAssertion failed\n' }, nodes);
    const q = await createReadPorts(cfg).readQuiescence(CURSOR);
    expect(q.serviceAccountPids).toEqual([4242]);
    expect(q.journalEntriesSinceStop).toBe(2);
    expect(q.startLockActive).toBe(true);
    expect(sudoCalls(calls, BIN.journalctl)[0]).toContain(`--after-cursor=${CURSOR}`);
  });

  it('a lock file with other content, or not loaded as a drop-in, is not an active lock', async () => {
    const nodes = { ...baseNodes(), [L.lockPath]: { type: 'f' as const, mode: 0o644, uid: 0, content: '' } };
    expect((await createReadPorts(host({}, nodes).cfg).readQuiescence(CURSOR)).startLockActive).toBe(false);
    const notLoaded = host({ service: 'ActiveState=inactive\nSubState=dead\nMainPID=0\nNRestarts=0\nDropInPaths=\n' });
    expect((await createReadPorts(notLoaded.cfg).readQuiescence(CURSOR)).startLockActive).toBe(false);
  });

  it('refuses a malformed journal cursor (no argument injection)', async () => {
    await expect(createReadPorts(host().cfg).readQuiescence('--vacuum-time=1s')).rejects.toThrow(/invalid journal cursor/);
  });
});

describe('rollback source reads (M-3)', () => {
  const okListings = {
    [`${L.rollbackRoot}/`]: [dirLine('.'), dirLine(`${PREVIOUS}-20261003T000000Z`)],
    [`${SNAP}/`]: [dirLine('.'), dirLine('app'), fileLine('production.db', 1_000_000)],
    [`${SNAP}/app/RELEASE_SHA`]: [fileLine('RELEASE_SHA')],
    [`${SNAP}/app/`]: [dirLine('.'), dirLine('dist'), fileLine('RELEASE_SHA')],
  };

  it('collects name SHA, types, the snapshot RELEASE_SHA and items', async () => {
    const { cfg } = host({ listings: okListings, files: { [`${SNAP}/app/RELEASE_SHA`]: `${PREVIOUS}\n` } });
    const f = await createReadPorts(cfg).readRollbackSource(SNAP);
    expect(f).toMatchObject({ nameSha: PREVIOUS, rootSafe: true, dirType: 'd', appType: 'd', snapshotReleaseSha: PREVIOUS });
    expect(f.items.map((i) => i.name)).toEqual(['dist', 'RELEASE_SHA']);
  });

  it('a malformed directory never touches the host', async () => {
    const { cfg, calls } = host();
    expect((await createReadPorts(cfg).readRollbackSource('/opt/lunex/production/lunex-bot')).nameSha).toBeNull();
    expect((await createReadPorts(cfg).readRollbackSource(`${SNAP}/../../production`)).nameSha).toBeNull();
    expect(calls).toHaveLength(0);
  });

  it('a symlinked snapshot dir stops before listing through it', async () => {
    const { cfg, calls } = host({ listings: { ...okListings, [`${L.rollbackRoot}/`]: [dirLine('.'), linkLine(`${PREVIOUS}-20261003T000000Z`)] } });
    const f = await createReadPorts(cfg).readRollbackSource(SNAP);
    expect(f.dirType).toBe('l');
    expect(sudoCalls(calls, BIN.rsync).some((a) => a.includes(`${SNAP}/`))).toBe(false);
  });

  it('an unsafe rollback root (not 0700 root) stops before any listing', async () => {
    const nodes = { ...baseNodes(), [L.rollbackRoot]: { type: 'd' as const, mode: 0o755, uid: 0 } };
    const { cfg, calls } = host({ listings: okListings }, nodes);
    expect((await createReadPorts(cfg).readRollbackSource(SNAP)).rootSafe).toBe(false);
    expect(calls).toHaveLength(0);
  });

  it('restoreFromRollback refuses a directory that is not a snapshot', async () => {
    await expect(createDeployPorts(host().cfg).restoreFromRollback('/etc', [{ name: 'dist', type: 'd' }])).rejects.toThrow(/not a rollback snapshot/);
  });
});

describe('identity probe and start lock', () => {
  it('probe: stop, start, read the invocation, read its journal, stop again', async () => {
    const inv = 'f'.repeat(32);
    const { cfg, calls } = host({
      service: `ActiveState=active\nSubState=exited\nResult=success\nInvocationID=${inv}\n`,
      journal: `{"event":"deploy_identity","executor":"${EXECUTOR}","chainId":4663}\n`,
    });
    expect(await createDeployPorts(cfg).probeIdentity()).toEqual({ executor: EXECUTOR.toLowerCase(), chainId: 4663 });
    const unit = `lunex-deploy-identity@${TOOL}.service`;
    expect(sudoCalls(calls, BIN.systemctl)).toEqual([
      ['stop', unit],
      ['start', unit],
      ['stop', unit],
    ]);
    expect(sudoCalls(calls, BIN.journalctl)[0]).toEqual([`_SYSTEMD_INVOCATION_ID=${inv}`, '-o', 'cat', '--no-pager']);
  });

  it('a probe that did not succeed is an error, and the unit is still stopped', async () => {
    const { cfg, calls } = host({ service: `ActiveState=failed\nSubState=failed\nResult=exit-code\nInvocationID=${'f'.repeat(32)}\n` });
    await expect(createDeployPorts(cfg).probeIdentity()).rejects.toThrow(/identity probe ended/);
    expect(sudoCalls(calls, BIN.systemctl).at(-1)?.[0]).toBe('stop');
  });

  it('lock: installs the sealed drop-in, reloads, and verifies it is loaded', async () => {
    const { cfg, calls } = host();
    await createDeployPorts(cfg).lockStart();
    expect(sudoCalls(calls, BIN.install)[0]).toEqual(['-m', '0644', '-o', 'root', '-g', 'root', '--', `${L.releasesDir}/${TOOL}/ops/deploy/lunex-bot-deploy-lock.conf`, L.lockPath]);
    expect(sudoCalls(calls, BIN.systemctl)).toContainEqual(['daemon-reload']);
  });

  it('lock refuses an altered drop-in source in the tool release', async () => {
    const nodes = { ...baseNodes(), [`${L.releasesDir}/${TOOL}/ops/deploy/lunex-bot-deploy-lock.conf`]: { type: 'f' as const, mode: 0o444, uid: 0, content: '[Unit]\n' } };
    const { cfg, calls } = host({}, nodes);
    await expect(createDeployPorts(cfg).lockStart()).rejects.toThrow(/missing or altered/);
    expect(sudoCalls(calls, BIN.install)).toHaveLength(0);
  });

  it('the shipped drop-in file is byte-identical to the constant the tool verifies', async () => {
    const { readFileSync } = await import('node:fs');
    expect(readFileSync('ops/deploy/lunex-bot-deploy-lock.conf', 'utf8')).toBe(START_LOCK_CONTENT);
  });
});

describe('snapshot safety', () => {
  it('refuses to back up a production DB that is a symlink (data/ is writable by the service)', async () => {
    const { cfg, calls } = host({ listings: { [`${L.prodDir}/data/`]: [dirLine('.'), linkLine('lunex.db')] } });
    await expect(createDeployPorts(cfg).snapshotRollback([{ name: 'dist', type: 'd' }])).rejects.toThrow(/not a regular file/);
    expect(sudoCalls(calls, BIN.rsync).some((a) => a.includes(L.dbPath) && !a.includes('--list-only'))).toBe(false);
  });

  it('copies a regular production DB', async () => {
    const { cfg, calls } = host({ listings: { [`${L.prodDir}/data/`]: [dirLine('.'), fileLine('lunex.db', 2_000_000)] } });
    await createDeployPorts(cfg).snapshotRollback([{ name: 'dist', type: 'd' }]);
    expect(sudoCalls(calls, BIN.rsync)).toContainEqual(['-a', '--', L.dbPath, `${SNAP}/production.db`]);
  });

  it('refuses a rollback root that is not root-owned 0700, before creating the snapshot dir', async () => {
    const nodes = { ...baseNodes(), [L.rollbackRoot]: { type: 'd' as const, mode: 0o755, uid: 0 } };
    const { cfg, calls } = host({}, nodes);
    await expect(createDeployPorts(cfg).snapshotRollback([{ name: 'dist', type: 'd' }])).rejects.toThrow(/root-owned 0700/);
    expect(sudoCalls(calls, BIN.mkdir)).toEqual([['-p', '-m', '0700', '--', L.rollbackRoot]]);
  });
});

describe('schema and health reads', () => {
  it('release checksums are sha256(migration.sql); DB rows come from _prisma_migrations', async () => {
    const sql = 'CREATE TABLE x (id INT);\n';
    const nodes = {
      ...baseNodes(),
      [`${L.releasesDir}/${RELEASE}/prisma/migrations`]: { type: 'd' as const, mode: 0o755, uid: 0 },
      [`${L.releasesDir}/${RELEASE}/prisma/migrations/20260927000000_add_x`]: { type: 'd' as const, mode: 0o755, uid: 0 },
      [`${L.releasesDir}/${RELEASE}/prisma/migrations/20260927000000_add_x/migration.sql`]: { type: 'f' as const, mode: 0o644, uid: 0, content: sql },
      [`${L.releasesDir}/${RELEASE}/prisma/migrations/migration_lock.toml`]: { type: 'f' as const, mode: 0o644, uid: 0, content: 'x' },
    };
    const { cfg } = host({ sqlRows: { _prisma_migrations: '[{"name":"20260927000000_add_x","checksum":"abc","finished":1,"rolledBack":0}]' } }, nodes);
    const s = await createReadPorts(cfg).readSchema();
    expect(s.release).toEqual([{ name: '20260927000000_add_x', checksum: createHash('sha256').update(sql).digest('hex') }]);
    expect(s.db).toEqual([{ name: '20260927000000_add_x', checksum: 'abc', finished: true, rolledBack: false }]);
  });

  it('health facts come from the started invocation only, with short message classes', async () => {
    const inv = 'd'.repeat(32);
    const { cfg } = host({
      service: `ActiveState=active\nSubState=running\nMainPID=5000\nNRestarts=0\nInvocationID=${inv}\n`,
      journal: [
        '{"level":"info","event":"startup"}',
        '{"level":"info","event":"api_server_started"}',
        '{"level":"error","event":"screening_cycle_error","message":"gmgn-cli command failed after 3 attempt(s): gmgn-cli market trending --chain robinhood"}',
        '[lunex-bot] fatal startup error: boom',
      ].join('\n'),
      sqlRows: { BotSettings: '[{"paused":1,"opening":0,"active":0,"closing":0,"nonTerminal":0,"capital":"0","unfinished":0}]' },
    });
    const h = await createDeployPorts(cfg).collectHealth();
    expect(h.events).toEqual(['startup', 'api_server_started', 'screening_cycle_error']);
    expect(h.errorEvents[0]?.messageClass).toHaveLength(60);
    expect(h.fatalStartupLines).toBe(1);
    expect(h.paused).toBe(1);
  });
});

describe('logging hygiene', () => {
  it('RPC labels and errors never carry a URL path', () => {
    expect(rpcLabel('https://rpc.example.invalid/key-in-path', 0)).toBe('rpc#1(rpc.example.invalid)');
    expect(redactUrls('HTTP request failed. URL: https://rpc.example.invalid/v2/SECRETKEY Status: 429')).toBe('HTTP request failed. URL: <url> Status: 429');
  });
  it('parses rsync listings including symlinks and names with spaces', () => {
    expect(parseListing([dirLine('.'), linkLine('dist'), fileLine('a b.txt', 3)].join('\n'))).toEqual([
      { name: 'dist', type: 'l', size: 9 },
      { name: 'a b.txt', type: 'f', size: 3 },
    ]);
  });
});
