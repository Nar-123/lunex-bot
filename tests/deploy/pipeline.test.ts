import { describe, expect, it } from 'vitest';
import type { DbSnapshot, HealthFacts, LayoutFacts, NonceObservation, QuiescenceFacts, RollbackSourceFacts, ServiceSnapshot } from '../../src/deploy/gate';
import { RETIRED_WALLET_TRIPWIRE } from '../../src/deploy/gate';
import { runDeployment, runPlan, runRollback, type DeployPorts, type DeploymentInput, type ReadPorts, type StagedRelease } from '../../src/deploy/pipeline';

const EXECUTOR = '0x25598234c6e74370e42f3b3d7646581c68656d39';
const RELEASE = 'fb4d3306d32f61f093b41507b5e1a548cdb61863';
const PREVIOUS = 'cde2ba8a2a3393dfedf795a8f571b174e337380d';
const INPUT: DeploymentInput = { expectedReleaseSha: RELEASE, expectedPreviousSha: PREVIOUS, expectedExecutor: EXECUTOR, expectedChainId: 4663 };
const ROLLBACK_DIR = `/opt/lunex/rollback/${PREVIOUS}-20261003T000000Z`;
const INV = 'c'.repeat(32);

const MUTATING = ['probeIdentity', 'lockStart', 'unlockStart', 'stopService', 'captureJournalCursor', 'snapshotRollback', 'replaceArtifact', 'startService', 'restoreFromRollback'] as const;

const RUNNING: ServiceSnapshot = { activeState: 'active', subState: 'running', mainPid: 36477, nRestarts: 0 };
const STOPPED: ServiceSnapshot = { activeState: 'inactive', subState: 'dead', mainPid: 0, nRestarts: 0 };
const DB: DbSnapshot = { integrity: 'ok', paused: 1, opening: 0, active: 0, closing: 0, nonTerminalAttempts: 0, deployedCapitalRaw: '0', unfinishedMigrations: 0 };
const ITEMS = [
  { name: 'dist', type: 'd' as const },
  { name: 'RELEASE_SHA', type: 'f' as const },
];
const LAYOUT: LayoutFacts = { rootIsRealDirectory: true, unsafeAncestors: [], entries: [...ITEMS, { name: '.env', type: 'f' }, { name: 'data', type: 'd' }] };
const TOP_LEVEL = [...ITEMS, { name: '.lunex-release', type: 'd' as const }];
const STAGED: StagedRelease = { artifactCommitId: RELEASE, stagedReleaseSha: RELEASE, manifestVerified: true, manifestProblems: [], items: ITEMS, topLevel: TOP_LEVEL };
const MIGRATIONS = { release: [{ name: '20260927000000_x', checksum: 'c' }], db: [{ name: '20260927000000_x', checksum: 'c', finished: true, rolledBack: false }] };

interface Opts {
  executorNonces?: NonceObservation[][];
  configuredExecutor?: string;
  deployedSha?: string;
  staged?: Partial<StagedRelease>;
  layout?: (call: number) => LayoutFacts;
  quiescence?: (phaseCall: number) => Partial<QuiescenceFacts>;
  dbUnchanged?: boolean;
  verify?: 'pass' | 'fail';
  health?: Partial<HealthFacts>;
  lockFails?: boolean;
  replaceFails?: boolean;
  stopFailsAfterStart?: boolean;
  rollbackSource?: Partial<RollbackSourceFacts>;
  restoreSetsSha?: string;
}

function fake(o: Opts = {}) {
  const calls: string[] = [];
  let running = true;
  let started = false;
  let nonceReads = 0;
  let layoutCalls = 0;
  let quiescenceCalls = 0;
  let deployed = o.deployedSha ?? PREVIOUS;
  const nonces = o.executorNonces ?? [[{ source: 'rpc#1', latest: 1, pending: 1 }]];
  const read: ReadPorts = {
    log: () => undefined,
    readChainIds: async () => [{ source: 'rpc#1', chainId: 4663 }],
    readNonces: async (address) => {
      if (address === RETIRED_WALLET_TRIPWIRE.address) return [{ source: 'rpc#1', latest: 1619, pending: 1619 }];
      calls.push(`readNonces#${++nonceReads}`);
      return nonces[Math.min(nonceReads - 1, nonces.length - 1)] ?? [];
    },
    readLedgerMaxNonce: async () => 0,
    readDb: async () => DB,
    readService: async () => (running ? RUNNING : STOPPED),
    readDeployedReleaseSha: async () => deployed,
    readStagedRelease: async () => ({ ...STAGED, ...o.staged }),
    readSchema: async () => MIGRATIONS,
    readProdLayout: async () => (o.layout ? o.layout(++layoutCalls) : LAYOUT),
    readQuiescence: async () => {
      quiescenceCalls += 1;
      return { service: running ? RUNNING : STOPPED, serviceAccountPids: [], journalEntriesSinceStop: 0, startLockActive: true, ...o.quiescence?.(quiescenceCalls) };
    },
    readRollbackSource: async (dir) => ({
      dir,
      nameSha: PREVIOUS,
      rootSafe: true,
      dirType: 'd',
      appType: 'd',
      snapshotReleaseSha: PREVIOUS,
      items: ITEMS,
      forbiddenItems: [],
      ...o.rollbackSource,
    }),
  };
  const ports: DeployPorts = {
    ...read,
    probeIdentity: async () => {
      calls.push('probeIdentity');
      return { executor: o.configuredExecutor ?? EXECUTOR, chainId: 4663 };
    },
    lockStart: async () => {
      calls.push('lockStart');
      if (o.lockFails) throw new Error('install failed');
    },
    unlockStart: async () => {
      calls.push('unlockStart');
    },
    stopService: async () => {
      calls.push('stopService');
      if (started && o.stopFailsAfterStart) throw new Error('stop timed out');
      running = false;
    },
    captureJournalCursor: async () => {
      calls.push('captureJournalCursor');
      return 's=abc;i=1';
    },
    snapshotRollback: async () => {
      calls.push('snapshotRollback');
      return { dir: ROLLBACK_DIR, appCopyVerified: true, dbCopyIdentical: true, dbCopyIntegrity: 'ok' };
    },
    dbUnchangedSinceSnapshot: async () => o.dbUnchanged ?? true,
    replaceArtifact: async () => {
      calls.push('replaceArtifact');
      if (o.replaceFails) throw new Error('rsync: write failed (partial)');
      deployed = RELEASE;
    },
    verifyDeployed: async () => ({ gate: 'verify-deployed', level: o.verify ?? 'pass', code: 'X', message: 'x' }),
    startService: async () => {
      calls.push('startService');
      running = true;
      started = true;
    },
    collectHealth: async () => ({
      serviceAtEnd: RUNNING,
      pidAtStart: RUNNING.mainPid,
      invocationAtStart: INV,
      invocationAtEnd: INV,
      events: ['startup', 'api_server_started', 'telegram_bot_started'],
      errorEvents: [],
      fatalStartupLines: 0,
      signingLines: 0,
      paused: 1,
      ...o.health,
    }),
    restoreFromRollback: async () => {
      calls.push('restoreFromRollback');
      deployed = o.restoreSetsSha ?? PREVIOUS;
    },
  };
  return { ports, read, calls };
}

describe('plan (M-5)', () => {
  it('runs on ReadPorts alone -- an object with NO mutating methods -- and passes', async () => {
    const { read } = fake();
    for (const m of MUTATING) expect(m in read).toBe(false);
    const out = await runPlan(INPUT, read);
    expect(out.status).toBe('PLAN_OK');
    expect(out.service).toBe('untouched');
    expect(out.results.find((r) => r.gate === 'configured-identity')?.code).toBe('IDENTITY_NOT_PROBED');
  });

  it('would throw if plan ever reached for a mutating port (proxy trap)', async () => {
    const { read } = fake();
    const trapped = new Proxy(read, {
      get(target, prop, recv) {
        if ((MUTATING as readonly (string | symbol)[]).includes(prop)) throw new Error(`plan touched ${String(prop)}`);
        return Reflect.get(target, prop, recv) as unknown;
      },
    });
    await expect(runPlan(INPUT, trapped)).resolves.toMatchObject({ status: 'PLAN_OK' });
  });
});

describe('execute ordering and the start lock (M-2)', () => {
  it('locks BEFORE stop, checks four times, unlocks only right before start', async () => {
    const { ports, calls } = fake();
    const out = await runDeployment(INPUT, ports);
    expect(out.status).toBe('DEPLOYED');
    expect(calls).toEqual([
      'probeIdentity',
      'readNonces#1',
      'lockStart',
      'stopService',
      'captureJournalCursor',
      'readNonces#2',
      'snapshotRollback',
      'readNonces#3',
      'replaceArtifact',
      'readNonces#4',
      'unlockStart',
      'startService',
    ]);
  });

  it('a lock failure aborts before stop -- service untouched, never unlocked', async () => {
    const { ports, calls } = fake({ lockFails: true });
    const out = await runDeployment(INPUT, ports);
    expect(out).toMatchObject({ status: 'ABORTED', abortedAt: 'lock', service: 'untouched' });
    expect(calls).not.toContain('stopService');
    expect(calls).not.toContain('unlockStart');
  });

  it('post-stop failure: aborted, service left stopped AND locked (no unlock, no start)', async () => {
    const { ports, calls } = fake({ executorNonces: [[{ source: 'rpc#1', latest: 1, pending: 1 }], [{ source: 'rpc#1', latest: 2, pending: 2 }]] });
    const out = await runDeployment(INPUT, ports);
    expect(out).toMatchObject({ status: 'ABORTED', abortedAt: 'post-stop', service: 'stopped' });
    for (const c of ['snapshotRollback', 'replaceArtifact', 'unlockStart', 'startService']) expect(calls).not.toContain(c);
  });

  it('a service restart attempt seen right before the swap aborts without writing', async () => {
    // quiescence call 1 = post-stop (quiet), call 2 = pre-replace (someone tried to start it)
    const { ports, calls } = fake({ quiescence: (n) => (n === 2 ? { journalEntriesSinceStop: 3 } : {}) });
    const out = await runDeployment(INPUT, ports);
    expect(out).toMatchObject({ status: 'ABORTED', abortedAt: 'pre-replace' });
    expect(calls).not.toContain('replaceArtifact');
    expect(calls).not.toContain('unlockStart');
  });

  it('a service restart DURING replace is detected after it: stopped again, re-locked, never unlocked or started', async () => {
    // quiescence call 3 = post-replace: the service is running on a half-written tree
    const { ports, calls } = fake({ quiescence: (n) => (n === 3 ? { service: RUNNING, serviceAccountPids: [9999] } : {}) });
    const out = await runDeployment(INPUT, ports);
    expect(out).toMatchObject({ status: 'FAILED_AFTER_REPLACE', abortedAt: 'post-replace', service: 'stopped' });
    expect(calls.filter((c) => c === 'stopService')).toHaveLength(2);
    expect(calls.filter((c) => c === 'lockStart')).toHaveLength(2);
    expect(calls).not.toContain('unlockStart');
    expect(calls).not.toContain('startService');
  });

  it('a partial replace failure is FAILED_AFTER_REPLACE with the snapshot, stopped and still locked', async () => {
    const { ports, calls } = fake({ replaceFails: true });
    const out = await runDeployment(INPUT, ports);
    expect(out).toMatchObject({ status: 'FAILED_AFTER_REPLACE', abortedAt: 'replace', service: 'stopped', rollbackDir: ROLLBACK_DIR });
    expect(calls).not.toContain('unlockStart');
  });

  it('a symlink appearing in production before the swap aborts (layout re-checked at pre-replace)', async () => {
    // layout call 1 = pre-stop, 2 = post-stop, 3 = pre-replace
    const { ports, calls } = fake({ layout: (n) => (n === 3 ? { ...LAYOUT, entries: [{ name: 'dist', type: 'l' }] } : LAYOUT) });
    const out = await runDeployment(INPUT, ports);
    expect(out.abortedAt).toBe('pre-replace');
    expect(out.results.some((r) => r.code === 'PROD_SYMLINK')).toBe(true);
    expect(calls).not.toContain('replaceArtifact');
  });

  it('health failure stops and re-locks the service', async () => {
    const { ports, calls } = fake({ health: { fatalStartupLines: 1 } });
    const out = await runDeployment(INPUT, ports);
    expect(out).toMatchObject({ status: 'FAILED_AFTER_REPLACE', abortedAt: 'health', service: 'stopped' });
    expect(calls.slice(-3)).toEqual(['startService', 'stopService', 'lockStart']);
  });

  it('cleanup failure (stop after a failed health check fails) reports service unknown, never claims stopped', async () => {
    const { ports, calls } = fake({ health: { serviceAtEnd: { ...RUNNING, nRestarts: 2 } }, stopFailsAfterStart: true });
    const out = await runDeployment(INPUT, ports);
    expect(out).toMatchObject({ status: 'FAILED_AFTER_REPLACE', abortedAt: 'health', service: 'unknown' });
    // the re-lock is still attempted even though the stop failed
    expect(calls.slice(-2)).toEqual(['stopService', 'lockStart']);
  });

  it('a NEEDS_VERIFICATION health result deploys but is flagged, never silently clean', async () => {
    const { ports } = fake({ health: { errorEvents: [{ event: 'exit_cycle_error', messageClass: 'x' }] } });
    const out = await runDeployment(INPUT, ports);
    expect(out).toMatchObject({ status: 'DEPLOYED', needsVerification: true });
  });
});

describe('execute gates (unchanged contracts)', () => {
  it('wrong executor in the production configuration aborts before the lock', async () => {
    const { ports, calls } = fake({ configuredExecutor: '0x7d22bd54152f8ead57edb0077a6e9f8a7fc76ddb' });
    const out = await runDeployment(INPUT, ports);
    expect(out.abortedAt).toBe('pre-stop');
    expect(calls).not.toContain('lockStart');
  });
  it('a release that fails manifest/seal verification aborts before the lock', async () => {
    const { ports, calls } = fake({ staged: { manifestVerified: false, manifestProblems: ['dist/index.js is group/other-writable'] } });
    const out = await runDeployment(INPUT, ports);
    expect(out.abortedAt).toBe('pre-stop');
    expect(calls).not.toContain('lockStart');
  });
  it('wrong previous release aborts before the lock', async () => {
    const { ports, calls } = fake({ deployedSha: '1780220e5a9c9f80e0246cb513df6a3c5c45ccf9' });
    expect((await runDeployment(INPUT, ports)).abortedAt).toBe('pre-stop');
    expect(calls).not.toContain('lockStart');
  });
  it('a DB that changed after the snapshot aborts before the swap', async () => {
    const { ports, calls } = fake({ dbUnchanged: false });
    expect((await runDeployment(INPUT, ports)).abortedAt).toBe('pre-replace');
    expect(calls).not.toContain('replaceArtifact');
  });
});

describe('rollback (M-3): validated before ANY write', () => {
  const noWrites = (calls: string[]) => {
    for (const m of ['lockStart', 'stopService', 'restoreFromRollback', 'unlockStart', 'startService']) expect(calls).not.toContain(m);
  };
  it.each([
    ['wrong rollback SHA', { nameSha: '1780220e5a9c9f80e0246cb513df6a3c5c45ccf9' }, 'ROLLBACK_DIR_SHA_MISMATCH'],
    ['wrong RELEASE_SHA inside the snapshot', { snapshotReleaseSha: '1780220e5a9c9f80e0246cb513df6a3c5c45ccf9' }, 'ROLLBACK_RELEASE_SHA_MISMATCH'],
    ['malformed rollback dir', { nameSha: null }, 'ROLLBACK_DIR_MALFORMED'],
    ['symlink rollback dir', { dirType: 'l' as const }, 'ROLLBACK_DIR_NOT_DIRECTORY'],
  ])('%s: aborted at validate, production untouched', async (_l, source, code) => {
    const { ports, calls } = fake({ rollbackSource: source });
    const out = await runRollback({ expectedPreviousSha: PREVIOUS, rollbackDir: ROLLBACK_DIR }, ports);
    expect(out).toMatchObject({ status: 'ABORTED', abortedAt: 'validate', service: 'untouched' });
    expect(out.results[0]?.code).toBe(code);
    noWrites(calls);
  });

  it('valid rollback: lock, stop, restore, unlock, start', async () => {
    const { ports, calls } = fake({ deployedSha: RELEASE });
    const out = await runRollback({ expectedPreviousSha: PREVIOUS, rollbackDir: ROLLBACK_DIR }, ports);
    expect(out.status).toBe('ROLLED_BACK');
    expect(calls).toEqual(['lockStart', 'stopService', 'captureJournalCursor', 'restoreFromRollback', 'unlockStart', 'startService']);
  });

  it('restore failure is ROLLBACK_FAILED, stopped, still locked', async () => {
    const { ports, calls } = fake({ deployedSha: RELEASE });
    ports.restoreFromRollback = async () => {
      calls.push('restoreFromRollback');
      throw new Error('restored dist does not match the snapshot');
    };
    const out = await runRollback({ expectedPreviousSha: PREVIOUS, rollbackDir: ROLLBACK_DIR }, ports);
    expect(out).toMatchObject({ status: 'ROLLBACK_FAILED', abortedAt: 'restore', service: 'stopped' });
    expect(calls).not.toContain('unlockStart');
  });

  it('a restore that does not bring back the previous RELEASE_SHA is not started', async () => {
    const { ports, calls } = fake({ deployedSha: RELEASE, restoreSetsSha: RELEASE });
    const out = await runRollback({ expectedPreviousSha: PREVIOUS, rollbackDir: ROLLBACK_DIR }, ports);
    expect(out.status).toBe('ROLLBACK_FAILED');
    expect(calls).not.toContain('startService');
  });
});
