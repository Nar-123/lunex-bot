import type { Address } from 'viem';
import { decodeFunctionData, encodeFunctionData, parseEventLogs } from 'viem';
import { getPublicClient } from './viemClient';

const ERC20_ABI = [
  {
    type: 'function',
    name: 'balanceOf',
    stateMutability: 'view',
    inputs: [{ name: 'account', type: 'address' }],
    outputs: [{ name: '', type: 'uint256' }],
  },
  {
    type: 'function',
    name: 'allowance',
    stateMutability: 'view',
    inputs: [
      { name: 'owner', type: 'address' },
      { name: 'spender', type: 'address' },
    ],
    outputs: [{ name: '', type: 'uint256' }],
  },
  {
    type: 'function',
    name: 'approve',
    stateMutability: 'nonpayable',
    inputs: [
      { name: 'spender', type: 'address' },
      { name: 'amount', type: 'uint256' },
    ],
    outputs: [{ name: '', type: 'bool' }],
  },
  {
    type: 'function',
    name: 'decimals',
    stateMutability: 'view',
    inputs: [],
    outputs: [{ name: '', type: 'uint8' }],
  },
] as const;

/** Standard ERC20 `Transfer(address indexed from, address indexed to, uint256 value)` -- shared by the realized-proceeds receipt decoder below. */
export const ERC20_TRANSFER_EVENT = {
  type: 'event',
  name: 'Transfer',
  inputs: [
    { name: 'from', type: 'address', indexed: true },
    { name: 'to', type: 'address', indexed: true },
    { name: 'value', type: 'uint256', indexed: false },
  ],
} as const;

/**
 * Generic ERC20 `balanceOf` read for an arbitrary token -- factored out of
 * `capital/usdgBalanceReader.ts` (which stays USDG-specific by name/intent)
 * because `exits/swapTx.ts` needs the SAME read for two different tokens:
 * the TOKEN being exited (to determine how much to swap, after
 * remove-liquidity) and USDG again (to verify the swap's on-chain effect).
 */
export async function readErc20Balance(tokenAddress: Address, walletAddress: Address): Promise<bigint> {
  const client = getPublicClient();
  return client.readContract({
    address: tokenAddress,
    abi: ERC20_ABI,
    functionName: 'balanceOf',
    args: [walletAddress],
  });
}

/** Generic ERC20 `allowance` read -- `exits/approveTx.ts` uses this to check whether an `approve()` transaction is even necessary before the exit swap runs. */
export async function readErc20Allowance(tokenAddress: Address, owner: Address, spender: Address): Promise<bigint> {
  const client = getPublicClient();
  return client.readContract({
    address: tokenAddress,
    abi: ERC20_ABI,
    functionName: 'allowance',
    args: [owner, spender],
  });
}

/**
 * Generic ERC20 `decimals` read -- no existing utility reads this anywhere
 * in the codebase (`discovery/`'s `CandidateToken` doesn't carry it, GMGN's
 * responses don't include it). `positions/openPosition.ts` needs a
 * candidate token's real decimals to construct its `Token` entity for the
 * v4 SDK's liquidity math -- assuming 18 (like USDG) would silently
 * mis-price any token that isn't.
 */
export async function readErc20Decimals(tokenAddress: Address): Promise<number> {
  const client = getPublicClient();
  return client.readContract({
    address: tokenAddress,
    abi: ERC20_ABI,
    functionName: 'decimals',
    args: [],
  });
}

/**
 * Phase 12G fail-fast guard: confirms `config.quoteAsset.DECIMALS` (a
 * static, trusted-everywhere value -- `mintTx.ts`, `removeLiquidityTx.ts`,
 * `screeningCycle.ts`, `poolVolumeProvider.ts`, `computePositionMetrics.ts`
 * all read it directly, none re-verify it) genuinely matches the USDG
 * contract's own on-chain `decimals()` before the app starts screening or
 * transacting. Reuses `readErc20Decimals` (the SAME generic ERC20 read
 * already used for candidate tokens) rather than duplicating RPC logic --
 * `readDecimals` stays injectable purely so this can be unit-tested without
 * a live RPC call, the same discipline `capitalSnapshotProvider.ts`'s
 * injectable `readBalance` and `mintTx.ts`'s injectable
 * `discoverTokenId`/`ensureBinding` already use throughout this codebase.
 *
 * Deliberately does NOT catch/soften the on-chain read failing (e.g. RPC
 * unreachable at startup) -- an unreadable USDG contract is itself a
 * legitimate reason to fail fast, not a reason to silently skip the check
 * and trust the static config.
 */
export async function assertQuoteAssetDecimalsMatchOnChain(
  tokenAddress: Address,
  configuredDecimals: number,
  readDecimals: (tokenAddress: Address) => Promise<number> = readErc20Decimals,
): Promise<void> {
  const onChainDecimals = await readDecimals(tokenAddress);
  if (onChainDecimals !== configuredDecimals) {
    throw new Error(
      `FATAL: quote asset decimals mismatch -- config.quoteAsset.DECIMALS is ${configuredDecimals} but the ` +
        `real on-chain USDG contract (${tokenAddress}) reports decimals()=${onChainDecimals}. Every raw USDG ` +
        'amount in mintTx.ts/removeLiquidityTx.ts/screeningCycle.ts/poolVolumeProvider.ts/computePositionMetrics.ts ' +
        'would be misinterpreted by this codebase. Refusing to start. Fix USDG_DECIMALS in .env to match the real ' +
        'on-chain value.',
    );
  }
}

/** Encodes calldata for an ERC20 `approve(spender, amount)` call -- `to` is the TOKEN contract itself (not the spender), matching ERC20's own call shape. */
export function encodeErc20Approve(tokenAddress: Address, spender: Address, amount: bigint): { to: Address; data: `0x${string}` } {
  return {
    to: tokenAddress,
    data: encodeFunctionData({ abi: ERC20_ABI, functionName: 'approve', args: [spender, amount] }),
  };
}

/**
 * C5 fix: decodes the `spender` argument out of ERC20 `approve()`
 * calldata -- used by `swap/tradingApiMapper.ts` to learn the real
 * spender contract from the Trading API's `POST /check_approval` response
 * (which returns ready-to-sign approval calldata, no separate explicit
 * `spender` field). Deliberately used only to LEARN the spender, never to
 * broadcast the API's own calldata directly -- `exits/approveTx.ts` builds
 * its own exact-`amountInRaw` approve() from this spender, preserving this
 * project's "approve exactly what's needed, never unbounded" discipline
 * regardless of what amount the API's own transaction might have encoded.
 * Returns `null` if `data` isn't a well-formed `approve()` call.
 */
export function decodeErc20ApproveSpender(data: `0x${string}`): Address | null {
  try {
    const decoded = decodeFunctionData({ abi: ERC20_ABI, data });
    if (decoded.functionName !== 'approve') return null;
    return decoded.args[0];
  } catch {
    return null;
  }
}

/**
 * VALIDATION PHASE (realized-PnL persistence): sums every ERC20
 * `Transfer(... -> wallet)` of `tokenAddress` in one CONFIRMED
 * transaction's own receipt -- i.e. exactly what that transaction paid out
 * to the wallet in that token, nothing else.
 *
 * Why receipt logs rather than balance-before/after deltas (the swap leg's
 * existing verification trick): with up to 3 concurrent positions, another
 * cycle's mint/exit can land in the same wallet between the two balance
 * reads and corrupt the delta. The receipt of a specific transaction is
 * scoped to exactly that transaction's own effects -- immune to
 * concurrent wallet activity by construction, and exact down to the last
 * raw unit.
 *
 * REVERSED DIRECTION (`from` the wallet) is deliberately NOT counted --
 * this measures proceeds TO the wallet. The exit flow's transactions never
 * send USDG away (remove-liquidity and the swap both only receive), so a
 * well-formed exit receipt has no USDG `from`-wallet transfers at all;
 * counting them would only ever subtract gas-unrelated noise.
 *
 * A transaction with ZERO matching transfers returns 0n, not null: an
 * empty log list is a real, decoded fact about that receipt. Only a
 * failure to READ or DECODE the receipt propagates (throws) so callers
 * can treat it as "not measured" rather than "proceeded zero".
 */
export async function readErc20TransfersTo(
  txHash: `0x${string}`,
  tokenAddress: Address,
  walletAddress: Address,
): Promise<bigint> {
  const client = getPublicClient();
  const receipt = await client.getTransactionReceipt({ hash: txHash });
  const events = parseEventLogs({
    abi: [ERC20_TRANSFER_EVENT],
    logs: receipt.logs,
    eventName: 'Transfer',
  });

  let total = 0n;
  for (const event of events) {
    if (
      event.address.toLowerCase() === tokenAddress.toLowerCase() &&
      event.args.to.toLowerCase() === walletAddress.toLowerCase()
    ) {
      total += event.args.value;
    }
  }
  return total;
}
