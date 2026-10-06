/**
 * Deployment gates for the production host -- pure decision functions, no I/O.
 *
 * Every function here takes facts that were already observed (chain reads, the
 * executor-scoped D11 ledger, the service state, the deployed RELEASE_SHA) and
 * returns a verdict. Keeping the decisions free of I/O is what makes them
 * testable, and it means the code that READS production (hostPorts.ts) can never
 * also decide that a reading "looks fine".
 *
 * ## Why this replaces deployD.sh's EXPECT_NONCE
 *
 * deployD.sh's `record` stage compared `getTransactionCount` of a HARDCODED
 * wallet (0x65299018…) against a hand-edited number. Until D10 that wallet was
 * the executor, so the check meant "the executor is quiet: nothing in flight and
 * nothing sent that we did not expect". At D10 the executor rotated, and the
 * check was re-pointed -- by editing the number, not the address -- at the
 * retired wallet, silently turning a deploy-safety gate into a tripwire on a
 * wallet the bot no longer uses. It then measured nothing about the executor
 * that would actually be signing after the deployment.
 *
 * The gate below restores the original intent against the RIGHT wallet:
 *   - the executor is the one derived from the production configuration
 *     (`deployIdentity.ts`, run as the service account) and must equal the
 *     address the operator explicitly expects;
 *   - its chain nonce must be settled (latest == pending -- nothing in flight);
 *   - and it must match the executor-scoped D11 ledger exactly
 *     (latest == max persisted nonce + 1, or 0 when the ledger is empty), so a
 *     transaction sent from that key OUTSIDE Lunex fails the gate, and so does a
 *     ledger nonce the chain never saw.
 * The retired wallet keeps a separate, warning-only tripwire
 * (`evaluateOldWalletTripwire`) and is never an executor gate.
 */

export type GateLevel = 'pass' | 'warn' | 'fail';

export interface GateResult {
  gate: string;
  level: GateLevel;
  /** Stable machine-readable reason, e.g. `CHAIN_AHEAD_OF_LEDGER`. */
  code: string;
  message: string;
  details?: Record<string, unknown>;
}

const ADDRESS_RE = /^0x[0-9a-fA-F]{40}$/;
const SHA_RE = /^[0-9a-f]{40}$/;

/** Lowercased address, or null when `value` is not a 20-byte hex address. */
export function normalizeAddress(value: string): string | null {
  return ADDRESS_RE.test(value) ? value.toLowerCase() : null;
}

/** True only for a full, lowercase 40-hex git commit id (never an abbreviation). */
export function isFullCommitSha(value: string): boolean {
  return SHA_RE.test(value);
}

function pass(gate: string, code: string, message: string, details?: Record<string, unknown>): GateResult {
  return { gate, level: 'pass', code, message, ...(details && { details }) };
}

function fail(gate: string, code: string, message: string, details?: Record<string, unknown>): GateResult {
  return { gate, level: 'fail', code, message, ...(details && { details }) };
}

function warn(gate: string, code: string, message: string, details?: Record<string, unknown>): GateResult {
  return { gate, level: 'warn', code, message, ...(details && { details }) };
}

function isNonNegativeInt(n: number): boolean {
  return Number.isSafeInteger(n) && n >= 0;
}

// ---------------------------------------------------------------------------
// Executor identity + nonce
// ---------------------------------------------------------------------------

/** One RPC endpoint's view of an address's transaction count. */
export interface NonceObservation {
  /** Endpoint label for diagnostics (never a URL that could embed a key). */
  source: string;
  latest: number;
  pending: number;
}

export interface ExecutorNonceInput {
  /** Which checkpoint this is: `pre-stop`, `post-stop`, `pre-replace`. */
  phase: string;
  /** The executor the operator explicitly expects (deployment input). */
  expectedExecutor: string;
  /** The executor derived from the production configuration. */
  configuredExecutor: string;
  /** One observation per RPC endpoint queried; all must agree. */
  observations: readonly NonceObservation[];
  /**
   * Highest nonce the executor-scoped D11 ledger holds for THIS executor
   * (`TransactionAttempt` rows whose `executorAddress` is the executor and
   * whose `nonce` is set), or null when it holds none.
   */
  ledgerMaxNonce: number | null;
}

/**
 * The executor deployment gate. Fails closed on every shape it does not
 * positively recognise as "settled and fully accounted for".
 */
export function evaluateExecutorNonce(input: ExecutorNonceInput): GateResult {
  const gate = `executor-nonce:${input.phase}`;
  const expected = normalizeAddress(input.expectedExecutor);
  const configured = normalizeAddress(input.configuredExecutor);
  if (expected === null) {
    return fail(gate, 'EXPECTED_EXECUTOR_INVALID', `expected executor "${input.expectedExecutor}" is not a 20-byte hex address`);
  }
  if (configured === null) {
    return fail(gate, 'CONFIGURED_EXECUTOR_INVALID', 'the executor derived from the production configuration is not a valid address');
  }
  if (expected !== configured) {
    return fail(gate, 'EXECUTOR_MISMATCH', `production is configured for executor ${configured}, but the deployment expects ${expected}`, {
      expected,
      configured,
    });
  }
  if (input.observations.length === 0) {
    return fail(gate, 'NO_CHAIN_OBSERVATION', 'no RPC endpoint returned the executor nonce -- nothing to compare against');
  }
  for (const o of input.observations) {
    if (!isNonNegativeInt(o.latest) || !isNonNegativeInt(o.pending)) {
      return fail(gate, 'CHAIN_OBSERVATION_INVALID', `endpoint ${o.source} returned a non-integer nonce`, { observation: o });
    }
  }
  const [first, ...rest] = input.observations as [NonceObservation, ...NonceObservation[]];
  const disagreeing = rest.find((o) => o.latest !== first.latest || o.pending !== first.pending);
  if (disagreeing) {
    return fail(gate, 'RPC_DISAGREEMENT', `RPC endpoints disagree on the executor nonce (${first.source}: ${first.latest}/${first.pending}, ${disagreeing.source}: ${disagreeing.latest}/${disagreeing.pending})`, {
      observations: input.observations,
    });
  }
  const { latest, pending } = first;
  if (latest !== pending) {
    return fail(gate, 'TRANSACTION_IN_FLIGHT', `executor has a transaction in flight: latest=${latest} pending=${pending}`, { latest, pending });
  }
  if (input.ledgerMaxNonce !== null && !isNonNegativeInt(input.ledgerMaxNonce)) {
    return fail(gate, 'LEDGER_INVALID', `the executor ledger returned a non-integer max nonce (${input.ledgerMaxNonce})`);
  }
  const expectedNext = input.ledgerMaxNonce === null ? 0 : input.ledgerMaxNonce + 1;
  const details = { executor: configured, latest, pending, ledgerMaxNonce: input.ledgerMaxNonce, expectedNext };
  if (latest > expectedNext) {
    return fail(gate, 'CHAIN_AHEAD_OF_LEDGER', `executor chain nonce ${latest} is ahead of the ledger (expected ${expectedNext}): ${latest - expectedNext} transaction(s) were sent from the executor key outside Lunex's ledger`, details);
  }
  if (latest < expectedNext) {
    return fail(gate, 'LEDGER_AHEAD_OF_CHAIN', `the ledger holds nonce ${expectedNext - 1} but the chain has only reached ${latest}: a recorded nonce never mined`, details);
  }
  return pass(gate, 'EXECUTOR_SETTLED', `executor ${configured} settled at nonce ${latest} (ledger max ${input.ledgerMaxNonce ?? 'none'})`, details);
}

// ---------------------------------------------------------------------------
// Chain id
// ---------------------------------------------------------------------------

export function evaluateChainId(
  expectedChainId: number,
  configuredChainId: number,
  observed: readonly { source: string; chainId: number }[],
): GateResult {
  const gate = 'chain-id';
  if (configuredChainId !== expectedChainId) {
    return fail(gate, 'CONFIGURED_CHAIN_MISMATCH', `production is configured for chain ${configuredChainId}, the deployment expects ${expectedChainId}`);
  }
  if (observed.length === 0) {
    return fail(gate, 'NO_CHAIN_OBSERVATION', 'no RPC endpoint reported a chain id');
  }
  const wrong = observed.find((o) => o.chainId !== expectedChainId);
  if (wrong) {
    return fail(gate, 'RPC_CHAIN_MISMATCH', `endpoint ${wrong.source} serves chain ${wrong.chainId}, not ${expectedChainId}`);
  }
  return pass(gate, 'CHAIN_MATCH', `chain ${expectedChainId} confirmed by configuration and ${observed.length} endpoint(s)`);
}

// ---------------------------------------------------------------------------
// Release identity
// ---------------------------------------------------------------------------

export interface ReleaseIdentityInput {
  expectedReleaseSha: string;
  /** Commit id embedded in the uploaded `git archive` tarball. */
  artifactCommitId: string;
  /** RELEASE_SHA written into the sealed, built release directory. */
  stagedReleaseSha: string;
  /** Whether the staged build's manifest verified (dist + ui/dist hashes). */
  stagedManifestVerified: boolean;
}

export function evaluateReleaseIdentity(input: ReleaseIdentityInput): GateResult {
  const gate = 'release-identity';
  if (!isFullCommitSha(input.expectedReleaseSha)) {
    return fail(gate, 'EXPECTED_RELEASE_INVALID', `EXPECTED_RELEASE_SHA "${input.expectedReleaseSha}" is not a full 40-hex commit id`);
  }
  if (input.artifactCommitId !== input.expectedReleaseSha) {
    return fail(gate, 'ARTIFACT_SHA_MISMATCH', `artifact was built from ${input.artifactCommitId || '(unknown)'}, not ${input.expectedReleaseSha}`);
  }
  if (input.stagedReleaseSha !== input.expectedReleaseSha) {
    return fail(gate, 'STAGED_SHA_MISMATCH', `the staged release directory is ${input.stagedReleaseSha || '(unknown)'}, not ${input.expectedReleaseSha}`);
  }
  if (!input.stagedManifestVerified) {
    return fail(gate, 'STAGED_MANIFEST_MISMATCH', 'the staged build no longer matches the manifest recorded when it was validated');
  }
  return pass(gate, 'RELEASE_MATCH', `artifact and staged build are ${input.expectedReleaseSha}`);
}

export function evaluatePreviousRelease(expectedPreviousSha: string, deployedSha: string): GateResult {
  const gate = 'previous-release';
  if (!isFullCommitSha(expectedPreviousSha)) {
    return fail(gate, 'EXPECTED_PREVIOUS_INVALID', `expected previous release "${expectedPreviousSha}" is not a full 40-hex commit id`);
  }
  if (deployedSha !== expectedPreviousSha) {
    return fail(gate, 'PREVIOUS_SHA_MISMATCH', `production runs ${deployedSha || '(unknown)'}, not the expected previous release ${expectedPreviousSha}`);
  }
  return pass(gate, 'PREVIOUS_MATCH', `production runs the expected previous release ${expectedPreviousSha}`);
}

// ---------------------------------------------------------------------------
// Production database
// ---------------------------------------------------------------------------

export interface DbSnapshot {
  /** `PRAGMA integrity_check` result; healthy is exactly `ok`. */
  integrity: string;
  paused: number | null;
  opening: number;
  active: number;
  closing: number;
  /** TransactionAttempt rows not in a terminal status (VERIFIED / FAILED). */
  nonTerminalAttempts: number;
  /** Sum of entryUsdgRaw over OPENING/ACTIVE/CLOSING positions, as a decimal string. */
  deployedCapitalRaw: string;
  /** `_prisma_migrations` rows not finished or rolled back. */
  unfinishedMigrations: number;
}

export function evaluateDbHealth(db: DbSnapshot): GateResult {
  const gate = 'database';
  const problems: string[] = [];
  if (db.integrity !== 'ok') problems.push(`integrity_check=${db.integrity}`);
  if (db.paused !== 1) problems.push(`paused=${db.paused ?? 'missing'} (must be 1)`);
  if (db.opening !== 0 || db.active !== 0 || db.closing !== 0) {
    problems.push(`live positions opening=${db.opening} active=${db.active} closing=${db.closing}`);
  }
  if (db.nonTerminalAttempts !== 0) problems.push(`${db.nonTerminalAttempts} transaction attempt(s) not terminal`);
  if (db.deployedCapitalRaw !== '0') problems.push(`deployed capital ${db.deployedCapitalRaw}`);
  if (db.unfinishedMigrations !== 0) problems.push(`${db.unfinishedMigrations} unfinished/rolled-back migration(s)`);
  if (problems.length > 0) {
    return fail(gate, 'DB_NOT_DEPLOYABLE', `production database is not in a deployable state: ${problems.join('; ')}`, { db });
  }
  return pass(gate, 'DB_DEPLOYABLE', 'integrity ok, paused, no live positions, no in-flight attempts, no deployed capital', { db });
}

// ---------------------------------------------------------------------------
// Service state
// ---------------------------------------------------------------------------

export interface ServiceSnapshot {
  activeState: string;
  subState: string;
  mainPid: number;
  nRestarts: number;
}

export function evaluateServiceRunning(s: ServiceSnapshot): GateResult {
  const gate = 'service-running';
  if (s.activeState !== 'active' || s.subState !== 'running' || s.mainPid <= 0) {
    return fail(gate, 'SERVICE_NOT_RUNNING', `lunex-bot is ${s.activeState}/${s.subState} (pid ${s.mainPid}); the pre-stop baseline requires a healthy running service`, { service: s });
  }
  return pass(gate, 'SERVICE_RUNNING', `lunex-bot running as pid ${s.mainPid}, NRestarts=${s.nRestarts}`, { service: s });
}

export function evaluateServiceStopped(s: ServiceSnapshot): GateResult {
  const gate = 'service-stopped';
  if (s.activeState !== 'inactive' || s.mainPid !== 0) {
    return fail(gate, 'SERVICE_NOT_STOPPED', `lunex-bot is ${s.activeState}/${s.subState} (pid ${s.mainPid}) -- refusing to touch the artifact`, { service: s });
  }
  return pass(gate, 'SERVICE_STOPPED', 'lunex-bot is inactive with no main process');
}

// ---------------------------------------------------------------------------
// Rollback
// ---------------------------------------------------------------------------

export interface RollbackSnapshot {
  dir: string;
  /** Every replaced item re-compared byte-for-byte against production. */
  appCopyVerified: boolean;
  /** Byte comparison of the DB copy against the stopped production DB. */
  dbCopyIdentical: boolean;
  /** `PRAGMA integrity_check` of the DB copy. */
  dbCopyIntegrity: string;
}

export function evaluateRollbackReady(r: RollbackSnapshot): GateResult {
  const gate = 'rollback-ready';
  const problems: string[] = [];
  if (!r.appCopyVerified) problems.push('application copy does not match production');
  if (!r.dbCopyIdentical) problems.push('database copy differs from the production database');
  if (r.dbCopyIntegrity !== 'ok') problems.push(`database copy integrity_check=${r.dbCopyIntegrity}`);
  if (problems.length > 0) {
    return fail(gate, 'ROLLBACK_NOT_READY', `rollback snapshot ${r.dir} is not usable: ${problems.join('; ')}`);
  }
  return pass(gate, 'ROLLBACK_READY', `rollback snapshot verified at ${r.dir}`);
}

// ---------------------------------------------------------------------------
// Retired-wallet tripwire (diagnostic only)
// ---------------------------------------------------------------------------

/**
 * The executor retired at D10. It still holds the 140 closed-position NFTs and
 * an EIP-7702 delegation. Its baseline is the nonce deployD.sh last accepted
 * (1618); the transaction that moved it to 1619 on 2026-09-28 has NOT been
 * acknowledged by the operator, so the baseline is deliberately NOT advanced
 * here -- advancing it would be the silent acceptance this tripwire exists to
 * prevent. Change it only together with a written acknowledgement.
 */
export const RETIRED_WALLET_TRIPWIRE = {
  address: '0x65299018abaaa6bd89aabf689dbef21be99ef1ea',
  baselineNonce: 1618,
} as const;

/**
 * Reports movement of the retired wallet. NEVER returns `fail`: the retired
 * wallet is not the executor, so its movement says nothing about whether this
 * deployment is safe -- it is surfaced loudly for the operator instead.
 */
export function evaluateOldWalletTripwire(
  observations: readonly NonceObservation[],
  tripwire: { address: string; baselineNonce: number } = RETIRED_WALLET_TRIPWIRE,
): GateResult {
  const gate = 'retired-wallet-tripwire';
  if (observations.length === 0) {
    return warn(gate, 'TRIPWIRE_UNOBSERVED', `could not read the retired wallet ${tripwire.address}; its state is unknown`);
  }
  const moved = observations.find((o) => o.latest !== tripwire.baselineNonce || o.pending !== tripwire.baselineNonce);
  if (moved) {
    return warn(gate, 'RETIRED_WALLET_MOVED', `retired wallet ${tripwire.address} is at ${moved.latest}/${moved.pending}, baseline ${tripwire.baselineNonce}: UNACKNOWLEDGED movement -- investigate separately; this is not an executor gate and does not block the deployment`, {
      baseline: tripwire.baselineNonce,
      observations,
    });
  }
  return pass(gate, 'RETIRED_WALLET_UNCHANGED', `retired wallet ${tripwire.address} unchanged at baseline ${tripwire.baselineNonce}`);
}

// ---------------------------------------------------------------------------

export function hasFailure(results: readonly GateResult[]): boolean {
  return results.some((r) => r.level === 'fail');
}

// ---------------------------------------------------------------------------
// Schema compatibility (M-4)
// ---------------------------------------------------------------------------

export interface MigrationRecord {
  name: string;
  /** sha256 of migration.sql -- the value Prisma stores as the checksum. */
  checksum: string;
}

export interface AppliedMigration extends MigrationRecord {
  finished: boolean;
  rolledBack: boolean;
}

/**
 * The release and the database must agree on the exact migration set. This
 * gate never migrates: a release that needs a migration is BLOCKED, and so is
 * a database that has migrations the release does not know (a downgrade).
 */
export function evaluateSchema(release: readonly MigrationRecord[], db: readonly AppliedMigration[]): GateResult {
  const gate = 'schema';
  if (release.length === 0) return fail(gate, 'RELEASE_HAS_NO_MIGRATIONS', 'the release carries no migrations -- refusing to judge schema compatibility');
  const unfinished = db.filter((m) => !m.finished || m.rolledBack).map((m) => m.name);
  if (unfinished.length > 0) return fail(gate, 'DB_MIGRATION_UNFINISHED', `database has unfinished or rolled-back migrations: ${unfinished.join(', ')}`);
  const applied = new Map(db.map((m) => [m.name, m.checksum]));
  const shipped = new Map(release.map((m) => [m.name, m.checksum]));
  const pending = release.filter((m) => !applied.has(m.name)).map((m) => m.name);
  const unknown = db.filter((m) => !shipped.has(m.name)).map((m) => m.name);
  const changed = release.filter((m) => applied.has(m.name) && applied.get(m.name) !== m.checksum).map((m) => m.name);
  if (pending.length > 0) {
    return fail(gate, 'MIGRATION_REQUIRED', `release requires ${pending.length} migration(s) not applied to the database (${pending.join(', ')}); this gate never migrates`);
  }
  if (unknown.length > 0) {
    return fail(gate, 'DB_AHEAD_OF_RELEASE', `database has ${unknown.length} migration(s) the release does not ship (${unknown.join(', ')}) -- a schema downgrade`);
  }
  if (changed.length > 0) return fail(gate, 'MIGRATION_CHECKSUM_MISMATCH', `migration file(s) differ from what was applied: ${changed.join(', ')}`);
  return pass(gate, 'SCHEMA_MATCH', `release and database agree on all ${release.length} migrations`);
}

// ---------------------------------------------------------------------------
// Production tree layout (H-1)
// ---------------------------------------------------------------------------

export type EntryType = 'd' | 'f' | 'l' | 'other';

export interface LayoutFacts {
  /** lstat of the production root: must be a real directory, not a symlink. */
  rootIsRealDirectory: boolean;
  /** Ancestors of the production root that are symlinks, not root-owned, or group/other-writable. */
  unsafeAncestors: string[];
  /** Top-level entries of the production tree, typed from rsync --list-only. */
  entries: readonly { name: string; type: EntryType }[];
}

/**
 * Root writes into the production tree are only safe when nothing the service
 * account could have planted redirects them. Any top-level symlink fails the
 * gate (whether or not the release touches it), and so does a release item
 * whose production counterpart has a different type.
 */
export function evaluateProdLayout(facts: LayoutFacts, releaseItems: readonly { name: string; type: EntryType }[]): GateResult {
  const gate = 'prod-layout';
  if (!facts.rootIsRealDirectory) return fail(gate, 'PROD_ROOT_NOT_DIRECTORY', 'the production root is not a real directory');
  if (facts.unsafeAncestors.length > 0) return fail(gate, 'PROD_ANCESTOR_UNSAFE', `production root ancestors are not root-only: ${facts.unsafeAncestors.join(', ')}`);
  const links = facts.entries.filter((e) => e.type === 'l' || e.type === 'other').map((e) => e.name);
  if (links.length > 0) return fail(gate, 'PROD_SYMLINK', `production tree has symlink/special top-level entries: ${links.join(', ')} -- refusing any root write`);
  const byName = new Map(facts.entries.map((e) => [e.name, e.type]));
  const mismatched = releaseItems.filter((r) => byName.has(r.name) && byName.get(r.name) !== r.type).map((r) => r.name);
  if (mismatched.length > 0) return fail(gate, 'PROD_TYPE_MISMATCH', `production entries differ in type from the release: ${mismatched.join(', ')}`);
  return pass(gate, 'PROD_LAYOUT_SAFE', `production root and ${facts.entries.length} top-level entries are plain files/directories`);
}

// ---------------------------------------------------------------------------
// Quiescence while stopped (M-2)
// ---------------------------------------------------------------------------

export interface QuiescenceFacts {
  service: ServiceSnapshot;
  /** PIDs of every process owned by the service account. */
  serviceAccountPids: readonly number[];
  /** Journal entries for lunex-bot.service after the cursor taken right after stop. */
  journalEntriesSinceStop: number;
  /** The runtime start-lock drop-in is installed with the expected content and loaded. */
  startLockActive: boolean;
}

export function evaluateQuiescence(phase: string, f: QuiescenceFacts): GateResult {
  const gate = `quiescent:${phase}`;
  const problems: string[] = [];
  if (f.service.activeState !== 'inactive' || f.service.mainPid !== 0) problems.push(`service ${f.service.activeState}/${f.service.subState} pid ${f.service.mainPid}`);
  if (f.serviceAccountPids.length > 0) problems.push(`service-account processes alive: ${f.serviceAccountPids.join(',')}`);
  if (f.journalEntriesSinceStop !== 0) problems.push(`${f.journalEntriesSinceStop} journal entries for lunex-bot since the stop -- a start was attempted`);
  if (!f.startLockActive) problems.push('start lock is not in place');
  if (problems.length > 0) return fail(gate, 'NOT_QUIESCENT', `production is not quiescent: ${problems.join('; ')}`, { facts: f });
  return pass(gate, 'QUIESCENT', 'service stopped and start-locked, no service-account process, no journal activity since stop');
}

// ---------------------------------------------------------------------------
// Rollback source (M-3)
// ---------------------------------------------------------------------------

export interface RollbackSourceFacts {
  dir: string;
  /** The 40-hex SHA parsed from <rollbackRoot>/<sha>-<YYYYMMDDTHHMMSSZ>, or null when malformed. */
  nameSha: string | null;
  rootSafe: boolean;
  dirType: EntryType | 'missing';
  appType: EntryType | 'missing';
  /** RELEASE_SHA read from the snapshot's app copy, or null when unreadable / not a regular file. */
  snapshotReleaseSha: string | null;
  items: readonly { name: string; type: EntryType }[];
  forbiddenItems: readonly string[];
}

export function evaluateRollbackSource(expectedPreviousSha: string, f: RollbackSourceFacts): GateResult {
  const gate = 'rollback-source';
  if (!isFullCommitSha(expectedPreviousSha)) return fail(gate, 'EXPECTED_PREVIOUS_INVALID', 'expected previous release is not a full 40-hex commit id');
  if (f.nameSha === null) return fail(gate, 'ROLLBACK_DIR_MALFORMED', `${f.dir} is not <rollbackRoot>/<40-hex>-<UTC stamp>`);
  if (f.nameSha !== expectedPreviousSha) return fail(gate, 'ROLLBACK_DIR_SHA_MISMATCH', `${f.dir} snapshots ${f.nameSha}, not ${expectedPreviousSha}`);
  if (!f.rootSafe) return fail(gate, 'ROLLBACK_ROOT_UNSAFE', 'the rollback root is not a root-owned 0700 directory');
  if (f.dirType !== 'd' || f.appType !== 'd') {
    return fail(gate, 'ROLLBACK_DIR_NOT_DIRECTORY', `snapshot dir type ${f.dirType}, app type ${f.appType} -- symlinks and missing directories are refused`);
  }
  if (f.snapshotReleaseSha !== expectedPreviousSha) {
    return fail(gate, 'ROLLBACK_RELEASE_SHA_MISMATCH', `snapshot RELEASE_SHA is ${f.snapshotReleaseSha ?? '(unreadable)'}, not ${expectedPreviousSha}`);
  }
  if (f.forbiddenItems.length > 0) return fail(gate, 'ROLLBACK_HAS_PROTECTED_ITEM', `snapshot carries protected items: ${f.forbiddenItems.join(', ')}`);
  const bad = f.items.filter((i) => i.type !== 'd' && i.type !== 'f').map((i) => i.name);
  if (bad.length > 0) return fail(gate, 'ROLLBACK_HAS_SYMLINK', `snapshot top-level entries are not plain files/directories: ${bad.join(', ')}`);
  if (f.items.length === 0) return fail(gate, 'ROLLBACK_EMPTY', 'snapshot holds no application items');
  return pass(gate, 'ROLLBACK_SOURCE_VALID', `snapshot ${f.dir} is ${expectedPreviousSha} with ${f.items.length} items`);
}

// ---------------------------------------------------------------------------
// Post-start health (M-6)
// ---------------------------------------------------------------------------

export interface HealthFacts {
  serviceAtEnd: ServiceSnapshot;
  pidAtStart: number;
  invocationAtStart: string;
  invocationAtEnd: string;
  /** Structured event names logged by THIS invocation, in order. */
  events: readonly string[];
  /** Error-level events of this invocation with a short message class (never the full message). */
  errorEvents: readonly { event: string; messageClass: string }[];
  /** "[lunex-bot] fatal startup error" lines from main().catch. */
  fatalStartupLines: number;
  signingLines: number;
  paused: number | null;
}

/**
 * Error events PROVEN non-fatal on the production host: during the current
 * production run (since 2026-09-30, cde2ba8) the only error-level event was
 * screening_cycle_error caused by the absent gmgn-cli, with the service stable
 * throughout. Nothing else is assumed benign.
 */
export const KNOWN_NON_FATAL_ERRORS: readonly { event: string; messagePrefix: string }[] = [
  { event: 'screening_cycle_error', messagePrefix: 'gmgn-cli command failed' },
];

/** Startup completion markers emitted by src/index.ts. */
export const REQUIRED_STARTUP_EVENTS = ['startup', 'api_server_started'] as const;

/**
 * Structural signals decide failure; arbitrary error-level lines do not. An
 * error event that is not proven benign makes the result NEEDS_VERIFICATION (a
 * warning), never a silent pass and never a guessed allowlist entry.
 */
export function evaluateHealth(f: HealthFacts): GateResult {
  const gate = 'health';
  const s = f.serviceAtEnd;
  const problems: string[] = [];
  if (s.activeState !== 'active' || s.subState !== 'running') problems.push(`service ${s.activeState}/${s.subState}`);
  if (s.nRestarts !== 0) problems.push(`NRestarts=${s.nRestarts}`);
  if (f.pidAtStart <= 0 || s.mainPid !== f.pidAtStart) problems.push(`MainPID changed ${f.pidAtStart} -> ${s.mainPid}`);
  if (!/^[0-9a-f]{32}$/.test(f.invocationAtStart) || f.invocationAtEnd !== f.invocationAtStart) problems.push('invocation changed during the health window');
  if (f.fatalStartupLines > 0) problems.push('fatal startup error logged');
  if (f.signingLines > 0) problems.push(`${f.signingLines} signing/broadcast line(s)`);
  if (f.paused !== 1) problems.push(`paused=${f.paused ?? 'missing'}`);
  for (const ev of REQUIRED_STARTUP_EVENTS) if (!f.events.includes(ev)) problems.push(`startup marker ${ev} missing`);
  if (f.events.includes('telegram_bot_start_failed')) problems.push('telegram_bot_start_failed');
  else if (!f.events.includes('telegram_bot_started') && !f.events.includes('telegram_disabled')) problems.push('telegram neither started nor disabled');
  if (problems.length > 0) return fail(gate, 'UNHEALTHY', `release is not healthy: ${problems.join('; ')}`, { facts: f });
  const unknown = f.errorEvents.filter((e) => !KNOWN_NON_FATAL_ERRORS.some((k) => k.event === e.event && e.messageClass.startsWith(k.messagePrefix)));
  if (unknown.length > 0) {
    const names = [...new Set(unknown.map((e) => e.event))].join(', ');
    return warn(gate, 'NEEDS_VERIFICATION', `healthy by every structural signal, but error event(s) not proven benign: ${names} -- verify before resuming`, { facts: f });
  }
  return pass(gate, 'HEALTHY', `pid ${s.mainPid} stable, startup completed, telegram up, still paused`);
}
