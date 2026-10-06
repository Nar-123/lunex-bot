import { describe, expect, it } from 'vitest';
import {
  evaluateChainId,
  evaluateDbHealth,
  evaluateExecutorNonce,
  evaluateOldWalletTripwire,
  evaluatePreviousRelease,
  evaluateReleaseIdentity,
  evaluateServiceStopped,
  RETIRED_WALLET_TRIPWIRE,
  type DbSnapshot,
  type ExecutorNonceInput,
} from '../../src/deploy/gate';

const EXECUTOR = '0x25598234c6E74370e42F3B3D7646581C68656d39';
const RELEASE = 'fb4d3306d32f61f093b41507b5e1a548cdb61863';
const PREVIOUS = 'cde2ba8a2a3393dfedf795a8f571b174e337380d';

function nonceInput(over: Partial<ExecutorNonceInput> = {}): ExecutorNonceInput {
  return {
    phase: 'pre-stop',
    expectedExecutor: EXECUTOR,
    configuredExecutor: EXECUTOR.toLowerCase(),
    observations: [{ source: 'rpc#1', latest: 1, pending: 1 }],
    ledgerMaxNonce: 0,
    ...over,
  };
}

describe('executor nonce gate', () => {
  it('1: latest != pending (a transaction in flight) FAILS', () => {
    const r = evaluateExecutorNonce(nonceInput({ observations: [{ source: 'rpc#1', latest: 1, pending: 2 }] }));
    expect(r.level).toBe('fail');
    expect(r.code).toBe('TRANSACTION_IN_FLIGHT');
  });

  it('2: chain ahead of the ledger (latest > max persisted + 1) FAILS -- a tx sent outside Lunex', () => {
    const r = evaluateExecutorNonce(nonceInput({ observations: [{ source: 'rpc#1', latest: 2, pending: 2 }], ledgerMaxNonce: 0 }));
    expect(r.level).toBe('fail');
    expect(r.code).toBe('CHAIN_AHEAD_OF_LEDGER');
  });

  it('3: latest == pending == max persisted + 1 PASSES (today: chain 1/1, ledger max 0)', () => {
    const r = evaluateExecutorNonce(nonceInput());
    expect(r.level).toBe('pass');
    expect(r.details).toMatchObject({ latest: 1, pending: 1, ledgerMaxNonce: 0, expectedNext: 1 });
  });

  it('4: no persisted nonce for the executor -> expected 0', () => {
    const fresh = evaluateExecutorNonce(nonceInput({ observations: [{ source: 'rpc#1', latest: 0, pending: 0 }], ledgerMaxNonce: null }));
    expect(fresh.level).toBe('pass');
    expect(fresh.details).toMatchObject({ expectedNext: 0 });
    const used = evaluateExecutorNonce(nonceInput({ observations: [{ source: 'rpc#1', latest: 1, pending: 1 }], ledgerMaxNonce: null }));
    expect(used.level).toBe('fail');
    expect(used.code).toBe('CHAIN_AHEAD_OF_LEDGER');
  });

  it('a ledger nonce the chain never reached FAILS (ledger ahead of chain)', () => {
    const r = evaluateExecutorNonce(nonceInput({ observations: [{ source: 'rpc#1', latest: 1, pending: 1 }], ledgerMaxNonce: 3 }));
    expect(r.code).toBe('LEDGER_AHEAD_OF_CHAIN');
  });

  it('7: production configured for a different executor FAILS before any nonce is compared', () => {
    const r = evaluateExecutorNonce(nonceInput({ configuredExecutor: '0x7d22bd54152f8ead57edb0077a6e9f8a7fc76ddb' }));
    expect(r.level).toBe('fail');
    expect(r.code).toBe('EXECUTOR_MISMATCH');
  });

  it('a malformed expected executor FAILS', () => {
    expect(evaluateExecutorNonce(nonceInput({ expectedExecutor: '0x1234' })).code).toBe('EXPECTED_EXECUTOR_INVALID');
  });

  it('RPC endpoints that disagree FAIL rather than picking one', () => {
    const r = evaluateExecutorNonce(
      nonceInput({
        observations: [
          { source: 'rpc#1', latest: 1, pending: 1 },
          { source: 'rpc#2', latest: 2, pending: 2 },
        ],
      }),
    );
    expect(r.code).toBe('RPC_DISAGREEMENT');
  });

  it('no observation at all FAILS', () => {
    expect(evaluateExecutorNonce(nonceInput({ observations: [] })).code).toBe('NO_CHAIN_OBSERVATION');
  });

  it('the retired wallet is NEVER an executor gate: its nonce plays no part', () => {
    // Even fed the retired wallet's 1619/1619, the executor gate only accepts the executor's own state.
    const r = evaluateExecutorNonce(nonceInput({ configuredExecutor: RETIRED_WALLET_TRIPWIRE.address }));
    expect(r.code).toBe('EXECUTOR_MISMATCH');
  });
});

describe('retired-wallet tripwire', () => {
  it('6: a moved retired wallet (1618 -> 1619) is a WARNING, never a failure', () => {
    const r = evaluateOldWalletTripwire([{ source: 'rpc#1', latest: 1619, pending: 1619 }]);
    expect(r.level).toBe('warn');
    expect(r.code).toBe('RETIRED_WALLET_MOVED');
  });

  it('the baseline is still the unacknowledged 1618', () => {
    expect(RETIRED_WALLET_TRIPWIRE.baselineNonce).toBe(1618);
    expect(evaluateOldWalletTripwire([{ source: 'rpc#1', latest: 1618, pending: 1618 }]).level).toBe('pass');
  });

  it('an unreadable retired wallet is a warning, not a failure', () => {
    expect(evaluateOldWalletTripwire([]).level).toBe('warn');
  });
});

describe('release identity', () => {
  const ok = { expectedReleaseSha: RELEASE, artifactCommitId: RELEASE, stagedReleaseSha: RELEASE, stagedManifestVerified: true };

  it('matching artifact and staged build PASS', () => {
    expect(evaluateReleaseIdentity(ok).level).toBe('pass');
  });

  it('8: an artifact built from a different commit FAILS', () => {
    const r = evaluateReleaseIdentity({ ...ok, artifactCommitId: PREVIOUS });
    expect(r.level).toBe('fail');
    expect(r.code).toBe('ARTIFACT_SHA_MISMATCH');
  });

  it('8: a staged build for a different commit FAILS', () => {
    expect(evaluateReleaseIdentity({ ...ok, stagedReleaseSha: PREVIOUS }).code).toBe('STAGED_SHA_MISMATCH');
  });

  it('8: an abbreviated release SHA is refused', () => {
    expect(evaluateReleaseIdentity({ ...ok, expectedReleaseSha: 'fb4d330' }).code).toBe('EXPECTED_RELEASE_INVALID');
  });

  it('a staged build modified after validation FAILS', () => {
    expect(evaluateReleaseIdentity({ ...ok, stagedManifestVerified: false }).code).toBe('STAGED_MANIFEST_MISMATCH');
  });

  it('9: production running something other than the expected previous release FAILS', () => {
    const r = evaluatePreviousRelease(PREVIOUS, '1780220e5a9c9f80e0246cb513df6a3c5c45ccf9');
    expect(r.level).toBe('fail');
    expect(r.code).toBe('PREVIOUS_SHA_MISMATCH');
    expect(evaluatePreviousRelease(PREVIOUS, PREVIOUS).level).toBe('pass');
  });
});

describe('chain id, database and service', () => {
  it('chain id must match configuration and every endpoint', () => {
    expect(evaluateChainId(4663, 4663, [{ source: 'rpc#1', chainId: 4663 }]).level).toBe('pass');
    expect(evaluateChainId(4663, 1, [{ source: 'rpc#1', chainId: 4663 }]).code).toBe('CONFIGURED_CHAIN_MISMATCH');
    expect(evaluateChainId(4663, 4663, [{ source: 'rpc#1', chainId: 1 }]).code).toBe('RPC_CHAIN_MISMATCH');
  });

  const healthy: DbSnapshot = { integrity: 'ok', paused: 1, opening: 0, active: 0, closing: 0, nonTerminalAttempts: 0, deployedCapitalRaw: '0', unfinishedMigrations: 0 };

  it('the current production state (paused, no positions, no in-flight attempts) is deployable', () => {
    expect(evaluateDbHealth(healthy).level).toBe('pass');
  });

  it.each([
    ['unpaused', { paused: 0 }],
    ['an active position', { active: 1 }],
    ['an in-flight attempt', { nonTerminalAttempts: 1 }],
    ['deployed capital', { deployedCapitalRaw: '5000000' }],
    ['a corrupt database', { integrity: '*** in database main ***' }],
    ['an unfinished migration', { unfinishedMigrations: 1 }],
  ])('%s is not deployable', (_label, over) => {
    expect(evaluateDbHealth({ ...healthy, ...over }).level).toBe('fail');
  });

  it('a service that is still running is not "stopped"', () => {
    expect(evaluateServiceStopped({ activeState: 'deactivating', subState: 'stop-sigterm', mainPid: 36477, nRestarts: 0 }).level).toBe('fail');
    expect(evaluateServiceStopped({ activeState: 'inactive', subState: 'dead', mainPid: 0, nRestarts: 0 }).level).toBe('pass');
  });
});
