import {
  evaluateChainId,
  evaluateDbHealth,
  evaluateExecutorNonce,
  evaluateHealth,
  evaluateOldWalletTripwire,
  evaluatePreviousRelease,
  evaluateProdLayout,
  evaluateQuiescence,
  evaluateReleaseIdentity,
  evaluateReleaseLayout,
  evaluateRollbackReady,
  forbiddenTopLevelReason,
  RELEASE_METADATA_DIR,
  evaluateRollbackSource,
  evaluateSchema,
  evaluateServiceRunning,
  hasFailure,
  RETIRED_WALLET_TRIPWIRE,
  type AppliedMigration,
  type DbSnapshot,
  type EntryType,
  type GateResult,
  type HealthFacts,
  type LayoutFacts,
  type MigrationRecord,
  type NonceObservation,
  type QuiescenceFacts,
  type RollbackSnapshot,
  type RollbackSourceFacts,
  type ServiceSnapshot,
} from './gate';

/**
 * Deployment and rollback sequences, written against injected ports so the
 * ORDER of operations -- and every abort -- is unit-tested.
 *
 *   plan        read-only gates only (ReadPorts: the type has no mutating method)
 *   execute     identity probe -> read-only gates -> start-lock -> stop -> journal cursor
 *               -> post-stop  (quiescence, layout, DB, schema, nonce #2)
 *               -> snapshot   (rollback copy of app + DB, verified)
 *               -> pre-replace(quiescence, layout, DB unchanged, release re-verified, nonce #3)
 *               -> replace
 *               -> post-replace (quiescence, release re-verified, deployed bytes, layout, nonce #4)
 *               -> unlock -> start -> health
 *
 * No fallback anywhere: a failed gate ends the run and every later step is
 * simply never called. Every failure before start leaves the service STOPPED
 * and START-LOCKED; the lock is released only on the path that starts it. A
 * failed health check stops the service and re-locks it.
 */

export interface DeploymentInput {
  expectedReleaseSha: string;
  expectedPreviousSha: string;
  expectedExecutor: string;
  expectedChainId: number;
}

export interface StagedRelease {
  artifactCommitId: string;
  stagedReleaseSha: string;
  manifestVerified: boolean;
  manifestProblems: string[];
  /** Top-level items from the anchored manifest -- the authoritative replace set. */
  items: { name: string; type: EntryType }[];
  /** The release directory's top level as it ACTUALLY exists on disk (lstat), metadata dir included. */
  topLevel: { name: string; type: EntryType }[];
}

export type ReleaseItems = readonly { name: string; type: EntryType }[];

/** Pure reads. Plan receives ONLY this. */
export interface ReadPorts {
  log(event: string, data?: Record<string, unknown>): void;
  readChainIds(): Promise<{ source: string; chainId: number }[]>;
  readNonces(address: string): Promise<NonceObservation[]>;
  readLedgerMaxNonce(executor: string): Promise<number | null>;
  readDb(): Promise<DbSnapshot>;
  readService(): Promise<ServiceSnapshot>;
  readDeployedReleaseSha(): Promise<string>;
  readStagedRelease(): Promise<StagedRelease>;
  readSchema(): Promise<{ release: MigrationRecord[]; db: AppliedMigration[] }>;
  readProdLayout(): Promise<LayoutFacts>;
  readQuiescence(cursor: string): Promise<QuiescenceFacts>;
  readRollbackSource(dir: string): Promise<RollbackSourceFacts>;
}

export interface DeployPorts extends ReadPorts {
  /** Runs the identity probe unit (a systemd start) -- never part of plan. */
  probeIdentity(): Promise<{ executor: string; chainId: number }>;
  lockStart(): Promise<void>;
  unlockStart(): Promise<void>;
  stopService(): Promise<void>;
  captureJournalCursor(): Promise<string>;
  snapshotRollback(items: ReleaseItems): Promise<RollbackSnapshot>;
  dbUnchangedSinceSnapshot(): Promise<boolean>;
  replaceArtifact(items: ReleaseItems): Promise<void>;
  verifyDeployed(items: ReleaseItems): Promise<GateResult>;
  startService(): Promise<void>;
  collectHealth(): Promise<HealthFacts>;
  restoreFromRollback(dir: string, items: ReleaseItems): Promise<void>;
}

export type DeployStatus = 'PLAN_OK' | 'ABORTED' | 'DEPLOYED' | 'FAILED_AFTER_REPLACE' | 'ROLLED_BACK' | 'ROLLBACK_FAILED';

export interface DeployOutcome {
  status: DeployStatus;
  abortedAt?: string;
  service: 'untouched' | 'stopped' | 'started' | 'unknown';
  /** Health passed structurally but an error event is not proven benign. */
  needsVerification?: boolean;
  results: GateResult[];
  rollbackDir?: string;
}

async function guarded<T>(gate: string, read: () => Promise<T>): Promise<T | GateResult> {
  try {
    return await read();
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    return { gate, level: 'fail', code: 'READ_FAILED', message: `${gate}: ${message}` };
  }
}

function isGateResult(v: unknown): v is GateResult {
  return typeof v === 'object' && v !== null && 'level' in v && 'gate' in v && 'code' in v;
}

function errMsg(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

class Recorder {
  readonly results: GateResult[] = [];
  constructor(private readonly log: ReadPorts['log']) {}
  add(r: GateResult): void {
    this.results.push(r);
    this.log('gate', { ...r });
  }
  failed(): boolean {
    return hasFailure(this.results);
  }
}

async function executorNonceGate(phase: string, input: DeploymentInput, executor: string, ports: ReadPorts): Promise<GateResult> {
  const observations = await guarded(`executor-nonce:${phase}`, () => ports.readNonces(executor));
  if (isGateResult(observations)) return observations;
  const ledgerMax = await guarded(`executor-ledger:${phase}`, () => ports.readLedgerMaxNonce(executor));
  if (isGateResult(ledgerMax)) return ledgerMax;
  return evaluateExecutorNonce({ phase, expectedExecutor: input.expectedExecutor, configuredExecutor: executor, observations, ledgerMaxNonce: ledgerMax });
}

async function stagedReleaseGate(input: DeploymentInput, ports: ReadPorts, rec: Recorder): Promise<StagedRelease | null> {
  const staged = await guarded('release-identity', () => ports.readStagedRelease());
  if (isGateResult(staged)) {
    rec.add(staged);
    return null;
  }
  const r = evaluateReleaseIdentity({
    expectedReleaseSha: input.expectedReleaseSha,
    artifactCommitId: staged.artifactCommitId,
    stagedReleaseSha: staged.stagedReleaseSha,
    stagedManifestVerified: staged.manifestVerified,
  });
  rec.add(r.level === 'fail' && staged.manifestProblems.length > 0 ? { ...r, details: { problems: staged.manifestProblems.slice(0, 20) } } : r);
  // The release tree itself, independent of the manifest: a forbidden or
  // malformed top-level entry fails here -- in plan, and in execute before the
  // start lock and the stop -- never later in snapshot or replace.
  const layout = r.code === 'RELEASE_NOT_STAGED' ? null : evaluateReleaseLayout(staged.topLevel);
  if (layout) rec.add(layout);
  if (r.level === 'fail' || layout?.level === 'fail') return null;
  // Defence in depth: the replace set never contains a forbidden name, whatever the manifest says.
  return { ...staged, items: staged.items.filter((i) => forbiddenTopLevelReason(i.name) === null && i.name !== RELEASE_METADATA_DIR) };
}

async function layoutGate(ports: ReadPorts, items: ReleaseItems, rec: Recorder): Promise<void> {
  const layout = await guarded('prod-layout', () => ports.readProdLayout());
  rec.add(isGateResult(layout) ? layout : evaluateProdLayout(layout, items));
}

async function quiescenceGate(phase: string, cursor: string, ports: ReadPorts, rec: Recorder): Promise<void> {
  const q = await guarded(`quiescent:${phase}`, () => ports.readQuiescence(cursor));
  rec.add(isGateResult(q) ? q : evaluateQuiescence(phase, q));
}

async function dbAndSchemaGates(ports: ReadPorts, rec: Recorder): Promise<void> {
  const db = await guarded('database', () => ports.readDb());
  rec.add(isGateResult(db) ? db : evaluateDbHealth(db));
  const schema = await guarded('schema', () => ports.readSchema());
  rec.add(isGateResult(schema) ? schema : evaluateSchema(schema.release, schema.db));
}

/**
 * The read-only gate set. `configured` is the identity derived from the
 * production configuration (execute), or null in plan, where the probe is
 * deliberately NOT run and the expected executor is checked on chain instead.
 */
async function readOnlyGates(input: DeploymentInput, ports: ReadPorts, configured: { executor: string; chainId: number } | null, rec: Recorder): Promise<StagedRelease | null> {
  if (configured === null) {
    rec.add({ gate: 'configured-identity', level: 'warn', code: 'IDENTITY_NOT_PROBED', message: 'plan does not run the identity probe; `verify-identity` or `execute` confirms production is configured for the expected executor' });
  }
  const chainIds = await guarded('chain-id', () => ports.readChainIds());
  rec.add(isGateResult(chainIds) ? chainIds : evaluateChainId(input.expectedChainId, configured?.chainId ?? input.expectedChainId, chainIds));
  const staged = await stagedReleaseGate(input, ports, rec);
  const deployed = await guarded('previous-release', () => ports.readDeployedReleaseSha());
  rec.add(isGateResult(deployed) ? deployed : evaluatePreviousRelease(input.expectedPreviousSha, deployed));
  await dbAndSchemaGates(ports, rec);
  const service = await guarded('service-running', () => ports.readService());
  rec.add(isGateResult(service) ? service : evaluateServiceRunning(service));
  await layoutGate(ports, staged?.items ?? [], rec);
  rec.add(await executorNonceGate('pre-stop', input, configured?.executor ?? input.expectedExecutor, ports));
  const retired = await ports.readNonces(RETIRED_WALLET_TRIPWIRE.address).catch(() => [] as NonceObservation[]);
  rec.add(evaluateOldWalletTripwire(retired));
  return staged;
}

/** `plan`: read-only by construction -- it is handed ReadPorts only. */
export async function runPlan(input: DeploymentInput, ports: ReadPorts): Promise<DeployOutcome> {
  const rec = new Recorder((event, data) => { ports.log(event, data); });
  await readOnlyGates(input, ports, null, rec);
  return rec.failed() ? { status: 'ABORTED', abortedAt: 'plan', service: 'untouched', results: rec.results } : { status: 'PLAN_OK', service: 'untouched', results: rec.results };
}

/** Failure after the service was started: stop it and put the start lock back. */
async function stopAndRelock(ports: DeployPorts): Promise<DeployOutcome['service']> {
  const stopped = await ports.stopService().then(
    () => true,
    () => false,
  );
  const relocked = await ports.lockStart().then(
    () => true,
    () => false,
  );
  ports.log('stopped_and_relocked', { stopped, relocked });
  return stopped ? 'stopped' : 'unknown';
}

export async function runDeployment(input: DeploymentInput, ports: DeployPorts): Promise<DeployOutcome> {
  const rec = new Recorder((event, data) => { ports.log(event, data); });
  const out = (status: DeployStatus, abortedAt: string | undefined, service: DeployOutcome['service'], rollbackDir?: string, needsVerification?: boolean): DeployOutcome => {
    ports.log('deploy_outcome', { status, abortedAt, service });
    return { status, ...(abortedAt && { abortedAt }), service, results: rec.results, ...(rollbackDir && { rollbackDir }), ...(needsVerification && { needsVerification }) };
  };

  // --- identity + read-only gates (nothing touched yet) ---------------------------
  const identity = await guarded('configured-identity', () => ports.probeIdentity());
  if (isGateResult(identity)) {
    rec.add(identity);
    return out('ABORTED', 'identity', 'untouched');
  }
  const staged = await readOnlyGates(input, ports, identity, rec);
  if (rec.failed() || staged === null) return out('ABORTED', 'pre-stop', 'untouched');
  const items = staged.items;
  const executor = identity.executor;

  // --- lock, then stop: nothing can start the service from here on ---------------
  try {
    await ports.lockStart();
  } catch (err) {
    rec.add({ gate: 'start-lock', level: 'fail', code: 'LOCK_FAILED', message: `could not install the start lock: ${errMsg(err)} (the service is still running)` });
    return out('ABORTED', 'lock', 'untouched');
  }
  try {
    await ports.stopService();
  } catch (err) {
    rec.add({ gate: 'stop', level: 'fail', code: 'STOP_FAILED', message: `systemctl stop failed: ${errMsg(err)}` });
    return out('ABORTED', 'stop', 'unknown');
  }
  const cursor = await guarded('journal-cursor', () => ports.captureJournalCursor());
  if (isGateResult(cursor)) {
    rec.add(cursor);
    return out('ABORTED', 'post-stop', 'stopped');
  }

  // --- post-stop ----------------------------------------------------------------
  await quiescenceGate('post-stop', cursor, ports, rec);
  await layoutGate(ports, items, rec);
  await dbAndSchemaGates(ports, rec);
  rec.add(await executorNonceGate('post-stop', input, executor, ports));
  if (rec.failed()) return out('ABORTED', 'post-stop', 'stopped');

  // --- rollback snapshot -----------------------------------------------------------
  const snapshot = await guarded('rollback-ready', () => ports.snapshotRollback(items));
  rec.add(isGateResult(snapshot) ? snapshot : evaluateRollbackReady(snapshot));
  const rollbackDir = isGateResult(snapshot) ? undefined : snapshot.dir;
  if (rec.failed()) return out('ABORTED', 'snapshot', 'stopped', rollbackDir);

  // --- pre-replace: immediately before the first production write ------------------
  await quiescenceGate('pre-replace', cursor, ports, rec);
  await layoutGate(ports, items, rec);
  const unchanged = await guarded('database-unchanged', () => ports.dbUnchangedSinceSnapshot());
  rec.add(
    isGateResult(unchanged)
      ? unchanged
      : unchanged
        ? { gate: 'database-unchanged', level: 'pass', code: 'DB_UNCHANGED', message: 'production DB is byte-identical to the rollback copy' }
        : { gate: 'database-unchanged', level: 'fail', code: 'DB_CHANGED', message: 'production DB changed after the rollback copy was taken' },
  );
  await stagedReleaseGate(input, ports, rec);
  rec.add(await executorNonceGate('pre-replace', input, executor, ports));
  if (rec.failed()) return out('ABORTED', 'pre-replace', 'stopped', rollbackDir);

  // --- replace ----------------------------------------------------------------------
  try {
    await ports.replaceArtifact(items);
  } catch (err) {
    rec.add({ gate: 'replace', level: 'fail', code: 'REPLACE_FAILED', message: `artifact replacement failed part-way: ${errMsg(err)}` });
    return out('FAILED_AFTER_REPLACE', 'replace', 'stopped', rollbackDir);
  }

  // --- post-replace: was anything started while we were writing? -------------------
  await quiescenceGate('post-replace', cursor, ports, rec);
  if (rec.failed()) {
    const service = await stopAndRelock(ports);
    return out('FAILED_AFTER_REPLACE', 'post-replace', service, rollbackDir);
  }
  await stagedReleaseGate(input, ports, rec);
  const verified = await guarded('verify-deployed', () => ports.verifyDeployed(items));
  rec.add(verified);
  await layoutGate(ports, items, rec);
  rec.add(await executorNonceGate('pre-start', input, executor, ports));
  if (rec.failed()) return out('FAILED_AFTER_REPLACE', 'verify', 'stopped', rollbackDir);

  // --- the ONLY path that releases the lock: start + health --------------------------
  try {
    await ports.unlockStart();
  } catch (err) {
    rec.add({ gate: 'start-unlock', level: 'fail', code: 'UNLOCK_FAILED', message: `could not release the start lock: ${errMsg(err)}` });
    return out('FAILED_AFTER_REPLACE', 'unlock', 'stopped', rollbackDir);
  }
  let health: GateResult;
  try {
    await ports.startService();
    const facts = await guarded('health', () => ports.collectHealth());
    health = isGateResult(facts) ? facts : evaluateHealth(facts);
  } catch (err) {
    health = { gate: 'health', level: 'fail', code: 'START_FAILED', message: `systemctl start failed: ${errMsg(err)}` };
  }
  rec.add(health);
  if (health.level === 'fail') {
    const service = await stopAndRelock(ports);
    return out('FAILED_AFTER_REPLACE', 'health', service, rollbackDir);
  }
  return out('DEPLOYED', undefined, 'started', rollbackDir, health.level === 'warn');
}

/**
 * Puts a rollback snapshot back -- code only; the DB copy is kept, never
 * restored automatically (this tool never migrates, so the restored code meets
 * the same schema it ran against). The snapshot is fully validated BEFORE any
 * write: name SHA, root safety, directory types, the snapshot's own RELEASE_SHA.
 */
export async function runRollback(input: { expectedPreviousSha: string; rollbackDir: string }, ports: DeployPorts): Promise<DeployOutcome> {
  const rec = new Recorder((event, data) => { ports.log(event, data); });
  const out = (status: DeployStatus, abortedAt: string | undefined, service: DeployOutcome['service'], needsVerification?: boolean): DeployOutcome => ({
    status,
    ...(abortedAt && { abortedAt }),
    service,
    results: rec.results,
    rollbackDir: input.rollbackDir,
    ...(needsVerification && { needsVerification }),
  });

  const source = await guarded('rollback-source', () => ports.readRollbackSource(input.rollbackDir));
  const verdict = isGateResult(source) ? source : evaluateRollbackSource(input.expectedPreviousSha, source);
  rec.add(verdict);
  if (verdict.level === 'fail' || isGateResult(source)) return out('ABORTED', 'validate', 'untouched');
  const items = source.items;

  try {
    await ports.lockStart();
  } catch (err) {
    rec.add({ gate: 'start-lock', level: 'fail', code: 'LOCK_FAILED', message: `could not install the start lock: ${errMsg(err)}` });
    return out('ABORTED', 'lock', 'untouched');
  }
  try {
    await ports.stopService();
  } catch (err) {
    rec.add({ gate: 'stop', level: 'fail', code: 'STOP_FAILED', message: `systemctl stop failed: ${errMsg(err)}` });
    return out('ABORTED', 'stop', 'unknown');
  }
  const cursor = await guarded('journal-cursor', () => ports.captureJournalCursor());
  if (isGateResult(cursor)) {
    rec.add(cursor);
    return out('ABORTED', 'post-stop', 'stopped');
  }
  await quiescenceGate('post-stop', cursor, ports, rec);
  await layoutGate(ports, items, rec);
  if (rec.failed()) return out('ABORTED', 'post-stop', 'stopped');

  try {
    await ports.restoreFromRollback(input.rollbackDir, items);
  } catch (err) {
    rec.add({ gate: 'restore', level: 'fail', code: 'RESTORE_FAILED', message: `restore failed: ${errMsg(err)}` });
    return out('ROLLBACK_FAILED', 'restore', 'stopped');
  }
  await quiescenceGate('post-restore', cursor, ports, rec);
  if (rec.failed()) {
    const service = await stopAndRelock(ports);
    return out('ROLLBACK_FAILED', 'post-restore', service);
  }
  const restored = await guarded('previous-release', () => ports.readDeployedReleaseSha());
  rec.add(isGateResult(restored) ? restored : evaluatePreviousRelease(input.expectedPreviousSha, restored));
  if (rec.failed()) return out('ROLLBACK_FAILED', 'restore', 'stopped');

  try {
    await ports.unlockStart();
  } catch (err) {
    rec.add({ gate: 'start-unlock', level: 'fail', code: 'UNLOCK_FAILED', message: `could not release the start lock: ${errMsg(err)}` });
    return out('ROLLBACK_FAILED', 'unlock', 'stopped');
  }
  let health: GateResult;
  try {
    await ports.startService();
    const facts = await guarded('health', () => ports.collectHealth());
    health = isGateResult(facts) ? facts : evaluateHealth(facts);
  } catch (err) {
    health = { gate: 'health', level: 'fail', code: 'START_FAILED', message: `systemctl start failed: ${errMsg(err)}` };
  }
  rec.add(health);
  if (health.level === 'fail') {
    const service = await stopAndRelock(ports);
    return out('ROLLBACK_FAILED', 'health', service);
  }
  return out('ROLLED_BACK', undefined, 'started', health.level === 'warn');
}
