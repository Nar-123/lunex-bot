import type { Log } from 'viem';
import { toEventSelector } from 'viem';
import type { ManualSettlementChainReader, SettlementReceiptView, SettlementTxView } from '../../src/exits/manualTokenSettlement';

// Manual TOKEN settlement via receipt -- deterministic on-chain fixtures:
// real ERC20 log encodings (the real decoder parses them) served by a fake
// chain reader. Shared by the unit, integration and OS-process tests.

export const TRANSFER = toEventSelector('Transfer(address,address,uint256)');
export const APPROVAL = toEventSelector('Approval(address,address,uint256)');
export const WITHDRAWAL = toEventSelector('Withdrawal(address,uint256)');

export const REMOVE_HASH = `0x${'ab'.repeat(32)}` as const; // what the fake tx pipeline signs as
export const SETTLE_HASH = `0x${'cd'.repeat(32)}` as const;
export const REMOVE_AT = { blockNumber: 100n, transactionIndex: 5 };

const pad = (address: string): `0x${string}` => `0x${'0'.repeat(24)}${address.toLowerCase().slice(2)}`;
const word = (value: bigint): `0x${string}` => `0x${value.toString(16).padStart(64, '0')}`;

export function transferLog(token: string, from: string, to: string, value: bigint, logIndex: number): Log {
  return { address: token, topics: [TRANSFER, pad(from), pad(to)], data: word(value), logIndex, blockNumber: 0n, blockHash: null, transactionHash: null, transactionIndex: null, removed: false } as unknown as Log;
}
export function approvalLog(token: string, owner: string, spender: string, logIndex: number): Log {
  return { address: token, topics: [APPROVAL, pad(owner), pad(spender)], data: word(1n), logIndex, blockNumber: 0n, blockHash: null, transactionHash: null, transactionIndex: null, removed: false } as unknown as Log;
}
/** e.g. a WETH unwrap by the wallet -- not an ERC20 Transfer, but it mentions the wallet. */
export function withdrawalLog(weth: string, src: string, logIndex: number): Log {
  return { address: weth, topics: [WITHDRAWAL, pad(src)], data: word(1n), logIndex, blockNumber: 0n, blockHash: null, transactionHash: null, transactionIndex: null, removed: false } as unknown as Log;
}
/** ERC721 Transfer: same selector as ERC20 but 4 topics. */
export function nftTransferLog(nft: string, from: string, to: string, tokenId: bigint, logIndex: number): Log {
  return { address: nft, topics: [TRANSFER, pad(from), pad(to), word(tokenId)], data: '0x', logIndex, blockNumber: 0n, blockHash: null, transactionHash: null, transactionIndex: null, removed: false } as unknown as Log;
}

export interface ChainTx {
  tx: SettlementTxView;
  receipt: SettlementReceiptView | null;
}

/** Fake chain: hash -> (tx, receipt|null=pending). Unknown hash -> not found. Counts reads per hash. */
export function fakeChain(chainId: number, txs: Record<string, ChainTx>, rpcChainId = chainId): ManualSettlementChainReader & { reads: string[] } {
  const reads: string[] = [];
  return {
    reads,
    getChainId: async () => rpcChainId,
    getTransaction: async (hash) => {
      reads.push(`tx:${hash}`);
      return txs[hash.toLowerCase()]?.tx ?? null;
    },
    getReceipt: async (hash) => {
      reads.push(`receipt:${hash}`);
      const t = txs[hash.toLowerCase()];
      return t ? t.receipt : null;
    },
  };
}

export interface SettlementScenario {
  wallet: string;
  token: string;
  usdg: string;
  chainId: number;
}

/** The remove-liquidity tx (block 100, index 5) plus a settlement tx in a later block with the given logs. */
export function chainWithSettlement(s: SettlementScenario, logs: Log[], o: { from?: string; value?: bigint; chainId?: number | null; status?: 'success' | 'reverted'; at?: { blockNumber: bigint; transactionIndex: number }; pending?: boolean; rpcChainId?: number } = {}) {
  return fakeChain(
    s.chainId,
    {
      [REMOVE_HASH]: { tx: { from: s.wallet, chainId: s.chainId, value: 0n }, receipt: { status: 'success', ...REMOVE_AT, logs: [] } },
      [SETTLE_HASH]: {
        tx: { from: o.from ?? s.wallet, chainId: o.chainId === undefined ? s.chainId : o.chainId, value: o.value ?? 0n },
        receipt: o.pending ? null : { status: o.status ?? 'success', ...(o.at ?? { blockNumber: 120n, transactionIndex: 0 }), logs },
      },
    },
    o.rpcChainId ?? s.chainId,
  );
}

/** A typical router swap: wallet -> router TOKEN, pool -> router USDG hop (third parties), router -> wallet USDG. */
export function swapLogs(s: SettlementScenario, tokenOut: bigint, usdgIn: bigint): Log[] {
  const ROUTER = '0x00000000000000000000000000000000000000aa';
  const POOL = '0x00000000000000000000000000000000000000bb';
  return [
    approvalLog(s.token, s.wallet, ROUTER, 0),
    transferLog(s.token, s.wallet, ROUTER, tokenOut, 1),
    transferLog(s.token, ROUTER, POOL, tokenOut, 2),
    transferLog(s.usdg, POOL, ROUTER, usdgIn, 3),
    transferLog(s.usdg, ROUTER, s.wallet, usdgIn, 4),
  ];
}
