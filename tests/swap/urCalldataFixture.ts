import { encodeAbiParameters, encodeFunctionData, parseAbi, type Address } from 'viem';

/**
 * Builds REAL Universal Router `execute(commands, inputs, deadline)` calldata
 * for tests, so fixtures exercise the same decoder production does rather than
 * a placeholder hex string.
 */
const UR_ABI = parseAbi(['function execute(bytes commands,bytes[] inputs,uint256 deadline)']);

const V3_ARGS = [
  { type: 'address', name: 'recipient' },
  { type: 'uint256', name: 'amountIn' },
  { type: 'uint256', name: 'amountOutMin' },
  { type: 'bytes', name: 'path' },
  { type: 'bool', name: 'payerIsUser' },
] as const;

export interface UrFixtureOptions {
  recipient: Address;
  tokenIn: Address;
  amountIn: bigint;
  amountOutMin?: bigint;
  payerIsUser?: boolean;
  deadline?: bigint;
  /** Raw command bytes, e.g. '0x00' (V3_SWAP_EXACT_IN) or '0x0a00' (PERMIT2_PERMIT first). */
  commands?: `0x${string}`;
  /** Extra inputs appended so commands/inputs stay the same length. */
  extraInputs?: `0x${string}`[];
}

/** V3 path: token(20) | fee(3) | token(20). */
export function v3Path(tokenIn: Address, tokenOut: Address): `0x${string}` {
  return `0x${tokenIn.slice(2)}000bb8${tokenOut.slice(2)}`;
}

export function urExecuteCalldata(o: UrFixtureOptions): `0x${string}` {
  const swapInput = encodeAbiParameters(V3_ARGS, [
    o.recipient,
    o.amountIn,
    o.amountOutMin ?? 1n,
    v3Path(o.tokenIn, '0x5fc5360D0400a0Fd4f2af552ADD042D716F1d168'),
    o.payerIsUser ?? true,
  ]);
  const commands = o.commands ?? '0x00';
  const inputs = [swapInput, ...(o.extraInputs ?? [])];
  return encodeFunctionData({
    abi: UR_ABI,
    functionName: 'execute',
    args: [commands, inputs, o.deadline ?? BigInt(Math.floor(Date.now() / 1000) + 1800)],
  });
}

/** Commands with a PERMIT2_PERMIT (0x0a) first -- the batch this project must refuse. */
export function urWithPermitCommand(o: UrFixtureOptions): `0x${string}` {
  return urExecuteCalldata({ ...o, commands: '0x0a00', extraInputs: ['0xdeadbeef'] });
}
