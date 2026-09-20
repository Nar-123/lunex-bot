import type { Address } from 'viem';
import { config } from '../config';
import { readErc20Allowance } from '../blockchain/erc20';
import { readChainTimestamp, readPermit2Grant, readPositionManagerPermit2, type Permit2Grant } from '../blockchain/permit2';
import { getExecutorAddress } from '../blockchain/walletClient';

/**
 * v4 entry pre-flight: can the PositionManager actually pull `requiredAmount`
 * USDG from the wallet when the mint settles?
 *
 * v4 settlement path (VERIFIED on the first live mint, 0xfd8dbd77…504d04):
 *   wallet -> PositionManager.modifyLiquidities(MINT_POSITION, SETTLE_PAIR)
 *          -> Permit2.transferFrom(wallet, PoolManager, amount, USDG)
 *          -> USDG.transferFrom(wallet, PoolManager, amount)   [spender = Permit2]
 * so two independent authorizations are required:
 *   1. ERC20 `USDG.allowance(wallet, Permit2) >= amount` -- fixable by the
 *      entry flow's own approve leg (`approveTx.ts`, spender = Permit2);
 *   2. Permit2 grant `allowance(wallet, USDG, PositionManager)` with
 *      amount >= required and NOT expired -- a separate Permit2.approve()
 *      transaction the bot does NOT send (no supported renewal flow; the
 *      operator renews it deliberately). Its expiry is independent of (1).
 *
 * Statuses (checked in this order -- first match wins):
 *   WRONG_SPENDER               PositionManager.permit2() != configured Permit2
 *   EXPIRED                     grant expired, or expires within the minimum
 *                               remaining validity (could lapse before the mint)
 *   INSUFFICIENT_PERMIT2_GRANT  no grant, or grant amount < required
 *   INSUFFICIENT_ALLOWANCE      ERC20 allowance to Permit2 < required -> deployable,
 *                               the approve(Permit2) leg runs first
 *   VALID                       deployable, no approve needed
 */
/** UNAVAILABLE: the on-chain reads themselves failed (set by callers that fail closed, never by `evaluatePermit2Preflight`). */
export type Permit2PreflightStatus = 'VALID' | 'INSUFFICIENT_ALLOWANCE' | 'INSUFFICIENT_PERMIT2_GRANT' | 'EXPIRED' | 'WRONG_SPENDER' | 'UNAVAILABLE';

export interface Permit2PreflightInput {
  configuredPermit2: Address;
  /**
   * The (owner, token, spender) tuple the on-chain reads were actually made
   * for. Supplied by `runPermit2Preflight`; when it does not match what this
   * chain's configuration expects, the reads describe a DIFFERENT authorization
   * than the one about to be used, so the result is treated as unusable
   * (UNAVAILABLE) rather than trusted. Omitted in pure unit tests of the policy.
   */
  readFor?: { owner: Address; token: Address; spender: Address };
  expectedOwner?: Address;
  expectedToken?: Address;
  /** `PositionManager.permit2()` as read on-chain */
  positionManagerPermit2: Address;
  erc20AllowanceToPermit2: bigint;
  /** `Permit2.allowance(wallet, USDG, PositionManager)` */
  grant: Permit2Grant;
  requiredAmount: bigint;
  /** latest block timestamp, unix seconds */
  chainTimestamp: number;
  minRemainingValiditySeconds: number;
  expiryWarningSeconds: number;
  /** The spender the v4 settlement pulls through -- the PositionManager. */
  positionManagerPermit2Spender: Address;
}

export interface Permit2PreflightResult {
  status: Permit2PreflightStatus;
  /** true only for VALID / INSUFFICIENT_ALLOWANCE */
  deployable: boolean;
  /** true only for INSUFFICIENT_ALLOWANCE: approve(USDG, Permit2, amount) must run before the mint */
  needsErc20Approval: boolean;
  reason: string;
  grantExpiration: number;
  /** grant expiration minus chain time (negative once expired) */
  secondsUntilExpiry: number;
  /** deployable, but the grant expires within the warning window -- operator should renew */
  expiringSoon: boolean;
  grantNonce: number;
}

/** Permit2's own rule: `transferFrom` reverts iff block.timestamp > expiration. */
export function isPermit2GrantExpired(expiration: number, chainTimestamp: number): boolean {
  return chainTimestamp > expiration;
}

export function evaluatePermit2Preflight(i: Permit2PreflightInput): Permit2PreflightResult {
  const secondsUntilExpiry = i.grant.expiration - i.chainTimestamp;
  const base = { grantExpiration: i.grant.expiration, secondsUntilExpiry, grantNonce: i.grant.nonce, expiringSoon: false };
  const expiresAt = new Date(i.grant.expiration * 1000).toISOString();
  const block = (status: Permit2PreflightStatus, reason: string): Permit2PreflightResult => ({ ...base, status, deployable: false, needsErc20Approval: false, reason });

  // The reads must describe the authorization we are about to rely on: same
  // owner (our executor wallet), same token (the configured quote asset) and
  // same spender (the PositionManager). A mismatch means the answer is about
  // something else entirely -- never "close enough", always fail closed.
  if (i.readFor) {
    const mismatch = [
      i.expectedOwner && i.readFor.owner.toLowerCase() !== i.expectedOwner.toLowerCase() ? `owner ${i.readFor.owner} != expected ${i.expectedOwner}` : null,
      i.expectedToken && i.readFor.token.toLowerCase() !== i.expectedToken.toLowerCase() ? `token ${i.readFor.token} != expected ${i.expectedToken}` : null,
    ].filter(Boolean);
    if (mismatch.length > 0) {
      return block('UNAVAILABLE', `Permit2 state was read for a different subject (${mismatch.join('; ')}) -- refusing to judge this entry on it`);
    }
    if (i.readFor.spender.toLowerCase() !== i.positionManagerPermit2Spender.toLowerCase()) {
      return block('WRONG_SPENDER', `Permit2 grant was read for spender ${i.readFor.spender}, but settlement pulls through ${i.positionManagerPermit2Spender}`);
    }
  }
  if (i.positionManagerPermit2.toLowerCase() !== i.configuredPermit2.toLowerCase()) {
    return block('WRONG_SPENDER', `PositionManager is bound to Permit2 ${i.positionManagerPermit2}, not the configured ${i.configuredPermit2} -- refusing to approve/deploy`);
  }
  if (i.grant.amount === 0n && i.grant.expiration === 0) {
    return block('INSUFFICIENT_PERMIT2_GRANT', 'no Permit2 grant for the PositionManager exists -- operator must create one (not renewed automatically)');
  }
  if (isPermit2GrantExpired(i.grant.expiration, i.chainTimestamp)) {
    return block('EXPIRED', `Permit2 grant for the PositionManager expired at ${expiresAt} (chain time ${i.chainTimestamp}) -- operator must renew it (not renewed automatically)`);
  }
  if (secondsUntilExpiry < i.minRemainingValiditySeconds) {
    return block('EXPIRED', `Permit2 grant for the PositionManager expires at ${expiresAt}, within the ${i.minRemainingValiditySeconds}s an entry may take to reach its mint -- operator must renew it`);
  }
  if (i.grant.amount < i.requiredAmount) {
    return block('INSUFFICIENT_PERMIT2_GRANT', `Permit2 grant for the PositionManager is ${i.grant.amount}, need ${i.requiredAmount} -- operator must raise it (not changed automatically)`);
  }
  const expiringSoon = secondsUntilExpiry <= i.expiryWarningSeconds;
  if (i.erc20AllowanceToPermit2 < i.requiredAmount) {
    return { ...base, expiringSoon, status: 'INSUFFICIENT_ALLOWANCE', deployable: true, needsErc20Approval: true, reason: `USDG allowance to Permit2 is ${i.erc20AllowanceToPermit2}, need ${i.requiredAmount} -- approve(Permit2) leg required` };
  }
  return { ...base, expiringSoon, status: 'VALID', deployable: true, needsErc20Approval: false, reason: `Permit2 path valid; grant expires ${expiresAt}` };
}

export interface Permit2PreflightReaders {
  readPositionManagerPermit2?: (pm: Address) => Promise<Address>;
  readErc20Allowance?: (token: Address, owner: Address, spender: Address) => Promise<bigint>;
  readPermit2Grant?: (permit2: Address, owner: Address, token: Address, spender: Address) => Promise<Permit2Grant>;
  readChainTimestamp?: () => Promise<number>;
  walletAddress?: Address;
}

/** Reads all on-chain inputs (read-only RPC) and evaluates. Throws on RPC failure -- callers fail CLOSED. */
export async function runPermit2Preflight(requiredAmount: bigint, r: Permit2PreflightReaders = {}): Promise<Permit2PreflightResult> {
  const wallet = r.walletAddress ?? getExecutorAddress();
  const usdg = config.quoteAsset.ADDRESS as Address;
  const pm = config.uniswap.v4.positionManager as Address;
  const permit2 = config.uniswap.v4.permit2 as Address;
  const [positionManagerPermit2, erc20AllowanceToPermit2, grant, chainTimestamp] = await Promise.all([
    (r.readPositionManagerPermit2 ?? readPositionManagerPermit2)(pm),
    (r.readErc20Allowance ?? readErc20Allowance)(usdg, wallet, permit2),
    (r.readPermit2Grant ?? readPermit2Grant)(permit2, wallet, usdg, pm),
    (r.readChainTimestamp ?? readChainTimestamp)(),
  ]);
  return evaluatePermit2Preflight({
    configuredPermit2: permit2,
    positionManagerPermit2,
    positionManagerPermit2Spender: pm,
    readFor: { owner: wallet, token: usdg, spender: pm },
    expectedOwner: wallet,
    expectedToken: usdg,
    erc20AllowanceToPermit2,
    grant,
    requiredAmount,
    chainTimestamp,
    minRemainingValiditySeconds: config.rules.execution.PERMIT2_MIN_REMAINING_VALIDITY_SECONDS,
    expiryWarningSeconds: config.rules.execution.PERMIT2_EXPIRY_WARNING_SECONDS,
  });
}
