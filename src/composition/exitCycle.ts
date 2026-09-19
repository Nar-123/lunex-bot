import { config } from '../config';
import { runExitCycle } from '../exits/runExitCycle';
import type { ExitCycleResult } from '../exits/runExitCycle';
import { resumeOpenPosition } from '../positions/openPosition';
import type { OpenPositionOutcome } from '../positions/openPosition';
import { enforceOpeningTimeout } from '../positions/openingTimeout';
import { isStuckAttempt } from '../execution/stuckAttempt';
import { filterToClosingPositions } from '../exits/stuckSwapRetries';
import { runReconciliation } from '../reconciliation/runReconciliation';
import type { ReconciliationReport } from '../reconciliation/types';
import type { AppDeps } from './types';

export interface OpenResumeResult {
  positionId: string;
  outcome: OpenPositionOutcome;
}

export interface ExitCycleSummary {
  exitResults: ExitCycleResult[];
  closedCount: number;
  openResumeResults: OpenResumeResult[];
  stuckTransactionAttemptIds: string[];
  stuckSwapRetryPositionIds: string[];
  reconciliation: ReconciliationReport;
}

/**
 * H5 fix: the (expensive, whole-wallet-history) orphan-NFT scan runs on
 * this cycle's very FIRST invocation (satisfying "startup reconciliation")
 * and is skipped on every subsequent 15s tick thereafter (satisfying
 * "periodic reconciliation" for every OTHER check, which are all cheap,
 * targeted reads) -- reusing the exit cycle's own existing
 * `runImmediately: true` schedule (composition/app.ts) rather than adding
 * a second scheduler for this.
 */
let hasRunStartupOrphanScan = false;

/**
 * The second 15-second cycle (independent of monitoring's): exit
 * decide+resume (Module 8's `runExitCycle`, which already does BOTH the
 * ACTIVE-position decide pass and the CLOSING resume pass internally) plus
 * a SECOND, separate resume pass for OPENING positions (Module 9A) --
 * "dua resume pass, bukan satu," per explicit review. Also the one place
 * `cooldown/`'s `recordExit` is ever called (confirmed nothing in
 * `exits/` calls it itself), and where Module 6's `findNonTerminal`
 * (stuck TransactionAttempts) and Module 8's `findStuckSwapRetries` get
 * surfaced into the logs -- the only visibility into "is anything stuck"
 * available before Telegram/UI (Module 9's later half) exist.
 */
export async function runExitAndOpenResumeCycle(deps: AppDeps): Promise<ExitCycleSummary> {
  const exitResults = await runExitCycle({
    positions: deps.positions,
    exitStates: deps.exitStates,
    txAttempts: deps.txAttempts,
    livePositionState: deps.livePositionState,
    poolPrice: deps.poolPrice,
    priceHistory: deps.priceHistory,
    swapExecutor: deps.swapExecutor,
    settings: deps.settings,
    buildRemoveLiquidityDeps: deps.buildRemoveLiquidityDeps,
    buildSwapDeps: deps.buildSwapDeps,
    buildApproveDeps: deps.buildApproveDepsForExit,
    readAllowance: deps.readAllowance,
    readTokenBalance: deps.readTokenBalanceForExit,
    walletAddress: deps.walletAddress,
    warnLog: (event, data) => { deps.logger.warn(event, data); },
  });

  const closed = exitResults.filter((r) => r.outcome?.outcome === 'CLOSED');
  // Cooldown crash-gap fix: the exit cooldown is NO LONGER recorded here.
  // It used to be a separate best-effort `cooldown.recordExit()` after the
  // position had already committed CLOSED, so a crash in between left a
  // CLOSED position with no cooldown row. It is now written by
  // `PositionRepository.markClosed` itself, in the SAME database
  // transaction as the CLOSED transition and from the same `closedAt` --
  // there is exactly one cooldown writer for exits, and it cannot be
  // separated from the close.

  // H1 fix: each OPENING position is isolated -- a throw resuming one
  // (an RPC blip, a bug) must never abort the rest of this pass, exactly
  // the same "runs independently per position" discipline runExitCycle.ts
  // already uses for its own two passes. Before this fix, an exception
  // from resumeOpenPosition propagated straight out of this loop, silently
  // starving every OTHER OPENING position AND skipping the stuck-attempt
  // surfacing below for the remainder of this tick.
  const openingPositions = await deps.positions.findAllOpening();
  const openResumeResults: OpenResumeResult[] = [];
  for (const position of openingPositions) {
    try {
      // H3: bounded OPENING lifetime -- checked BEFORE resuming, so an aged
      // OPENING whose mint never broadcast is released instead of building
      // and signing a fresh mint this tick. Never releases a possibly
      // broadcast or already-verified mint (see positions/openingTimeout.ts).
      const timeout = await enforceOpeningTimeout(position, { positions: deps.positions, logger: deps.logger });
      if (timeout.skipResume) {
        if (timeout.result.outcome === 'EXPIRED') {
          openResumeResults.push({ positionId: position.id, outcome: { outcome: 'FAILED', reason: 'OPENING_TIMEOUT: entry never broadcast within OPENING_MAX_AGE_MS -- reservation released' } });
        }
        continue;
      }
      const outcome = await resumeOpenPosition(position, {
        positions: deps.positions,
        txAttempts: deps.txAttempts,
        livePositionState: deps.livePositionState,
        poolPrice: deps.poolPrice,
        buildApproveDeps: deps.buildApproveDepsForOpen,
        buildMintDeps: deps.buildMintDeps,
        readAllowance: deps.readAllowance,
        walletAddress: deps.walletAddress,
      });
      openResumeResults.push({ positionId: position.id, outcome });
      if (timeout.result.outcome === 'MINT_VERIFIED' && outcome.outcome === 'ACTIVE') {
        deps.logger.info('opening_recovered', { positionId: position.id, positionTokenId: outcome.position.positionTokenId });
      }
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      deps.logger.error('open_resume_error', { positionId: position.id, message });
      openResumeResults.push({ positionId: position.id, outcome: { outcome: 'PENDING', reason: message } });
    }
  }

  const nonTerminalAttempts = await deps.txAttempts.findNonTerminal();
  const stuckAttempts = nonTerminalAttempts.filter((a) => isStuckAttempt(a));
  // H16 fix: `findStuckSwapRetries` alone has no idea a position already
  // CLOSED (or is otherwise no longer CLOSING) -- intersecting with the
  // CURRENT set of CLOSING positions is what keeps a long-resolved exit
  // from being reported as stuck forever. See stuckSwapRetries.ts.
  const rawStuckSwapRetryPositionIds = await deps.exitStates.findStuckSwapRetries(config.rules.exits.SWAP_RETRY.STUCK_THRESHOLD);
  const currentlyClosing = await deps.positions.findAllClosing();
  const stuckSwapRetryPositionIds = filterToClosingPositions(rawStuckSwapRetryPositionIds, currentlyClosing.map((p) => p.id));

  // H5: reconciliation is a diagnostic pass -- it never writes anything,
  // and a failure in it must never take down the exit/open-resume cycle
  // itself (isolated in its own try/catch, same "runs independently"
  // discipline as every other per-position/per-pass isolation in this file).
  const includeOrphanScan = !hasRunStartupOrphanScan;
  let reconciliation: ReconciliationReport;
  try {
    reconciliation = await runReconciliation(
      {
        positions: deps.positions,
        txAttempts: deps.txAttempts,
        exitStates: deps.exitStates,
        livePositionState: deps.livePositionState,
        ownedNftLister: deps.ownedNftLister,
        nftOwnerChecker: deps.nftOwnerChecker,
        positionIdentityChecker: deps.positionIdentityChecker,
        walletAddress: deps.walletAddress,
      },
      { includeOrphanScan },
    );
    if (includeOrphanScan) hasRunStartupOrphanScan = true;
  } catch (err) {
    reconciliation = { findings: [], checkedAt: new Date(), rpcHealthy: false, orphanScanRan: false };
    deps.logger.error('reconciliation_error', { message: err instanceof Error ? err.message : String(err) });
  }

  const summary: ExitCycleSummary = {
    exitResults,
    closedCount: closed.length,
    openResumeResults,
    stuckTransactionAttemptIds: stuckAttempts.map((a) => a.id),
    stuckSwapRetryPositionIds,
    reconciliation,
  };

  deps.logger.info('exit_cycle', {
    activeEvaluated: exitResults.length,
    closed: closed.length,
    openResumeAttempts: openResumeResults.length,
    stuckTransactionAttempts: stuckAttempts.length,
    stuckSwapRetries: stuckSwapRetryPositionIds.length,
    reconciliationFindings: reconciliation.findings.length,
    reconciliationRpcHealthy: reconciliation.rpcHealthy,
  });
  if (stuckAttempts.length > 0) {
    deps.logger.warn('stuck_transaction_attempts', {
      ids: stuckAttempts.map((a) => a.id),
      idempotencyKeys: stuckAttempts.map((a) => a.idempotencyKey),
    });
  }
  if (stuckSwapRetryPositionIds.length > 0) {
    deps.logger.warn('stuck_swap_retries', { positionIds: stuckSwapRetryPositionIds });
  }
  if (reconciliation.findings.length > 0) {
    deps.logger.warn('reconciliation_findings', { findings: reconciliation.findings });
  }
  if (!reconciliation.rpcHealthy) {
    deps.logger.warn('reconciliation_rpc_unhealthy', { checkedAt: reconciliation.checkedAt.toISOString() });
  }

  return summary;
}
