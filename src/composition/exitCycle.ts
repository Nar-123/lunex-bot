import { config } from '../config';
import { runExitCycle } from '../exits/runExitCycle';
import type { ExitCycleResult } from '../exits/runExitCycle';
import { resumeOpenPosition } from '../positions/openPosition';
import type { OpenPositionOutcome } from '../positions/openPosition';
import { isStuckAttempt } from '../execution/stuckAttempt';
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
}

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
    swapExecutor: deps.swapExecutor,
    settings: deps.settings,
    buildRemoveLiquidityDeps: deps.buildRemoveLiquidityDeps,
    buildSwapDeps: deps.buildSwapDeps,
    buildApproveDeps: deps.buildApproveDepsForExit,
    readAllowance: deps.readAllowance,
    readTokenBalance: deps.readTokenBalanceForExit,
    walletAddress: deps.walletAddress,
  });

  const closed = exitResults.filter((r) => r.outcome?.outcome === 'CLOSED');
  for (const result of closed) {
    const position = await deps.positions.findById(result.positionId);
    // The row still exists (CLOSED is a terminal status, never deleted) -- if it's somehow gone, skip rather than throw, this is a best-effort cooldown record, not a safety-critical one.
    if (position) await deps.cooldown.recordExit(position.tokenAddress);
  }

  const openingPositions = await deps.positions.findAllOpening();
  const openResumeResults: OpenResumeResult[] = [];
  for (const position of openingPositions) {
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
  }

  const nonTerminalAttempts = await deps.txAttempts.findNonTerminal();
  const stuckAttempts = nonTerminalAttempts.filter((a) => isStuckAttempt(a));
  const stuckSwapRetryPositionIds = await deps.exitStates.findStuckSwapRetries(config.rules.exits.SWAP_RETRY.STUCK_THRESHOLD);

  const summary: ExitCycleSummary = {
    exitResults,
    closedCount: closed.length,
    openResumeResults,
    stuckTransactionAttemptIds: stuckAttempts.map((a) => a.id),
    stuckSwapRetryPositionIds,
  };

  deps.logger.info('exit_cycle', {
    activeEvaluated: exitResults.length,
    closed: closed.length,
    openResumeAttempts: openResumeResults.length,
    stuckTransactionAttempts: stuckAttempts.length,
    stuckSwapRetries: stuckSwapRetryPositionIds.length,
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

  return summary;
}
