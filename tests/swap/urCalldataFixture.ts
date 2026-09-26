import { encodeAbiParameters, encodeFunctionData, parseAbi, type Address } from 'viem';
import { config } from '../../src/config';

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

/**
 * The OFFICIAL configured quote asset -- read from config exactly as production
 * does, so a fixture path can never end somewhere the validator would accept
 * only because the test hardcoded a different USDG than the code reads.
 * D8: every fixture path ends here, because every real exit leg must.
 */
export const FIXTURE_USDG = config.quoteAsset.ADDRESS as Address;

export interface UrFixtureOptions {
  recipient: Address;
  tokenIn: Address;
  /** D8: defaults to the official USDG -- overridden only to prove a wrong destination is refused. */
  tokenOut?: Address;
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
    v3Path(o.tokenIn, o.tokenOut ?? FIXTURE_USDG),
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
