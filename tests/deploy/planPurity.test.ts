import { beforeEach, describe, expect, it, vi } from 'vitest';
import { createHash } from 'node:crypto';
// vi.mock below is hoisted above these imports, so they receive the mocked node:fs.
import { runCli } from '../../src/deploy/cli';
import { BIN, createReadPorts, isReadOnlyInvocation, START_LOCK_CONTENT, TARGET_LAYOUT } from '../../src/deploy/hostPorts';
import { MANIFEST_RELATIVE_PATH, renderManifest, walkRelease } from '../../src/deploy/releaseManifest';

/**
 * M-5: `plan` must be 100% read-only. This file runs the REAL CLI path
 * (`runCli(['plan', ...])` -> createReadPorts -> runPlan) against a fake host,
 * with every node:fs write primitive replaced by a spy that throws, and records
 * every external command. It fails if plan writes a file, opens a session log,
 * builds deploy ports, or issues a single non-read command.
 */
const { FS_WRITES, writeSpies } = vi.hoisted(() => ({
  FS_WRITES: [
    'writeFileSync', 'appendFileSync', 'mkdirSync', 'mkdtempSync', 'rmSync', 'rmdirSync', 'unlinkSync', 'renameSync', 'copyFileSync', 'cpSync',
    'symlinkSync', 'linkSync', 'chmodSync', 'chownSync', 'lchownSync', 'truncateSync', 'utimesSync', 'openSync', 'createWriteStream',
    'writeFile', 'appendFile', 'mkdir', 'rm', 'unlink', 'rename', 'copyFile', 'symlink', 'chmod', 'chown',
  ] as const,
  writeSpies: new Map<string, ReturnType<typeof vi.fn>>(),
}));

vi.mock('node:fs', async (importOriginal) => {
  const actual = await importOriginal<Record<string, unknown>>();
  const overrides: Record<string, unknown> = {};
  for (const name of FS_WRITES) {
    const spy = vi.fn(() => {
      throw new Error(`plan attempted fs.${name}`);
    });
    writeSpies.set(name, spy);
    overrides[name] = spy;
  }
  return { ...actual, ...overrides, default: { ...actual, ...overrides } };
});


const RELEASE = 'fb4d3306d32f61f093b41507b5e1a548cdb61863';
const PREVIOUS = 'cde2ba8a2a3393dfedf795a8f571b174e337380d';
const TOOL = 'a'.repeat(40);
const EXECUTOR = '0x25598234c6E74370e42F3B3D7646581C68656d39';
const L = TARGET_LAYOUT;
const REL = `${L.releasesDir}/${RELEASE}`;
const MIGRATION_SQL = 'CREATE TABLE "x" ("id" INTEGER);\n';

interface Node {
  type: 'f' | 'd';
  mode: number;
  uid: number;
  content?: string;
}

function buildNodes(): Record<string, Node> {
  const d = (mode = 0o755, uid = 0): Node => ({ type: 'd', mode, uid });
  const f = (content: string, mode = 0o644): Node => ({ type: 'f', mode, uid: 0, content });
  return {
    '/': d(), '/opt': d(), '/opt/lunex': d(), '/opt/lunex/production': d(), [L.prodDir]: d(0o750, 995), '/proc': d(0o555),
    [REL]: d(),
    [`${REL}/dist`]: d(),
    [`${REL}/dist/index.js`]: f('main\n'),
    [`${REL}/RELEASE_SHA`]: f(`${RELEASE}\n`),
    [`${REL}/prisma`]: d(),
    [`${REL}/prisma/migrations`]: d(),
    [`${REL}/prisma/migrations/20260927000000_add_x`]: d(),
    [`${REL}/prisma/migrations/20260927000000_add_x/migration.sql`]: f(MIGRATION_SQL),
    [`${REL}/.lunex-release`]: d(),
    [`${REL}/.lunex-release/commit-id`]: f(`${RELEASE}\n`, 0o444),
    [`${L.releasesDir}/${TOOL}/ops/deploy/lunex-bot-deploy-lock.conf`]: f(START_LOCK_CONTENT, 0o444),
  };
}

function fakeFs(nodes: Record<string, Node>) {
  const get = (p: string): Node => {
    const n = nodes[p];
    if (!n) throw Object.assign(new Error(`ENOENT ${p}`), { code: 'ENOENT' });
    return n;
  };
  return {
    lstatSync: (p: string) => {
      const n = get(p);
      return { isFile: () => n.type === 'f', isDirectory: () => n.type === 'd', isSymbolicLink: () => false, mode: n.mode, uid: n.uid, gid: n.uid, size: n.content?.length ?? 0 };
    },
    readdirSync: (p: string) => {
      get(p);
      const prefix = `${p}/`;
      return [...new Set(Object.keys(nodes).filter((k) => k.startsWith(prefix)).map((k) => k.slice(prefix.length).split('/')[0] ?? ''))].filter((s) => s !== '');
    },
    readFileSync: (p: string) => Buffer.from(get(p).content ?? ''),
    readlinkSync: () => '',
    readTextFile: (p: string) => get(p).content ?? '',
    statUid: (p: string) => get(p).uid,
  };
}

const line = (t: string, name: string) => `${t}rw-r--r--          41 2026/09/30 00:00:00 ${name}`;

let calls: { file: string; args: readonly string[] }[];

beforeEach(() => {
  calls = [];
  for (const spy of writeSpies.values()) spy.mockClear();
});

async function runPlanCli() {
  const nodes = buildNodes();
  const fsFake = fakeFs(nodes);
  const manifest = renderManifest(walkRelease(REL, fsFake));
  nodes[`${REL}/${MANIFEST_RELATIVE_PATH}`] = { type: 'f', mode: 0o444, uid: 0, content: manifest };
  const manifestSha = createHash('sha256').update(manifest).digest('hex');

  const run = async (file: string, args: readonly string[]) => {
    calls.push({ file, args });
    if (file === BIN.systemctl) return { stdout: 'ActiveState=active\nSubState=running\nMainPID=36477\nNRestarts=0\nInvocationID=x\nDropInPaths=\n' };
    const [, bin, ...rest] = args;
    if (bin === BIN.rsync) {
      if (rest[2] === `${L.prodDir}/RELEASE_SHA`) return { stdout: line('-', 'RELEASE_SHA') };
      if (rest[2] === `${L.prodDir}/`) return { stdout: [line('d', '.'), line('d', 'dist'), line('-', 'RELEASE_SHA'), line('d', 'prisma'), line('-', '.env'), line('d', 'data')].join('\n') };
      return { stdout: '' };
    }
    if (bin === BIN.sqlite3) {
      const sql = rest.at(-1) ?? '';
      if (sql.includes('readfile(')) return { stdout: `${PREVIOUS}\n` };
      if (sql.includes('integrity_check')) return { stdout: 'ok\n' };
      if (sql.includes('BotSettings')) return { stdout: '[{"paused":1,"opening":0,"active":0,"closing":0,"nonTerminal":0,"capital":"0","unfinished":0}]' };
      if (sql.includes('MAX(nonce)')) return { stdout: '[{"m":0}]' };
      if (sql.includes('_prisma_migrations')) {
        const checksum = createHash('sha256').update(MIGRATION_SQL).digest('hex');
        return { stdout: `[{"name":"20260927000000_add_x","checksum":"${checksum}","finished":1,"rolledBack":0}]` };
      }
    }
    return { stdout: '' };
  };
  const chainClients = [
    {
      label: 'rpc#1(fake)',
      client: {
        getChainId: () => Promise.resolve(4663),
        getTransactionCount: ({ address }: { address: string }) => Promise.resolve(address === '0x65299018abaaa6bd89aabf689dbef21be99ef1ea' ? 1619 : 1),
      },
    },
  ];
  const writes: string[] = [];
  const opened: string[] = [];
  const code = await runCli(
    [
      'plan',
      '--expected-release-sha', RELEASE,
      '--expected-previous-sha', PREVIOUS,
      '--expected-executor', EXECUTOR,
      '--expected-chain-id', '4663',
      '--rpc', 'https://rpc.example.invalid',
      '--expected-manifest-sha256', manifestSha,
    ],
    {
      write: (l) => writes.push(l),
      resolveToolSha: () => TOOL,
      openSessionLog: (dir) => {
        opened.push(dir);
        return () => undefined;
      },
      createReadPorts: (cfg) => createReadPorts({ ...cfg, run, fs: fsFake, chainClients }),
      createDeployPorts: () => {
        throw new Error('plan built deploy ports');
      },
    },
  );
  return { code, writes, opened };
}

describe('plan is 100% read-only (M-5)', () => {
  it('runs the full real plan path and passes', async () => {
    const { code, writes } = await runPlanCli();
    const result = writes.map((w) => JSON.parse(w) as { event: string; status?: string }).find((e) => e.event === 'deploy_tool_result');
    expect(result?.status).toBe('PLAN_OK');
    expect(code).toBe(0);
  });

  it('calls no fs write primitive at all', async () => {
    await runPlanCli();
    const used = [...writeSpies.entries()].filter(([, spy]) => spy.mock.calls.length > 0).map(([n]) => n);
    expect(used).toEqual([]);
  });

  it('opens no session log and builds no deploy ports', async () => {
    const { opened } = await runPlanCli();
    expect(opened).toEqual([]);
  });

  it('issues only read-only host commands (no systemctl start/stop/mask, no rsync copy, no mkdir/install, no writable sqlite)', async () => {
    await runPlanCli();
    expect(calls.length).toBeGreaterThan(5);
    const mutating = calls.filter((c) => !isReadOnlyInvocation(c.file, c.args));
    expect(mutating).toEqual([]);
    expect(calls.some((c) => c.args.includes('start') || c.args.includes('stop'))).toBe(false);
  });

  it('never runs the identity probe unit', async () => {
    await runPlanCli();
    expect(calls.some((c) => c.args.some((a) => a.includes('lunex-deploy-identity')))).toBe(false);
  });
});
