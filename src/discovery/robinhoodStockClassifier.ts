import { type Address, getAddress } from 'viem';
import { getPublicClient } from '../blockchain/viemClient';
import type { CandidateToken } from './types';

/**
 * On-chain, non-heuristic classification of whether a token is an OFFICIAL
 * Robinhood Stock Token. Mechanism (research phase, 2026-09-14): every
 * verified Robinhood Stock Token is deployed as an EIP-1967 `BeaconProxy`
 * pointing at ONE shared, Robinhood-controlled implementation contract.
 * Reading the beacon slot and resolving its `implementation()` is a
 * structural fact about the contract's own code -- not a claim by any
 * third party, and not spoofable by a copycat: a token would have to
 * genuinely share Robinhood's real implementation contract to match.
 *
 * Live-verified this session (browser network calls against
 * `robinhoodchain.blockscout.com`, the chain's official explorer, cross-
 * checked against `robinscan.io`'s independently-maintained
 * "official contract registry" flag):
 *  - NVDA and AAPL (both real Robinhood Stock Tokens) resolve to
 *    `ROBINHOOD_STOCK_IMPLEMENTATION` below.
 *  - "AAPL Cat" -- a real on-chain token that puts "AAPL" in its NAME to
 *    look like the real thing -- resolves to a completely different
 *    implementation (`DropERC20`, an unrelated `EIP-1167` minimal-clone
 *    pattern). Proof that name/ticker similarity is NOT what this check
 *    relies on.
 *  - Every real memecoin candidate checked (PONS, TWINE, DARWIN,
 *    PROHUMAN, RSTR, IA, Franklin, RSI, 富贵) has no beacon slot set at
 *    all.
 *
 * IMPORTANT -- what this can and cannot prove:
 *  - `ROBINHOOD_OFFICIAL_STOCK`: high-confidence REJECT signal. This IS
 *    one of Robinhood's own issued Stock Tokens (covers both equities
 *    and ETFs -- Robinhood's product structure doesn't sub-type them, and
 *    neither does this check; both already sit in `REJECTED_ASSET_TYPES`
 *    so no sub-typing is needed).
 *  - `NON_STOCK`: this token is NOT one of Robinhood's own Stock Tokens.
 *    It is NEVER proof that the token is a genuine Meme/Project --
 *    Robinhood Chain is permissionless, and independent third parties
 *    deploy their OWN tokenized funds/private-credit/real-estate RWAs
 *    outside Robinhood's own registry (research phase finding). Callers
 *    MUST NOT map `NON_STOCK` to an allowed asset type. Positive
 *    Meme/Project classification remains future work -- no authoritative
 *    source for it was found.
 *  - `UNKNOWN`: the check could not be completed (RPC failure, malformed
 *    beacon call). Never treated as either a pass or a confirmed reject.
 */
export type StockClassification = 'ROBINHOOD_OFFICIAL_STOCK' | 'NON_STOCK' | 'UNKNOWN';

/**
 * `bytes32(uint256(keccak256('eip1967.proxy.beacon')) - 1)` -- the standard
 * EIP-1967 beacon storage slot. Independently recomputed and verified via
 * `viem`'s `keccak256` this session, and confirmed against a real RPC read
 * (`eth_getStorageAt`) on NVDA's live contract, which resolved through this
 * exact slot to the beacon whose `implementation()` matches
 * `ROBINHOOD_STOCK_IMPLEMENTATION` below.
 */
export const EIP1967_BEACON_SLOT = '0xa3f0ad74e5423aebfd80d3ef4346578335a9a72aeaee59ff6cb3582b35133d50' as const;

/**
 * Robinhood's CURRENTLY VERIFIED "Stock" beacon implementation contract,
 * confirmed live against NVDA and AAPL on 2026-09-14 via
 * `robinhoodchain.blockscout.com` (the chain's official explorer). Beacon
 * implementations are upgradeable by design -- this is "currently
 * observed," not an eternal constant, and should be re-verified
 * periodically against Robinhood's own registry once reachable.
 */
export const ROBINHOOD_STOCK_IMPLEMENTATION: Address = getAddress('0xb35490d6f9163DE4F80d88dc75c3516eb64C5aE2');

const BEACON_IMPLEMENTATION_ABI = [
  {
    type: 'function',
    name: 'implementation',
    stateMutability: 'view',
    inputs: [],
    outputs: [{ name: '', type: 'address' }],
  },
] as const;

/**
 * Port for the two raw reads this check needs -- injectable so tests can
 * exercise every branch (zero slot, malformed beacon, RPC failure,
 * matching/non-matching implementation) without a live RPC connection,
 * same pattern as `discovery/gmgnCliClient.ts`'s injectable `runCli`.
 */
export interface BeaconStorageReader {
  /** Raw 32-byte value at `slot` for `address` (`eth_getStorageAt`). */
  getStorageAt(address: Address, slot: `0x${string}`): Promise<`0x${string}` | null | undefined>;
  /** Calls `implementation()` on an EIP-1967 `UpgradeableBeacon` contract. */
  readBeaconImplementation(beaconAddress: Address): Promise<Address>;
}

/** Real implementation, backed by Lunex's existing read-only viem client -- no new RPC dependency. */
export function createViemBeaconStorageReader(): BeaconStorageReader {
  return {
    async getStorageAt(address, slot) {
      return getPublicClient().getStorageAt({ address, slot });
    },
    async readBeaconImplementation(beaconAddress) {
      return getPublicClient().readContract({
        address: beaconAddress,
        abi: BEACON_IMPLEMENTATION_ABI,
        functionName: 'implementation',
      });
    },
  };
}

/**
 * Extracts an address from a raw 32-byte EIP-1967 storage slot value.
 * `null` means the slot is genuinely unset (all-zero) -- a definitive,
 * structurally safe "this is not a beacon proxy at all" read, distinct
 * from a read FAILURE (which never reaches this function -- see
 * `OnChainRobinhoodStockClassifier.classify`'s try/catch).
 */
export function addressFromStorageSlot(slotValue: `0x${string}` | null | undefined): Address | null {
  if (!slotValue) return null;
  const hex = slotValue.slice(2).padStart(64, '0');
  if (/^0+$/.test(hex)) return null;
  return getAddress('0x' + hex.slice(-40));
}

/** Pure decision: does a resolved beacon implementation address match Robinhood's known "Stock" implementation? */
export function classifyImplementation(implementationAddress: Address): StockClassification {
  return getAddress(implementationAddress) === ROBINHOOD_STOCK_IMPLEMENTATION ? 'ROBINHOOD_OFFICIAL_STOCK' : 'NON_STOCK';
}

export interface RobinhoodStockClassifier {
  classify(tokenAddress: Address): Promise<StockClassification>;
}

/**
 * Real classifier. Fails closed at every step: an `eth_getStorageAt`
 * failure or a malformed/non-conforming beacon `implementation()` call
 * both resolve to `UNKNOWN` -- NEVER `NON_STOCK`. A read failure must
 * never be read as "confirmed not a stock token" (per the safety
 * requirement this module was built to). Only a genuinely zero storage
 * slot -- a successful read that says "no beacon is set" -- resolves to
 * `NON_STOCK`, because that is itself a definitive, structurally safe
 * negative fact, not a failure.
 */
export class OnChainRobinhoodStockClassifier implements RobinhoodStockClassifier {
  constructor(private readonly reader: BeaconStorageReader = createViemBeaconStorageReader()) {}

  async classify(tokenAddress: Address): Promise<StockClassification> {
    let slotValue: `0x${string}` | null | undefined;
    try {
      slotValue = await this.reader.getStorageAt(tokenAddress, EIP1967_BEACON_SLOT);
    } catch {
      return 'UNKNOWN';
    }

    const beaconAddress = addressFromStorageSlot(slotValue);
    if (beaconAddress === null) {
      return 'NON_STOCK';
    }

    let implementationAddress: Address;
    try {
      implementationAddress = await this.reader.readBeaconImplementation(beaconAddress);
    } catch {
      return 'UNKNOWN';
    }

    return classifyImplementation(implementationAddress);
  }
}

/**
 * Per-address classification cache. Deliberately asymmetric: a definitive
 * `ROBINHOOD_OFFICIAL_STOCK`/`NON_STOCK` read is a structural on-chain
 * fact unlikely to flip cycle-to-cycle, so it's safe to cache and reuse
 * (saving an RPC round trip every 30-minute cycle for repeat candidates).
 * `UNKNOWN` is NEVER cached -- a transient RPC failure must always be
 * retried on the next cycle, never "stick" as a permanent classification
 * that could shadow a real answer indefinitely.
 */
export interface StockClassificationCache {
  get(tokenAddress: Address): StockClassification | undefined;
  set(tokenAddress: Address, value: StockClassification): void;
}

export class InMemoryStockClassificationCache implements StockClassificationCache {
  private readonly cache = new Map<string, StockClassification>();

  get(tokenAddress: Address): StockClassification | undefined {
    return this.cache.get(tokenAddress.toLowerCase());
  }

  set(tokenAddress: Address, value: StockClassification): void {
    if (value === 'UNKNOWN') return;
    this.cache.set(tokenAddress.toLowerCase(), value);
  }
}

/** Wraps any `RobinhoodStockClassifier` with the cache above. */
export class CachedRobinhoodStockClassifier implements RobinhoodStockClassifier {
  constructor(
    private readonly inner: RobinhoodStockClassifier,
    private readonly cache: StockClassificationCache = new InMemoryStockClassificationCache(),
  ) {}

  async classify(tokenAddress: Address): Promise<StockClassification> {
    const cached = this.cache.get(tokenAddress);
    if (cached !== undefined) return cached;
    const result = await this.inner.classify(tokenAddress);
    this.cache.set(tokenAddress, result);
    return result;
  }
}

/**
 * Merges an on-chain classification into a candidate's `assetType` AND
 * (Phase 12) its own dedicated `stockClassification` field.
 * `ROBINHOOD_OFFICIAL_STOCK` maps `assetType` to the existing `'Stock'`
 * REJECTED bucket -- already in `REJECTED_ASSET_TYPES`, no new type
 * introduced. `NON_STOCK` and `UNKNOWN` BOTH leave `assetType` exactly as
 * discovery already set it (currently always `'Unknown'`, since GMGN
 * supplies no asset-type field at all) -- NEVER inferred to
 * `'Meme'`/`'Project'`. See this module's doc comment for why `NON_STOCK`
 * cannot mean "safe" on its own.
 *
 * `stockClassification`, in contrast, is set to the classifier's raw
 * three-value result on EVERY branch, unconditionally -- this is what
 * lets `STOCK_ONLY` mode's `checkAssetType` (`filters/rules/assetType.ts`)
 * tell a classifier FAILURE (`UNKNOWN`) apart from a classifier SUCCESS
 * that confirms non-stock (`NON_STOCK`), something the flattened
 * `assetType` string alone cannot do (both leave it `'Unknown'`).
 */
export function applyStockClassification(candidate: CandidateToken, classification: StockClassification): CandidateToken {
  if (classification === 'ROBINHOOD_OFFICIAL_STOCK') {
    return { ...candidate, assetType: 'Stock', stockClassification: classification };
  }
  return { ...candidate, stockClassification: classification };
}

/**
 * Classifies and enriches every candidate, sequentially (same conservative
 * one-at-a-time pacing as GMGN's own per-candidate `token info` enrichment
 * in `gmgnCliClient.ts`). A malformed candidate address or an unexpected
 * throw from the classifier itself never crashes the whole discovery
 * batch over one bad candidate -- it degrades that single candidate to
 * `UNKNOWN`, same as any other classification failure.
 */
export async function classifyCandidates(
  candidates: CandidateToken[],
  classifier: RobinhoodStockClassifier,
): Promise<CandidateToken[]> {
  const out: CandidateToken[] = [];
  for (const candidate of candidates) {
    let classification: StockClassification;
    try {
      const address = getAddress(candidate.address);
      classification = await classifier.classify(address);
    } catch {
      classification = 'UNKNOWN';
    }
    out.push(applyStockClassification(candidate, classification));
  }
  return out;
}
