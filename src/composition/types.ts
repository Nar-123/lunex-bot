import type { Address } from 'viem';
import type { PositionRecord, PositionRepository } from '../positions/types';
import type { TransactionAttemptRepository, TxSafetyDeps } from '../execution/types';
import type { ExitStateRepository } from '../exits/types';
import type { SettingsRepository } from '../settings/types';
import type { CooldownChecker } from '../filters/types';
import type { ActivePositionChecker } from '../filters/types';
import type { CapitalSnapshotProvider } from '../capital/types';
import type { DiscoveryService } from '../discovery/discoveryService';
import type { PoolDiscoveryPort, PoolStateProviderPort, PoolVolumeProviderPort } from '../pools/types';
import type { LivePositionStateProvider, PoolPriceProvider } from '../monitoring/types';
import type { SwapExecutor, SwapQuote } from '../swap/types';
import type { ApproveVerifyData as OpenApproveVerifyData } from '../positions/approveTx';
import type { MintInput, MintVerifyData } from '../positions/mintTx';
import type { ApproveVerifyData as ExitApproveVerifyData } from '../exits/approveTx';
import type { SwapVerifyData } from '../exits/swapTx';
import type { Logger } from './logger';

/**
 * Everything the three live cycles (screening, monitoring, exit+open-resume)
 * need, bundled once. Real construction lives in `deps.ts`
 * (`createRealAppDeps`); the integration smoke test constructs the same
 * shape with mocked RPC/contract pieces (via `createTestAppDeps` or a
 * hand-built object) -- the cycle functions in `screeningCycle.ts`/
 * `exitCycle.ts`/`app.ts` never know or care which one they were given.
 *
 * `cooldown` combines `filters/`'s `CooldownChecker` (read side, used
 * during screening) with `recordExit` (write side, called after a
 * position closes) -- `PrismaCooldownRepository` already implements both,
 * see `cooldown/cooldownRepository.ts`; nothing in `exits/` calls
 * `recordExit` itself (confirmed by reading `exits/executeExit.ts` and
 * `exits/runExitCycle.ts` -- neither has a cooldown field at all), so the
 * composition root is the first and only place this actually gets wired.
 */
export interface AppDeps {
  positions: PositionRepository;
  txAttempts: TransactionAttemptRepository;
  exitStates: ExitStateRepository;
  /** Live, operator-editable parameters (Module 10) -- pause flag + the four live-editable numeric thresholds. Read fresh every screening/exit cycle, never mutated in place. */
  settings: SettingsRepository;
  cooldown: CooldownChecker & {
    recordExit(tokenAddress: string, exitedAt?: Date): Promise<void>;
    /** Every token currently in cooldown (`GET /cooldowns`, Module 10) -- see `cooldown/cooldownRepository.ts`'s doc comment. */
    findAllActive(now?: Date): Promise<Array<{ tokenAddress: string; remainingMs: number; cooldownEndsAt: number }>>;
  };
  activePositionChecker: ActivePositionChecker;
  capitalSnapshot: CapitalSnapshotProvider;
  discoveryService: DiscoveryService;
  poolDiscovery: PoolDiscoveryPort;
  poolState: PoolStateProviderPort;
  poolVolume: PoolVolumeProviderPort;
  poolPrice: PoolPriceProvider;
  livePositionState: LivePositionStateProvider;
  swapExecutor: SwapExecutor;
  /** No existing utility read this anywhere before Module 9A (`discovery/`'s `CandidateToken` doesn't carry it) -- `blockchain/erc20.ts`'s `readErc20Decimals` fills this. */
  readTokenDecimals: (tokenAddress: Address) => Promise<number>;
  walletAddress: Address;
  logger: Logger;

  /**
   * Optional overrides for the on-chain leg builders `openPosition`/
   * `runExitCycle` already accept (Modules 8/9A) -- unused in production
   * (`createRealAppDeps` never sets them, so the real implementations
   * inside `openPosition.ts`/`executeExit.ts` apply as normal), but
   * threaded through here specifically so the integration smoke test can
   * fake "the contract"/RPC at the same tx-builder seam every other
   * smoke test in this project already uses, while still exercising the
   * REAL scheduling/orchestration/re-entrancy logic this file wires up --
   * that orchestration, not mint/swap calldata correctness (already
   * proven in Modules 8/9A's own tests), is what the integration test is
   * actually checking.
   */
  buildApproveDepsForOpen?: (amountInRaw: bigint) => TxSafetyDeps<OpenApproveVerifyData>;
  buildMintDeps?: (input: MintInput, live: LivePositionStateProvider, pool: PoolPriceProvider) => TxSafetyDeps<MintVerifyData>;
  buildRemoveLiquidityDeps?: (position: PositionRecord, live: LivePositionStateProvider, pool: PoolPriceProvider) => TxSafetyDeps<{ liquidityZero: true }>;
  buildSwapDeps?: (positionId: string, tokenAddress: Address, quote: SwapQuote, swap: SwapExecutor, exitStates: ExitStateRepository) => TxSafetyDeps<SwapVerifyData>;
  buildApproveDepsForExit?: (tokenAddress: Address, spender: Address, amountInRaw: bigint) => TxSafetyDeps<ExitApproveVerifyData>;
  /** Same reasoning as the tx-builder overrides above -- unused in production (real reads apply), lets the integration smoke test avoid ever hitting a real RPC for allowance/balance checks. */
  readAllowance?: (tokenAddress: Address, owner: Address, spender: Address) => Promise<bigint>;
  readTokenBalanceForExit?: (tokenAddress: Address, wallet: Address) => Promise<bigint>;
}
