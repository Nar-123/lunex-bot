import { describe, expect, it, vi } from 'vitest';
import { getAddress, type Address } from 'viem';
import {
  addressFromStorageSlot,
  applyStockClassification,
  classifyCandidates,
  classifyImplementation,
  CachedRobinhoodStockClassifier,
  InMemoryStockClassificationCache,
  OnChainRobinhoodStockClassifier,
  ROBINHOOD_STOCK_IMPLEMENTATION,
  type BeaconStorageReader,
  type StockClassification,
} from '../../src/discovery/robinhoodStockClassifier';
import { makeCandidateToken } from '../fixtures/candidateToken';

const ZERO_SLOT = ('0x' + '0'.repeat(64)) as `0x${string}`;

function slotFor(address: Address): `0x${string}` {
  return ('0x' + address.slice(2).toLowerCase().padStart(64, '0')) as `0x${string}`;
}

// Real, live-verified addresses from the research phase (2026-09-14):
const SOME_BEACON_ADDRESS = getAddress('0x1111111111111111111111111111111111111111');
/** The real "AAPL Cat" impostor's actual implementation -- an unrelated `DropERC20` clone, NOT Robinhood's Stock beacon. */
const IMPOSTOR_IMPLEMENTATION = getAddress('0x3de12eC4085EdB23c512f28409Ff5eF7C9dD15c5');

function fakeReader(overrides: Partial<BeaconStorageReader> = {}): BeaconStorageReader {
  return {
    getStorageAt: vi.fn(async () => ZERO_SLOT),
    readBeaconImplementation: vi.fn(async () => ROBINHOOD_STOCK_IMPLEMENTATION),
    ...overrides,
  };
}

describe('addressFromStorageSlot', () => {
  it('returns null for an all-zero 32-byte slot (no beacon set)', () => {
    expect(addressFromStorageSlot(ZERO_SLOT)).toBeNull();
  });

  it('returns null for null/undefined', () => {
    expect(addressFromStorageSlot(null)).toBeNull();
    expect(addressFromStorageSlot(undefined)).toBeNull();
  });

  it('extracts the checksummed address from the last 20 bytes of a real slot value', () => {
    expect(addressFromStorageSlot(slotFor(ROBINHOOD_STOCK_IMPLEMENTATION))).toBe(ROBINHOOD_STOCK_IMPLEMENTATION);
  });
});

describe('classifyImplementation', () => {
  it('matches Robinhood\'s verified Stock implementation, case-insensitively', () => {
    const lower = ROBINHOOD_STOCK_IMPLEMENTATION.toLowerCase() as Address;
    expect(classifyImplementation(lower)).toBe('ROBINHOOD_OFFICIAL_STOCK');
  });

  it('rejects any other implementation as NON_STOCK, including the real "AAPL Cat" impostor implementation', () => {
    expect(classifyImplementation(IMPOSTOR_IMPLEMENTATION)).toBe('NON_STOCK');
  });
});

describe('OnChainRobinhoodStockClassifier', () => {
  it('real Stock implementation => ROBINHOOD_OFFICIAL_STOCK (NVDA/AAPL live-verified pattern)', async () => {
    const reader = fakeReader({
      getStorageAt: vi.fn(async () => slotFor(SOME_BEACON_ADDRESS)),
      readBeaconImplementation: vi.fn(async () => ROBINHOOD_STOCK_IMPLEMENTATION),
    });
    const classifier = new OnChainRobinhoodStockClassifier(reader);
    await expect(classifier.classify(getAddress('0xd0601ce157db5bdc3162bbac2a2c8af5320d9eec'))).resolves.toBe(
      'ROBINHOOD_OFFICIAL_STOCK',
    );
  });

  it('a PONS-like token with no beacon slot set at all => NON_STOCK', async () => {
    const reader = fakeReader({ getStorageAt: vi.fn(async () => ZERO_SLOT) });
    const classifier = new OnChainRobinhoodStockClassifier(reader);
    const result = await classifier.classify(getAddress('0x39dbed3a2bd333467115de45665cc57f813c4571'));
    expect(result).toBe('NON_STOCK');
    expect(reader.readBeaconImplementation).not.toHaveBeenCalled(); // no beacon to resolve
  });

  it('"AAPL Cat" -- a real beacon/proxy, but a DIFFERENT (impostor) implementation despite the name/ticker => NON_STOCK, never ROBINHOOD_OFFICIAL_STOCK', async () => {
    const reader = fakeReader({
      getStorageAt: vi.fn(async () => slotFor(SOME_BEACON_ADDRESS)),
      readBeaconImplementation: vi.fn(async () => IMPOSTOR_IMPLEMENTATION),
    });
    const classifier = new OnChainRobinhoodStockClassifier(reader);
    // Name/symbol are never even passed to classify() -- only the address.
    // This proves classification cannot be swayed by a token calling
    // itself "AAPL" / "Apple" -- only the on-chain implementation matters.
    const result = await classifier.classify(getAddress('0x6ee3a4a47b8cd648595f3dbbc5feda2551044a6c'));
    expect(result).toBe('NON_STOCK');
  });

  it('an eth_getStorageAt RPC failure => UNKNOWN, never NON_STOCK', async () => {
    const reader = fakeReader({ getStorageAt: vi.fn(async () => { throw new Error('RPC timeout'); }) });
    const classifier = new OnChainRobinhoodStockClassifier(reader);
    await expect(classifier.classify(getAddress('0x1234567890123456789012345678901234567890'))).resolves.toBe('UNKNOWN');
  });

  it('a malformed/non-conforming beacon (implementation() call fails) => UNKNOWN, never NON_STOCK', async () => {
    const reader = fakeReader({
      getStorageAt: vi.fn(async () => slotFor(SOME_BEACON_ADDRESS)),
      readBeaconImplementation: vi.fn(async () => { throw new Error('execution reverted'); }),
    });
    const classifier = new OnChainRobinhoodStockClassifier(reader);
    await expect(classifier.classify(getAddress('0x1234567890123456789012345678901234567890'))).resolves.toBe('UNKNOWN');
  });
});

describe('CachedRobinhoodStockClassifier / InMemoryStockClassificationCache', () => {
  const address = getAddress('0xd0601ce157db5bdc3162bbac2a2c8af5320d9eec');

  it('caches a definitive ROBINHOOD_OFFICIAL_STOCK result -- the inner classifier is not called again', async () => {
    const inner = { classify: vi.fn(async () => 'ROBINHOOD_OFFICIAL_STOCK' as const) };
    const cached = new CachedRobinhoodStockClassifier(inner);

    await expect(cached.classify(address)).resolves.toBe('ROBINHOOD_OFFICIAL_STOCK');
    await expect(cached.classify(address)).resolves.toBe('ROBINHOOD_OFFICIAL_STOCK');
    expect(inner.classify).toHaveBeenCalledTimes(1);
  });

  it('caches a definitive NON_STOCK result too', async () => {
    const inner = { classify: vi.fn(async () => 'NON_STOCK' as const) };
    const cached = new CachedRobinhoodStockClassifier(inner);

    await cached.classify(address);
    await cached.classify(address);
    expect(inner.classify).toHaveBeenCalledTimes(1);
  });

  it('NEVER caches UNKNOWN -- every call retries the inner classifier fresh, so a transient RPC failure cannot stick permanently', async () => {
    const inner = { classify: vi.fn(async () => 'UNKNOWN' as const) };
    const cached = new CachedRobinhoodStockClassifier(inner);

    await cached.classify(address);
    await cached.classify(address);
    await cached.classify(address);
    expect(inner.classify).toHaveBeenCalledTimes(3);
  });

  it('InMemoryStockClassificationCache.set is a no-op for UNKNOWN directly', () => {
    const cache = new InMemoryStockClassificationCache();
    cache.set(address, 'UNKNOWN');
    expect(cache.get(address)).toBeUndefined();
    cache.set(address, 'NON_STOCK');
    expect(cache.get(address)).toBe('NON_STOCK');
  });
});

describe('applyStockClassification', () => {
  it('ROBINHOOD_OFFICIAL_STOCK maps to the existing rejected "Stock" bucket', () => {
    const candidate = makeCandidateToken({ assetType: 'Unknown' });
    const result = applyStockClassification(candidate, 'ROBINHOOD_OFFICIAL_STOCK');
    expect(result.assetType).toBe('Stock');
  });

  it('NON_STOCK does NOT rewrite assetType to Meme/Project -- it is left exactly as discovery set it', () => {
    const candidate = makeCandidateToken({ assetType: 'Unknown' });
    const result = applyStockClassification(candidate, 'NON_STOCK');
    expect(result.assetType).toBe('Unknown');
  });

  it('UNKNOWN does NOT rewrite assetType either', () => {
    const candidate = makeCandidateToken({ assetType: 'Unknown' });
    const result = applyStockClassification(candidate, 'UNKNOWN');
    expect(result.assetType).toBe('Unknown');
  });

  it('never mutates the input candidate', () => {
    const candidate = makeCandidateToken({ assetType: 'Unknown' });
    applyStockClassification(candidate, 'ROBINHOOD_OFFICIAL_STOCK');
    expect(candidate.assetType).toBe('Unknown');
  });
});

describe('classifyCandidates', () => {
  it('enriches only the candidates the classifier confirms as official stock, leaves the rest untouched', async () => {
    const nvda = makeCandidateToken({ address: '0xd0601ce157db5bdc3162bbac2a2c8af5320d9eec', symbol: 'NVDA', assetType: 'Unknown' });
    const pons = makeCandidateToken({ address: '0x39dbed3a2bd333467115de45665cc57f813c4571', symbol: 'PONS', assetType: 'Unknown' });

    const classifications: Record<string, StockClassification> = {
      [nvda.address.toLowerCase()]: 'ROBINHOOD_OFFICIAL_STOCK',
      [pons.address.toLowerCase()]: 'NON_STOCK',
    };
    const classifier = { classify: vi.fn(async (addr: Address) => classifications[addr.toLowerCase()] ?? 'UNKNOWN') };

    const [outNvda, outPons] = await classifyCandidates([nvda, pons], classifier);

    expect(outNvda?.assetType).toBe('Stock');
    expect(outPons?.assetType).toBe('Unknown');
  });

  it('a malformed candidate address degrades to UNKNOWN (leaves assetType unchanged) instead of crashing the whole batch', async () => {
    const bad = makeCandidateToken({ address: 'not-a-real-address', assetType: 'Unknown' });
    const classifier = { classify: vi.fn(async () => 'ROBINHOOD_OFFICIAL_STOCK' as const) };

    const [out] = await classifyCandidates([bad], classifier);

    expect(out?.assetType).toBe('Unknown'); // never touched -- address parsing failed before classify() was even called
    expect(classifier.classify).not.toHaveBeenCalled();
  });

  it('a classifier that throws for one candidate degrades that candidate to UNKNOWN without crashing the batch', async () => {
    const a = makeCandidateToken({ address: '0x1111111111111111111111111111111111111111', symbol: 'A', assetType: 'Unknown' });
    const b = makeCandidateToken({ address: '0x2222222222222222222222222222222222222222', symbol: 'B', assetType: 'Unknown' });
    const classifier = {
      classify: vi.fn(async (addr: Address) => {
        if (getAddress(addr) === getAddress(a.address)) throw new Error('RPC blew up');
        return 'ROBINHOOD_OFFICIAL_STOCK' as const;
      }),
    };

    const [outA, outB] = await classifyCandidates([a, b], classifier);

    expect(outA?.assetType).toBe('Unknown'); // degraded to UNKNOWN, not crashed, not falsely classified
    expect(outB?.assetType).toBe('Stock');
  });
});
