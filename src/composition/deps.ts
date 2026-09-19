import { getPrismaClient } from '../storage/prismaClient';
import { getExecutorAddress } from '../blockchain/walletClient';
import { readErc20Decimals } from '../blockchain/erc20';
import { PrismaPositionRepository } from '../positions/positionRepository';
import { PositionActivePositionChecker } from '../positions/activePositionChecker';
import { PositionCapitalSnapshotProvider } from '../positions/capitalSnapshotProvider';
import { PrismaTransactionAttemptRepository } from '../execution/transactionAttemptRepository';
import { PrismaExitStateRepository } from '../exits/exitStateRepository';
import { PrismaCooldownRepository } from '../cooldown/cooldownRepository';
import { PrismaSettingsRepository } from '../settings/settingsRepository';
import { GmgnCliClient } from '../discovery/gmgnCliClient';
import { DiscoveryService } from '../discovery/discoveryService';
import { CachedRobinhoodStockClassifier, OnChainRobinhoodStockClassifier } from '../discovery/robinhoodStockClassifier';
import { InMemoryCanaryGuard } from '../capital/canary';
import { PoolManagerLogDiscovery } from '../pools/poolDiscovery';
import { StateViewPoolStateProvider } from '../pools/poolStateProvider';
import { SwapLogPoolVolumeProvider } from '../pools/poolVolumeProvider';
import { StateViewPoolPriceProvider } from '../pools/poolPriceProvider';
import { PositionManagerLivePositionStateProvider } from '../monitoring/positionStateReader';
import { PrismaPriceHistoryRepository } from '../monitoring/priceHistoryRepository';
import { TradingApiSwapClient } from '../swap/tradingApiClient';
import { PositionManagerLogNftLister, PositionManagerNftOwnerChecker, PositionManagerIdentityChecker } from '../reconciliation/nftReconciliationPorts';
import { createConsoleFileLogger } from './logger';
import type { AppDeps } from './types';

/**
 * Real, production wiring -- every piece here is the actual on-chain/
 * Prisma-backed implementation already built (and independently tested)
 * in Modules 2-9A. Nothing here is a stub or a placeholder; the ONE piece
 * that didn't already exist before this file (`StateViewPoolPriceProvider`)
 * is itself just a reshape adapter over Module 3's real
 * `StateViewPoolStateProvider` -- see `pools/poolPriceProvider.ts`'s doc
 * comment.
 */
export function createRealAppDeps(): AppDeps {
  const prisma = getPrismaClient();
  const positions = new PrismaPositionRepository(prisma);
  const txAttempts = new PrismaTransactionAttemptRepository(prisma);
  const walletAddress = getExecutorAddress();

  return {
    positions,
    txAttempts,
    exitStates: new PrismaExitStateRepository(prisma),
    settings: new PrismaSettingsRepository(prisma),
    cooldown: new PrismaCooldownRepository(prisma),
    activePositionChecker: new PositionActivePositionChecker(positions),
    // H2: txAttempts lets the snapshot account for USDG a CLOSING position has already returned.
    capitalSnapshot: new PositionCapitalSnapshotProvider(positions, walletAddress, undefined, txAttempts),
    canaryGuard: new InMemoryCanaryGuard(),
    discoveryService: new DiscoveryService(new GmgnCliClient()),
    stockClassifier: new CachedRobinhoodStockClassifier(new OnChainRobinhoodStockClassifier()),
    poolDiscovery: new PoolManagerLogDiscovery(),
    poolState: new StateViewPoolStateProvider(),
    poolVolume: new SwapLogPoolVolumeProvider(),
    poolPrice: new StateViewPoolPriceProvider(),
    livePositionState: new PositionManagerLivePositionStateProvider(),
    priceHistory: new PrismaPriceHistoryRepository(prisma),
    swapExecutor: new TradingApiSwapClient(),
    readTokenDecimals: readErc20Decimals,
    walletAddress,
    logger: createConsoleFileLogger(),
    ownedNftLister: new PositionManagerLogNftLister(),
    nftOwnerChecker: new PositionManagerNftOwnerChecker(),
    positionIdentityChecker: new PositionManagerIdentityChecker(),
  };
}
