import { describe, expect, it } from 'vitest';
import {
  evaluateHealth,
  evaluateProdLayout,
  evaluateQuiescence,
  evaluateRollbackSource,
  evaluateSchema,
  type HealthFacts,
  type LayoutFacts,
  type QuiescenceFacts,
  type RollbackSourceFacts,
} from '../../src/deploy/gate';

const PREVIOUS = 'cde2ba8a2a3393dfedf795a8f571b174e337380d';
const OTHER = '1780220e5a9c9f80e0246cb513df6a3c5c45ccf9';

describe('schema gate (M-4)', () => {
  const m = (name: string, checksum = `c-${name}`) => ({ name, checksum });
  const applied = (name: string, checksum = `c-${name}`) => ({ name, checksum, finished: true, rolledBack: false });

  it('identical migration sets pass', () => {
    expect(evaluateSchema([m('a'), m('b')], [applied('a'), applied('b')]).level).toBe('pass');
  });
  it('a release that needs a migration is blocked (the gate never migrates)', () => {
    expect(evaluateSchema([m('a'), m('b')], [applied('a')]).code).toBe('MIGRATION_REQUIRED');
  });
  it('a database ahead of the release (downgrade) is blocked', () => {
    expect(evaluateSchema([m('a')], [applied('a'), applied('b')]).code).toBe('DB_AHEAD_OF_RELEASE');
  });
  it('an edited migration file is blocked', () => {
    expect(evaluateSchema([m('a', 'x')], [applied('a', 'y')]).code).toBe('MIGRATION_CHECKSUM_MISMATCH');
  });
  it('an unfinished or rolled-back migration is blocked', () => {
    expect(evaluateSchema([m('a')], [{ ...applied('a'), finished: false }]).code).toBe('DB_MIGRATION_UNFINISHED');
    expect(evaluateSchema([m('a')], [{ ...applied('a'), rolledBack: true }]).code).toBe('DB_MIGRATION_UNFINISHED');
  });
  it('a release with no migrations at all is refused rather than trivially passed', () => {
    expect(evaluateSchema([], [applied('a')]).code).toBe('RELEASE_HAS_NO_MIGRATIONS');
  });
});

describe('production layout gate (H-1)', () => {
  const safe: LayoutFacts = {
    rootIsRealDirectory: true,
    unsafeAncestors: [],
    entries: [
      { name: 'dist', type: 'd' },
      { name: 'ops', type: 'd' },
      { name: 'package.json', type: 'f' },
      { name: '.env', type: 'f' },
    ],
  };
  const release = [
    { name: 'dist', type: 'd' as const },
    { name: 'ops', type: 'd' as const },
    { name: 'package.json', type: 'f' as const },
  ];

  it('plain files and directories pass', () => {
    expect(evaluateProdLayout(safe, release).level).toBe('pass');
  });
  it.each([
    ['a symlinked target directory (dist)', 'dist'],
    ['a symlinked ops directory', 'ops'],
    ['a symlinked target file', 'package.json'],
    ['a symlink the release does not even touch', '.env'],
  ])('%s fails closed', (_l, name) => {
    const facts = { ...safe, entries: safe.entries.map((e) => (e.name === name ? { ...e, type: 'l' as const } : e)) };
    expect(evaluateProdLayout(facts, release).code).toBe('PROD_SYMLINK');
  });
  it('a production root that is itself a symlink fails', () => {
    expect(evaluateProdLayout({ ...safe, rootIsRealDirectory: false }, release).code).toBe('PROD_ROOT_NOT_DIRECTORY');
  });
  it('a writable or non-root ancestor fails', () => {
    expect(evaluateProdLayout({ ...safe, unsafeAncestors: ['/opt/lunex'] }, release).code).toBe('PROD_ANCESTOR_UNSAFE');
  });
  it('a type mismatch (file where the release has a directory) fails', () => {
    const facts = { ...safe, entries: safe.entries.map((e) => (e.name === 'dist' ? { ...e, type: 'f' as const } : e)) };
    expect(evaluateProdLayout(facts, release).code).toBe('PROD_TYPE_MISMATCH');
  });
});

describe('quiescence gate (M-2)', () => {
  const quiet: QuiescenceFacts = {
    service: { activeState: 'inactive', subState: 'dead', mainPid: 0, nRestarts: 0 },
    serviceAccountPids: [],
    journalEntriesSinceStop: 0,
    startLockActive: true,
  };
  it('stopped, locked, no process, no journal activity passes', () => {
    expect(evaluateQuiescence('pre-replace', quiet).level).toBe('pass');
  });
  it.each([
    ['the service running again', { service: { activeState: 'active', subState: 'running', mainPid: 4242, nRestarts: 0 } }],
    ['a stray service-account process', { serviceAccountPids: [4242] }],
    ['a start attempt in the journal (even if it stopped again)', { journalEntriesSinceStop: 2 }],
    ['the start lock missing', { startLockActive: false }],
  ])('%s fails', (_l, over) => {
    expect(evaluateQuiescence('pre-replace', { ...quiet, ...over }).code).toBe('NOT_QUIESCENT');
  });
});

describe('rollback source gate (M-3)', () => {
  const valid: RollbackSourceFacts = {
    dir: `/opt/lunex/rollback/${PREVIOUS}-20261003T000000Z`,
    nameSha: PREVIOUS,
    rootSafe: true,
    dirType: 'd',
    appType: 'd',
    snapshotReleaseSha: PREVIOUS,
    items: [
      { name: 'dist', type: 'd' },
      { name: 'RELEASE_SHA', type: 'f' },
    ],
    forbiddenItems: [],
  };
  it('a valid snapshot of the expected previous release passes', () => {
    expect(evaluateRollbackSource(PREVIOUS, valid).level).toBe('pass');
  });
  it('wrong rollback SHA (directory name) fails', () => {
    expect(evaluateRollbackSource(PREVIOUS, { ...valid, nameSha: OTHER }).code).toBe('ROLLBACK_DIR_SHA_MISMATCH');
  });
  it('wrong RELEASE_SHA inside the snapshot fails', () => {
    expect(evaluateRollbackSource(PREVIOUS, { ...valid, snapshotReleaseSha: OTHER }).code).toBe('ROLLBACK_RELEASE_SHA_MISMATCH');
    expect(evaluateRollbackSource(PREVIOUS, { ...valid, snapshotReleaseSha: null }).code).toBe('ROLLBACK_RELEASE_SHA_MISMATCH');
  });
  it('malformed rollback dir fails', () => {
    expect(evaluateRollbackSource(PREVIOUS, { ...valid, nameSha: null }).code).toBe('ROLLBACK_DIR_MALFORMED');
  });
  it('symlink rollback dir (or app dir) fails', () => {
    expect(evaluateRollbackSource(PREVIOUS, { ...valid, dirType: 'l' }).code).toBe('ROLLBACK_DIR_NOT_DIRECTORY');
    expect(evaluateRollbackSource(PREVIOUS, { ...valid, appType: 'l' }).code).toBe('ROLLBACK_DIR_NOT_DIRECTORY');
  });
  it('an unsafe rollback root, a symlinked item or a protected item fails', () => {
    expect(evaluateRollbackSource(PREVIOUS, { ...valid, rootSafe: false }).code).toBe('ROLLBACK_ROOT_UNSAFE');
    expect(evaluateRollbackSource(PREVIOUS, { ...valid, items: [{ name: 'dist', type: 'l' }] }).code).toBe('ROLLBACK_HAS_SYMLINK');
    expect(evaluateRollbackSource(PREVIOUS, { ...valid, forbiddenItems: ['.env'] }).code).toBe('ROLLBACK_HAS_PROTECTED_ITEM');
  });
});

describe('health gate (M-6)', () => {
  const inv = 'a'.repeat(32);
  const healthy: HealthFacts = {
    serviceAtEnd: { activeState: 'active', subState: 'running', mainPid: 5000, nRestarts: 0 },
    pidAtStart: 5000,
    invocationAtStart: inv,
    invocationAtEnd: inv,
    // the startup order observed on production
    events: ['startup', 'execution_targets_verified', 'monitoring_cycle', 'screening_cycle', 'api_server_started', 'telegram_bot_started', 'exit_cycle'],
    errorEvents: [],
    fatalStartupLines: 0,
    signingLines: 0,
    paused: 1,
  };

  it('the production startup sequence is healthy', () => {
    expect(evaluateHealth(healthy).level).toBe('pass');
  });
  it('the proven-benign gmgn-missing screening error does not fail or warn', () => {
    const r = evaluateHealth({ ...healthy, errorEvents: [{ event: 'screening_cycle_error', messageClass: 'gmgn-cli command failed after 3 attempt(s): gmgn-cli market' }] });
    expect(r.level).toBe('pass');
  });
  it('an error event not proven benign is NEEDS_VERIFICATION -- not a failure, not a silent pass', () => {
    const r = evaluateHealth({ ...healthy, errorEvents: [{ event: 'exit_cycle_error', messageClass: 'x' }] });
    expect(r.level).toBe('warn');
    expect(r.code).toBe('NEEDS_VERIFICATION');
  });
  it('a screening error with a DIFFERENT cause is not treated as the benign one', () => {
    expect(evaluateHealth({ ...healthy, errorEvents: [{ event: 'screening_cycle_error', messageClass: 'database is locked' }] }).level).toBe('warn');
  });
  it.each([
    ['a restart', { serviceAtEnd: { ...healthy.serviceAtEnd, nRestarts: 1 } }],
    ['a MainPID change', { serviceAtEnd: { ...healthy.serviceAtEnd, mainPid: 5001 } }],
    ['the service not running', { serviceAtEnd: { ...healthy.serviceAtEnd, activeState: 'activating', subState: 'auto-restart' } }],
    ['a fatal startup error', { fatalStartupLines: 1 }],
    ['a signing line', { signingLines: 1 }],
    ['unpaused', { paused: 0 }],
    ['startup never completed', { events: ['startup'] }],
    ['telegram failing to start', { events: [...healthy.events.filter((e) => e !== 'telegram_bot_started'), 'telegram_bot_start_failed'] }],
    ['telegram never reporting', { events: healthy.events.filter((e) => e !== 'telegram_bot_started') }],
    ['a different invocation at the end', { invocationAtEnd: 'b'.repeat(32) }],
  ])('%s is UNHEALTHY', (_l, over) => {
    expect(evaluateHealth({ ...healthy, ...over }).code).toBe('UNHEALTHY');
  });
});
