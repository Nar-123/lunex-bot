import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { spawnSync } from 'node:child_process';
import * as fs from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { evaluateReleaseIdentity, evaluateReleaseLayout, forbiddenTopLevelReason, RETIRED_WALLET_TRIPWIRE, type EntryType } from '../../src/deploy/gate';
import { createReadPorts, itemRsyncArgs, TARGET_LAYOUT, type HostFs } from '../../src/deploy/hostPorts';
import { runDeployment, runPlan, type DeployPorts, type ReadPorts, type StagedRelease } from '../../src/deploy/pipeline';

const RELEASE = 'fb4d3306d32f61f093b41507b5e1a548cdb61863';
const PREVIOUS = 'cde2ba8a2a3393dfedf795a8f571b174e337380d';
const EXECUTOR = '0x25598234c6e74370e42f3b3d7646581c68656d39';
const INPUT = { expectedReleaseSha: RELEASE, expectedPreviousSha: PREVIOUS, expectedExecutor: EXECUTOR, expectedChainId: 4663 };
const PREPARE = fs.readFileSync('ops/deploy/prepare-release.sh', 'utf8');
const CHECK_SCRIPT = 'ops/deploy/check-release-layout.sh';
const CHECK = fs.readFileSync(CHECK_SCRIPT, 'utf8');

type Top = { name: string; type: EntryType }[];
/** The real fb4d330 release top level (from the sealed tree's verifier output), minus data/. */
const FB4D330_TOP: Top = [
  ...['.env.example', '.gitignore', 'README.md', 'RELEASE_SHA', 'eslint.config.js', 'package-lock.json', 'package.json', 'playwright.config.ts', 'prisma7.config.ts', 'tsconfig.build.json', 'tsconfig.json', 'tsconfig.ui.json', 'tsconfig.ui.test.json', 'vitest.config.ts'].map((name) => ({ name, type: 'f' as const })),
  ...['dist', 'docs', 'node_modules', 'ops', 'prisma', 'src', 'tests', 'ui', '.lunex-release'].map((name) => ({ name, type: 'd' as const })),
];
const withEntry = (name: string, type: EntryType = 'd'): Top => [...FB4D330_TOP, { name, type }];

describe('release layout gate (actual top-level tree)', () => {
  it('7: the valid fb4d330 layout passes', () => {
    expect(evaluateReleaseLayout(FB4D330_TOP).code).toBe('RELEASE_LAYOUT_CLEAN');
  });

  it.each([
    ['an EMPTY data directory (the observed defect)', withEntry('data')],
    ['a data directory holding files (gate sees the same top-level entry)', withEntry('data')],
    ['a logs directory', withEntry('logs')],
    ['an .env file', withEntry('.env', 'f')],
    ['an .env.local file', withEntry('.env.local', 'f')],
    ['an .env.production file', withEntry('.env.production', 'f')],
    ['a build HOME left in the tree', withEntry('.home')],
    ['an npm cache', withEntry('.npm')],
    ['a coverage directory', withEntry('coverage')],
    ['a rollback directory', withEntry('rollback')],
    ['a stray database file', withEntry('lunex.db', 'f')],
    ['a stray WAL file', withEntry('test.db-wal', 'f')],
    ['a log file', withEntry('deploy.log', 'f')],
    ['a top-level symlink', [...FB4D330_TOP.filter((e) => e.name !== 'dist'), { name: 'dist', type: 'l' as const }]],
    ['a special file', withEntry('fifo', 'other')],
  ])('%s -> RELEASE_LAYOUT_INVALID', (_label, top) => {
    const r = evaluateReleaseLayout(top);
    expect(r.level).toBe('fail');
    expect(r.code).toBe('RELEASE_LAYOUT_INVALID');
  });

  it.each([['a/b'], ['..'], ['.'], [''], ['-rf'], ['bad\nname'], ['tab\tname'], ['back\\slash']])('malformed name %j fails', (name) => {
    expect(forbiddenTopLevelReason(name)).not.toBeNull();
    expect(evaluateReleaseLayout(withEntry(name, 'f')).code).toBe('RELEASE_LAYOUT_INVALID');
  });

  it('the tracked .env.example template is allowed; every other .env* is not', () => {
    expect(forbiddenTopLevelReason('.env.example')).toBeNull();
    expect(forbiddenTopLevelReason('.env')).not.toBeNull();
    expect(forbiddenTopLevelReason('.env.example.bak')).not.toBeNull();
  });

  it('a missing or non-directory metadata dir fails', () => {
    expect(evaluateReleaseLayout(FB4D330_TOP.filter((e) => e.name !== '.lunex-release')).code).toBe('RELEASE_LAYOUT_INVALID');
    expect(evaluateReleaseLayout([...FB4D330_TOP.filter((e) => e.name !== '.lunex-release'), { name: '.lunex-release', type: 'l' }]).code).toBe('RELEASE_LAYOUT_INVALID');
  });

  it('an empty or unreadable tree fails', () => {
    expect(evaluateReleaseLayout([]).code).toBe('RELEASE_LAYOUT_INVALID');
  });

  it('a release that was never staged reports RELEASE_NOT_STAGED (not a misleading SHA mismatch)', () => {
    const r = evaluateReleaseIdentity({ expectedReleaseSha: RELEASE, artifactCommitId: '', stagedReleaseSha: '', stagedManifestVerified: false });
    expect(r.code).toBe('RELEASE_NOT_STAGED');
  });

  it('defence in depth: the copy primitive refuses every forbidden name too', () => {
    for (const name of ['data', 'logs', '.env', '.env.local', 'x.db', 'x.log', '.home', '.lunex-release']) {
      expect(() => itemRsyncArgs('/rel', '/prod', name, ['-a'])).toThrow(/refusing item/);
    }
    expect(() => itemRsyncArgs('/rel', '/prod', '.env.example', ['-a'])).not.toThrow();
  });
});

// ------------------------------------------------------------------ pipeline

const MUTATING = ['probeIdentity', 'lockStart', 'unlockStart', 'stopService', 'captureJournalCursor', 'snapshotRollback', 'replaceArtifact', 'startService', 'restoreFromRollback'];

function ports(topLevelByRead: (n: number) => Top) {
  const calls: string[] = [];
  let reads = 0;
  const items = FB4D330_TOP.filter((e) => e.name !== '.lunex-release');
  const read: ReadPorts = {
    log: () => undefined,
    readChainIds: async () => [{ source: 'rpc#1', chainId: 4663 }],
    readNonces: async (a) => (a === RETIRED_WALLET_TRIPWIRE.address ? [{ source: 'rpc#1', latest: 1619, pending: 1619 }] : [{ source: 'rpc#1', latest: 1, pending: 1 }]),
    readLedgerMaxNonce: async () => 0,
    readDb: async () => ({ integrity: 'ok', paused: 1, opening: 0, active: 0, closing: 0, nonTerminalAttempts: 0, deployedCapitalRaw: '0', unfinishedMigrations: 0 }),
    readService: async () => ({ activeState: calls.includes('stopService') ? 'inactive' : 'active', subState: calls.includes('stopService') ? 'dead' : 'running', mainPid: calls.includes('stopService') ? 0 : 36477, nRestarts: 0 }),
    readDeployedReleaseSha: async () => PREVIOUS,
    readStagedRelease: async (): Promise<StagedRelease> => {
      reads += 1;
      return { artifactCommitId: RELEASE, stagedReleaseSha: RELEASE, manifestVerified: true, manifestProblems: [], items, topLevel: topLevelByRead(reads) };
    },
    readSchema: async () => ({ release: [{ name: 'm', checksum: 'c' }], db: [{ name: 'm', checksum: 'c', finished: true, rolledBack: false }] }),
    readProdLayout: async () => ({ rootIsRealDirectory: true, unsafeAncestors: [], entries: items }),
    readQuiescence: async () => ({ service: { activeState: 'inactive', subState: 'dead', mainPid: 0, nRestarts: 0 }, serviceAccountPids: [], journalEntriesSinceStop: 0, startLockActive: true }),
    readRollbackSource: async () => {
      throw new Error('not used');
    },
  };
  const deploy: DeployPorts = {
    ...read,
    probeIdentity: async () => {
      calls.push('probeIdentity');
      return { executor: EXECUTOR, chainId: 4663 };
    },
    lockStart: async () => void calls.push('lockStart'),
    unlockStart: async () => void calls.push('unlockStart'),
    stopService: async () => void calls.push('stopService'),
    captureJournalCursor: async () => {
      calls.push('captureJournalCursor');
      return 'c';
    },
    snapshotRollback: async () => {
      calls.push('snapshotRollback');
      return { dir: `/opt/lunex/rollback/${PREVIOUS}-20261006T000000Z`, appCopyVerified: true, dbCopyIdentical: true, dbCopyIntegrity: 'ok' };
    },
    dbUnchangedSinceSnapshot: async () => true,
    replaceArtifact: async () => void calls.push('replaceArtifact'),
    verifyDeployed: async () => ({ gate: 'verify-deployed', level: 'pass', code: 'X', message: 'x' }),
    startService: async () => void calls.push('startService'),
    collectHealth: async () => ({
      serviceAtEnd: { activeState: 'active', subState: 'running', mainPid: 5, nRestarts: 0 },
      pidAtStart: 5,
      invocationAtStart: 'a'.repeat(32),
      invocationAtEnd: 'a'.repeat(32),
      events: ['startup', 'api_server_started', 'telegram_bot_started'],
      errorEvents: [],
      fatalStartupLines: 0,
      signingLines: 0,
      paused: 1,
    }),
    restoreFromRollback: async () => void calls.push('restoreFromRollback'),
  };
  return { read, deploy, calls };
}

describe('the layout gate runs before any mutation', () => {
  it('4: plan fails on the data/ defect -- on ReadPorts alone, nothing mutated', async () => {
    const { read } = ports(() => withEntry('data'));
    for (const m of MUTATING) expect(m in read).toBe(false);
    const out = await runPlan(INPUT, read);
    expect(out.status).toBe('ABORTED');
    expect(out.results.find((r) => r.gate === 'release-layout')?.code).toBe('RELEASE_LAYOUT_INVALID');
  });

  it('5: execute refuses BEFORE the start lock and the stop', async () => {
    const { deploy, calls } = ports(() => withEntry('data'));
    const out = await runDeployment(INPUT, deploy);
    expect(out).toMatchObject({ status: 'ABORTED', abortedAt: 'pre-stop', service: 'untouched' });
    expect(calls).toEqual(['probeIdentity']);
  });

  it('a forbidden entry appearing later is caught at pre-replace, before the swap', async () => {
    // read 1 = pre-stop (clean), read 2 = pre-replace (someone dropped logs/ into the release)
    const { deploy, calls } = ports((n) => (n >= 2 ? withEntry('logs') : FB4D330_TOP));
    const out = await runDeployment(INPUT, deploy);
    expect(out.abortedAt).toBe('pre-replace');
    expect(calls).not.toContain('replaceArtifact');
    expect(calls).not.toContain('unlockStart');
  });

  it('the clean fb4d330 layout lets the deployment proceed', async () => {
    const { deploy } = ports(() => FB4D330_TOP);
    expect((await runDeployment(INPUT, deploy)).status).toBe('DEPLOYED');
  });
});

// ------------------------------------------------------------------ host side

describe('the staged release top level is read from disk, not from the manifest', () => {
  it('reports data/ even though no manifest exists to mention it', async () => {
    const rel = `${TARGET_LAYOUT.releasesDir}/${RELEASE}`;
    const nodes: Record<string, { dir: boolean }> = { [rel]: { dir: true }, [`${rel}/dist`]: { dir: true }, [`${rel}/data`]: { dir: true }, [`${rel}/.lunex-release`]: { dir: true }, [`${rel}/RELEASE_SHA`]: { dir: false } };
    const fsFake: HostFs = {
      lstatSync: (p) => {
        const n = nodes[p];
        if (!n) throw new Error(`ENOENT ${p}`);
        return { isFile: () => !n.dir, isDirectory: () => n.dir, isSymbolicLink: () => false, mode: 0o755, uid: 0, gid: 0, size: 0 };
      },
      readdirSync: (p) => Object.keys(nodes).filter((k) => k.startsWith(`${p}/`) && !k.slice(p.length + 1).includes('/')).map((k) => k.slice(p.length + 1)),
      readFileSync: () => {
        throw new Error('ENOENT');
      },
      readlinkSync: () => '',
      readTextFile: () => {
        throw new Error('ENOENT');
      },
      statUid: () => 0,
    };
    const staged = await createReadPorts({
      layout: TARGET_LAYOUT,
      releaseSha: RELEASE,
      previousSha: PREVIOUS,
      toolSha: 'a'.repeat(40),
      expectedManifestSha256: 'e'.repeat(64),
      rpcUrls: [],
      log: () => undefined,
      run: async () => ({ stdout: '' }),
      fs: fsFake,
    }).readStagedRelease();
    expect(staged.topLevel.find((e) => e.name === 'data')).toEqual({ name: 'data', type: 'd' });
    expect(evaluateReleaseLayout(staged.topLevel).code).toBe('RELEASE_LAYOUT_INVALID');
  });
});

// ------------------------------------------------------------------ prepare-release.sh

describe('prepare-release.sh structure (1, 2, 3)', () => {
  const lines = PREPARE.split('\n');
  const lineOf = (re: RegExp) => lines.findIndex((l) => re.test(l));

  it('runs the test suite ONLY in the private build workspace, never in the release tree', () => {
    expect(PREPARE).toMatch(/in_dir "\$WORK\/src" npm run "\$s"/);
    expect(PREPARE).not.toMatch(/in_dir "\$REL" npm run (test|"\$s")/);
    expect(PREPARE).not.toMatch(/cd "\$REL"[^\n]*npm run test/);
  });

  it('builds the release from the pristine archive with its own npm ci + build, HOME outside the release', () => {
    expect(PREPARE).toMatch(/unpack_verified "\$REL"/);
    expect(PREPARE).toMatch(/in_dir "\$REL" npm ci/);
    expect(PREPARE).toMatch(/in_dir "\$REL" npm run build/);
    expect(PREPARE).toMatch(/HOME="\$WORK\/home"/);
    expect(PREPARE).not.toMatch(/HOME="\$REL/);
    expect(PREPARE).toMatch(/\[ "\$\(build_hashes "\$WORK\/src"\)" = "\$\(build_hashes "\$REL"\)" \] \|\| die/);
  });

  it('runs the layout check before the seal and again after it', () => {
    const checks = lines.map((l, i) => (/bash "\$CHECK" "\$REL" "\$BLOBS" \|\| die/.test(l) ? i : -1)).filter((i) => i >= 0);
    const seal = lineOf(/chown -R root:root "\$REL"/);
    const manifest = lineOf(/install -m 0444 -o root -g root -- "\$TMPM"/);
    expect(checks).toHaveLength(2);
    expect(checks[0]).toBeLessThan(seal);
    expect(checks[1]).toBeGreaterThan(manifest);
  });

  it('the manifest excludes only the metadata dir (nothing can be hidden from it)', () => {
    expect(PREPARE).toMatch(/find \. -mindepth 1 -path \.\/\.lunex-release -prune -o -printf/);
    expect(PREPARE).not.toMatch(/\.\/\.home/);
  });

  it('the bash forbidden names are forbidden by the TypeScript gate too (rule parity)', () => {
    const caseLine = CHECK.split('\n').find((l) => l.trim().startsWith('data |')) ?? '';
    const names = caseLine.replace(/\).*$/, '').split('|').map((s) => s.trim()).filter(Boolean);
    expect(names.length).toBeGreaterThan(10);
    for (const n of names) expect(forbiddenTopLevelReason(n)).not.toBeNull();
  });
});

// Runs the real check-release-layout.sh against real trees. POSIX hosts only
// (the target host runs it as part of the suite during prepare-release).
const HAS_BASH = process.platform !== 'win32' && spawnSync('bash', ['-c', 'exit 0']).status === 0;

describe.runIf(HAS_BASH)('check-release-layout.sh on real trees (2, 3, 6, 7)', () => {
  let root: string;
  let rel: string;
  let blobs: string;
  const ARCHIVE = ['.env.example', 'package.json', 'src/index.ts', 'src/deploy/cli.ts', 'tests/a.test.ts', 'ui/src/main.ts', 'prisma/migrations/20260927000000_x/migration.sql'];
  const run = () => spawnSync('bash', [CHECK_SCRIPT, rel, blobs], { encoding: 'utf8' });
  const write = (p: string, c = 'x\n') => {
    fs.mkdirSync(join(rel, p, '..'), { recursive: true });
    fs.writeFileSync(join(rel, p), c);
  };

  beforeEach(() => {
    root = fs.mkdtempSync(join(tmpdir(), 'lunex-layout-'));
    rel = join(root, 'release');
    blobs = join(root, 'blobs.txt');
    fs.mkdirSync(rel);
    for (const p of ARCHIVE) write(p, `${p}\n`);
    fs.writeFileSync(blobs, ARCHIVE.map((p) => `${'0'.repeat(64)}  ./${p}`).join('\n') + '\n');
    write('dist/index.js');
    write('ui/dist/main.js');
    write('node_modules/x/index.js');
    write('RELEASE_SHA', `${RELEASE}\n`);
    write('.lunex-release/commit-id', `${RELEASE}\n`);
  });

  afterEach(() => {
    fs.rmSync(root, { recursive: true, force: true });
  });

  it('1/7: a clean release tree passes', () => {
    const r = run();
    expect(r.stderr).toBe('');
    expect(r.status).toBe(0);
  });

  it.each([
    ['2: the test-generated EMPTY data/ directory', () => fs.mkdirSync(join(rel, 'data')), 'forbidden top-level entry: data'],
    ['data/ holding a test database', () => write('data/test-x.db'), 'forbidden top-level entry: data'],
    ['logs/', () => fs.mkdirSync(join(rel, 'logs')), 'forbidden top-level entry: logs'],
    ['.env', () => write('.env', 'K=V\n'), 'forbidden top-level entry: .env'],
    ['.env.local', () => write('.env.local'), 'forbidden top-level entry: .env.local'],
    ['a stray db inside a tracked dir', () => write('src/stray.db'), 'file not part of the archive: src/stray.db'],
    ['an empty untracked dir inside tests', () => fs.mkdirSync(join(rel, 'tests/tmp')), 'directory not part of the archive: tests/tmp'],
    ['a top-level symlink', () => fs.symlinkSync('/etc', join(rel, 'docs')), 'top-level symlink: docs'],
    ['a missing archived file', () => fs.rmSync(join(rel, 'src/index.ts')), 'archived file missing from the release: src/index.ts'],
    ['6: a malformed (newline) name', () => write('bad\nname'), 'malformed top-level name'],
  ])('3/6: %s fails', (_label, mutate, message) => {
    mutate();
    const r = run();
    expect(r.status).toBe(1);
    expect(r.stderr).toContain(message);
  });

  it('rule parity: bash and TypeScript agree on every candidate top-level name', () => {
    const candidates = ['data', 'logs', '.env', '.env.local', '.env.example', '.home', '.npm', 'coverage', 'tmp', 'x.db', 'x.sqlite-wal', 'x.log', 'dist', 'src', 'README.md'];
    const probe = (n: string) =>
      spawnSync('bash', ['-c', `source <(sed -n '/^forbidden() {/,/^}/p' ${CHECK_SCRIPT}); forbidden "$1"`, '_', n]).status === 0;
    for (const n of candidates) expect(probe(n)).toBe(forbiddenTopLevelReason(n) !== null);
  });
});
