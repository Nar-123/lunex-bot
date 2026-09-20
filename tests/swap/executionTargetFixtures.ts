import { encodeAbiParameters, parseAbiParameters } from 'viem';
import { SWAP_PROXY_EXECUTE_SELECTOR, type ExecutionTargetPolicy } from '../../src/swap/executionTargets';

/** Real addresses from the live incident -- kept verbatim so these tests pin the exact production case. */
export const APPROVED_ROUTER = '0x8876789976dEcBfCbBbe364623C63652db8C0904';
export const APPROVED_PROXY = '0x0000000085E102724e78eCd2F45DC9cA239Affad';
export const LEGACY_PROXY = '0x02E5be68D46DAc0B524905bfF209cf47EE6dB2a9';
export const UNVERIFIED_ROUTER = '0x204FAca1764B154221e35c0d20aBb3c525710498';
export const TOKEN = '0x39dBED3a2bd333467115dE45665cC57F813C4571';

export const POLICY: ExecutionTargetPolicy = { chainId: 4663, universalRouters: [APPROVED_ROUTER], swapProxies: [APPROVED_PROXY] };

/** Builds SwapProxy `execute(...)` calldata exactly as the live API does. */
export function proxyCalldata(over: { router?: string; token?: string; amount?: bigint; commands?: `0x${string}`; inputs?: `0x${string}`[]; deadline?: bigint } = {}): `0x${string}` {
  const args = encodeAbiParameters(parseAbiParameters('address router, address token, uint256 amount, bytes commands, bytes[] inputs, uint256 deadline'), [
    (over.router ?? APPROVED_ROUTER) as `0x${string}`,
    (over.token ?? TOKEN) as `0x${string}`,
    over.amount ?? 500n,
    over.commands ?? '0x00',
    over.inputs ?? ['0x1234'],
    over.deadline ?? 1_789_880_588n,
  ]);
  return `${SWAP_PROXY_EXECUTE_SELECTOR}${args.slice(2)}` as `0x${string}`;
}

