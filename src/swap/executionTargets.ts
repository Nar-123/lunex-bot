import { decodeAbiParameters, parseAbiParameters, type Address } from 'viem';

/**
 * Chain-scoped execution-target policy for exit swaps.
 *
 * ## Why two allowlists, not one
 *
 * The Uniswap Trading API's PROXY APPROVAL FLOW (the one this project uses,
 * via the `x-permit2-disabled` header -- see `tradingApiClient.ts`) does not
 * send calldata to a Universal Router any more. It sends it to a **SwapProxy**
 * whose entry point takes the router to call as its FIRST ARGUMENT:
 *
 *   execute(address router, address token, uint256 amount,
 *           bytes commands, bytes[] inputs, uint256 deadline)
 *
 * (selector 0x2894adf9, confirmed live against the production API and on-chain
 * bytecode on Robinhood Chain 4663).
 *
 * The proxy embeds NO router address of its own -- it calls whatever address
 * the calldata names. Allowlisting the proxy alone would therefore authorise
 * arbitrary routers, which is strictly weaker than the direct-router check it
 * replaces. Both layers must be checked:
 *
 *   1. the transaction target      -- an approved Universal Router OR an approved SwapProxy
 *   2. the EMBEDDED router         -- when the target is a proxy, the decoded
 *                                     `router` argument must itself be an
 *                                     approved Universal Router for this chain
 *
 * Anything else -- including a real-but-unapproved Uniswap contract -- is
 * rejected. Approval is by configuration, never by what an API response claims.
 */

const EVM_ADDRESS_RE = /^0x[0-9a-fA-F]{40}$/;

/** `execute(address,address,uint256,bytes,bytes[],uint256)` -- the SwapProxy entry point. */
export const SWAP_PROXY_EXECUTE_SELECTOR = '0x2894adf9';
const SWAP_PROXY_EXECUTE_PARAMS = parseAbiParameters('address router, address token, uint256 amount, bytes commands, bytes[] inputs, uint256 deadline');
/** selector (4 bytes) + 6 head words (32 bytes each) is the smallest possible well-formed payload. */
const MIN_PROXY_CALLDATA_BYTES = 4 + 6 * 32;

export interface ExecutionTargetPolicy {
  chainId: number;
  /** Approved Universal Routers for this chain -- may be a direct target, and is the only thing a proxy may call. */
  universalRouters: readonly string[];
  /** Approved SwapProxies for this chain (the deterministic CREATE2 deployment; never the deprecated one). */
  swapProxies: readonly string[];
}

export class ExecutionTargetError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'ExecutionTargetError';
  }
}

/** Case-insensitive comparison key. Throws on anything that is not a well-formed EVM address, so a malformed entry can never silently match nothing. */
export function normalizeAddress(value: string, label = 'address'): string {
  if (typeof value !== 'string' || !EVM_ADDRESS_RE.test(value)) {
    throw new ExecutionTargetError(`${label} is not a well-formed EVM address: ${typeof value === 'string' ? value : typeof value}`);
  }
  return value.toLowerCase();
}

function normalizeList(values: readonly string[], label: string): Set<string> {
  return new Set(values.map((v) => normalizeAddress(v, label)));
}

export type ExecutionTargetKind = 'UNIVERSAL_ROUTER' | 'SWAP_PROXY';

export interface ExecutionTargetMatch {
  kind: ExecutionTargetKind;
  address: string;
}

/**
 * Fails CLOSED: an empty allowlist never means "allow anything". A policy with
 * no approved Universal Routers is rejected outright, because a proxy target is
 * only ever useful if some router is approved for it to call.
 */
export function assertPolicyUsable(policy: ExecutionTargetPolicy): void {
  if (policy.universalRouters.length === 0) {
    throw new ExecutionTargetError(
      `no approved Universal Router is configured for chain ${policy.chainId} -- refusing to authorise any swap target (fail closed)`,
    );
  }
}

/**
 * Classifies a transaction target against the chain's allowlists. Returns null
 * for anything not explicitly approved -- the deprecated SwapProxy and any
 * router the API happens to name are simply "not approved", with no special case.
 */
export function classifyExecutionTarget(to: string, policy: ExecutionTargetPolicy): ExecutionTargetMatch | null {
  assertPolicyUsable(policy);
  const target = normalizeAddress(to, 'swap tx "to"');
  if (normalizeList(policy.universalRouters, 'configured Universal Router').has(target)) return { kind: 'UNIVERSAL_ROUTER', address: target };
  if (normalizeList(policy.swapProxies, 'configured SwapProxy').has(target)) return { kind: 'SWAP_PROXY', address: target };
  return null;
}

/** True only for an address explicitly approved as a Universal Router on this chain. */
export function isApprovedUniversalRouter(address: string, policy: ExecutionTargetPolicy): boolean {
  assertPolicyUsable(policy);
  return normalizeList(policy.universalRouters, 'configured Universal Router').has(normalizeAddress(address, 'router'));
}

export interface DecodedProxyExecute {
  router: Address;
  token: Address;
  amount: bigint;
  commands: `0x${string}`;
  inputsCount: number;
  deadline: bigint;
}

/**
 * Strictly decodes SwapProxy `execute` calldata. Every failure mode -- wrong
 * selector, truncated payload, non-hex data, ABI garbage -- throws, so a
 * caller can never accidentally proceed on a partially understood payload.
 */
export function decodeSwapProxyExecute(data: string): DecodedProxyExecute {
  if (typeof data !== 'string' || !/^0x([0-9a-fA-F]{2})*$/.test(data)) {
    throw new ExecutionTargetError(`SwapProxy calldata is not well-formed hex: ${typeof data === 'string' ? data.slice(0, 24) : typeof data}`);
  }
  const selector = data.slice(0, 10).toLowerCase();
  if (selector !== SWAP_PROXY_EXECUTE_SELECTOR) {
    throw new ExecutionTargetError(`SwapProxy calldata selector ${selector} is not ${SWAP_PROXY_EXECUTE_SELECTOR} (execute(address,address,uint256,bytes,bytes[],uint256))`);
  }
  const byteLength = (data.length - 2) / 2;
  if (byteLength < MIN_PROXY_CALLDATA_BYTES) {
    throw new ExecutionTargetError(`SwapProxy calldata is truncated: ${byteLength} bytes, need at least ${MIN_PROXY_CALLDATA_BYTES}`);
  }
  let decoded: readonly [Address, Address, bigint, `0x${string}`, readonly `0x${string}`[], bigint];
  try {
    decoded = decodeAbiParameters(SWAP_PROXY_EXECUTE_PARAMS, `0x${data.slice(10)}`);
  } catch (err) {
    throw new ExecutionTargetError(`SwapProxy calldata could not be decoded: ${err instanceof Error ? err.message.split('\n')[0] : String(err)}`);
  }
  const [router, token, amount, commands, inputs, deadline] = decoded;
  return { router, token, amount, commands, inputsCount: inputs.length, deadline };
}

/**
 * Approval-spender policy (Part 5): the ERC20 spender the API asks us to
 * approve is held to the SAME standard as a swap target -- it must be an
 * approved Universal Router or an approved SwapProxy on this chain.
 *
 * For a proxy spender the embedded-router guarantee cannot be evaluated yet
 * (the swap calldata does not exist at approval time), so this additionally
 * requires that the chain HAS approved routers -- and `validateSwapQuote`
 * enforces the embedded router before anything is signed or sent. An approval
 * on its own moves no funds; the swap that would move them cannot pass
 * validation unless its embedded router is approved too.
 */
export function classifyApprovalSpender(spender: string, policy: ExecutionTargetPolicy): ExecutionTargetMatch | null {
  return classifyExecutionTarget(spender, policy);
}
