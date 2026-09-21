import { decodeAbiParameters, decodeFunctionData, parseAbi, type Address } from 'viem';

/**
 * Decoding and policy for calldata sent DIRECTLY to an approved Universal
 * Router (the Permit2-enabled Trading API flow).
 *
 * ## Why this exists
 *
 * The `x-permit2-disabled` flow returned a SwapProxy whose address the Trading
 * API maps to the DEPRECATED proxy on chain 4663 -- reproducible across every
 * documented header and body option (investigated 2026-09-20). The
 * Permit2-enabled flow instead targets the approved Universal Router directly,
 * which is already on the allowlist, so no new address has to be trusted.
 *
 * That flow moves the risk somewhere new: the calldata is now a Universal
 * Router `execute(bytes commands, bytes[] inputs, uint256 deadline)` batch,
 * and the router will do whatever the commands say. A command list is a
 * program. This module is what reads that program before anything signs it.
 *
 * ## The one command this project must never accept
 *
 * `PERMIT2_PERMIT` (0x0a) makes the router consume an EIP-712 signature. This
 * project has no EIP-712 signing capability -- deliberately (see
 * `positions/permit2Renewal.ts`). Observed calldata does NOT contain it: the
 * router pulls funds through an on-chain Permit2 ALLOWANCE instead, which this
 * project can create with an ordinary transaction. If the API ever starts
 * emitting a permit command, that assumption has broken and the swap must fail
 * closed rather than sign something whose signature slot we cannot fill.
 */

export const UNIVERSAL_ROUTER_EXECUTE_SELECTOR = '0x3593564c';

const UNIVERSAL_ROUTER_ABI = parseAbi(['function execute(bytes commands,bytes[] inputs,uint256 deadline)']);

/** Universal Router command bytes, masked to their low 6 bits (the high bits are flags). */
export const COMMAND = {
  V3_SWAP_EXACT_IN: 0x00,
  V3_SWAP_EXACT_OUT: 0x01,
  PERMIT2_TRANSFER_FROM: 0x02,
  PERMIT2_PERMIT_BATCH: 0x03,
  SWEEP: 0x04,
  TRANSFER: 0x05,
  PAY_PORTION: 0x06,
  V2_SWAP_EXACT_IN: 0x08,
  V2_SWAP_EXACT_OUT: 0x09,
  PERMIT2_PERMIT: 0x0a,
  WRAP_ETH: 0x0b,
  UNWRAP_WETH: 0x0c,
  PERMIT2_TRANSFER_FROM_BATCH: 0x0d,
  V4_SWAP: 0x10,
} as const;

/**
 * Commands that consume an EIP-712 signature. Encountering any of these is a
 * hard stop -- this project cannot produce the signature they require.
 */
export const SIGNATURE_COMMANDS: ReadonlySet<number> = new Set([COMMAND.PERMIT2_PERMIT, COMMAND.PERMIT2_PERMIT_BATCH]);

/**
 * The only commands an exit swap is allowed to contain. Deliberately a tight
 * allowlist rather than a denylist: a command this project has never reasoned
 * about is refused, not tolerated.
 */
export const ALLOWED_EXIT_COMMANDS: ReadonlySet<number> = new Set([
  COMMAND.V3_SWAP_EXACT_IN,
  COMMAND.V2_SWAP_EXACT_IN,
  COMMAND.V4_SWAP,
  COMMAND.SWEEP,
  COMMAND.PAY_PORTION,
]);

const COMMAND_NAME: Record<number, string> = Object.fromEntries(Object.entries(COMMAND).map(([k, v]) => [v, k]));
export const commandName = (b: number): string => COMMAND_NAME[b] ?? `UNKNOWN_0x${b.toString(16).padStart(2, '0')}`;

export class UniversalRouterCalldataError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'UniversalRouterCalldataError';
  }
}

export interface DecodedUniversalRouterCall {
  commands: number[];
  /** Raw command byte string as returned, for logging/audit. */
  commandsHex: `0x${string}`;
  inputs: readonly `0x${string}`[];
  deadline: bigint;
}

/** Decodes `execute(commands, inputs, deadline)`. Throws on anything that is not that call. */
export function decodeUniversalRouterExecute(data: string): DecodedUniversalRouterCall {
  if (typeof data !== 'string' || !data.startsWith('0x')) throw new UniversalRouterCalldataError('universal router calldata is not a hex string');
  const selector = data.slice(0, 10).toLowerCase();
  if (selector !== UNIVERSAL_ROUTER_EXECUTE_SELECTOR) {
    throw new UniversalRouterCalldataError(`universal router calldata selector is ${selector}, expected ${UNIVERSAL_ROUTER_EXECUTE_SELECTOR} (execute(bytes,bytes[],uint256))`);
  }
  let decoded;
  try {
    decoded = decodeFunctionData({ abi: UNIVERSAL_ROUTER_ABI, data: data as `0x${string}` });
  } catch (err) {
    throw new UniversalRouterCalldataError(`universal router calldata could not be decoded: ${err instanceof Error ? err.message : String(err)}`);
  }
  const [commandsHex, inputs, deadline] = decoded.args;
  const body = commandsHex.slice(2);
  if (body.length % 2 !== 0) throw new UniversalRouterCalldataError(`universal router commands are not whole bytes: ${commandsHex}`);
  const commands = (body.match(/../g) ?? []).map((b) => parseInt(b, 16) & 0x3f); // low 6 bits; high bits are flags
  if (commands.length === 0) throw new UniversalRouterCalldataError('universal router calldata contains no commands');
  if (commands.length !== inputs.length) {
    throw new UniversalRouterCalldataError(`universal router command/input count mismatch: ${commands.length} commands vs ${inputs.length} inputs`);
  }
  return { commands, commandsHex, inputs, deadline };
}

/** The decoded first swap command's parameters -- the ones that must match the quote. */
export interface DecodedSwapCommand {
  command: number;
  recipient: Address;
  amountIn: bigint;
  amountOutMin: bigint;
  /** true = the router pulls the input token FROM THE WALLET (via Permit2). */
  payerIsUser: boolean;
  /** V2: the token path array. V3: the encoded path bytes. V4: not decoded here. */
  tokenIn: Address | null;
}

const V3_SWAP_EXACT_IN_ARGS = [
  { type: 'address', name: 'recipient' },
  { type: 'uint256', name: 'amountIn' },
  { type: 'uint256', name: 'amountOutMin' },
  { type: 'bytes', name: 'path' },
  { type: 'bool', name: 'payerIsUser' },
] as const;

const V2_SWAP_EXACT_IN_ARGS = [
  { type: 'address', name: 'recipient' },
  { type: 'uint256', name: 'amountIn' },
  { type: 'uint256', name: 'amountOutMin' },
  { type: 'address[]', name: 'path' },
  { type: 'bool', name: 'payerIsUser' },
] as const;

/** V3 path is `token (20) | fee (3) | token (20) | ...` -- the first 20 bytes are the input token. */
function firstTokenOfV3Path(path: `0x${string}`): Address | null {
  if (path.length < 2 + 40) return null;
  return `0x${path.slice(2, 42)}`;
}

/**
 * Decodes the swap command that actually moves the position's token. Only the
 * V2/V3 exact-in shapes are decoded to their parameters; V4_SWAP carries a
 * nested action encoding this project does not attempt to re-derive, so for V4
 * the amount/token checks are delegated to the quote echo and the balance-delta
 * verification that every exit swap already performs.
 */
export function decodeSwapCommand(command: number, input: `0x${string}`): DecodedSwapCommand | null {
  if (command === COMMAND.V3_SWAP_EXACT_IN) {
    const [recipient, amountIn, amountOutMin, path, payerIsUser] = decodeAbiParameters(V3_SWAP_EXACT_IN_ARGS, input);
    return { command, recipient, amountIn, amountOutMin, payerIsUser, tokenIn: firstTokenOfV3Path(path) };
  }
  if (command === COMMAND.V2_SWAP_EXACT_IN) {
    const [recipient, amountIn, amountOutMin, path, payerIsUser] = decodeAbiParameters(V2_SWAP_EXACT_IN_ARGS, input);
    return { command, recipient, amountIn, amountOutMin, payerIsUser, tokenIn: path.length > 0 ? (path[0] as Address) : null };
  }
  return null; // V4_SWAP and anything else: not parameter-decoded here.
}

export interface UniversalRouterExpectation {
  tokenIn: string;
  amountInRaw: bigint;
  minOutputAmountRaw: bigint;
  minReceivedRequired: boolean;
  /** The wallet that must receive the output. */
  recipient: string;
  /** Chain time is not available here; the deadline is only checked for being present and sane. */
  now: number;
}

/**
 * Full policy check on a direct Universal Router call. Throws on any
 * violation -- never clamps, never "best effort".
 */
export function assertUniversalRouterCallSafe(data: string, expected: UniversalRouterExpectation): DecodedUniversalRouterCall {
  const decoded = decodeUniversalRouterExecute(data);

  // 1. no command requiring a signature this project cannot produce
  for (const c of decoded.commands) {
    if (SIGNATURE_COMMANDS.has(c)) {
      throw new UniversalRouterCalldataError(
        `universal router calldata contains ${commandName(c)} (0x${c.toString(16).padStart(2, '0')}), which consumes an EIP-712 signature. ` +
          'This project has no EIP-712 signing capability and refuses to sign a batch whose permit slot it cannot fill -- failing closed.',
      );
    }
  }
  // 2. only commands this project has reasoned about
  for (const c of decoded.commands) {
    if (!ALLOWED_EXIT_COMMANDS.has(c)) {
      throw new UniversalRouterCalldataError(
        `universal router calldata contains ${commandName(c)} (0x${c.toString(16).padStart(2, '0')}), which is not an allowed exit-swap command ` +
          `(allowed: ${[...ALLOWED_EXIT_COMMANDS].map(commandName).join(', ')})`,
      );
    }
  }
  // 3. deadline must be present and in the future
  if (decoded.deadline <= 0n) throw new UniversalRouterCalldataError(`universal router deadline is not set (${decoded.deadline})`);
  if (decoded.deadline < BigInt(expected.now)) {
    throw new UniversalRouterCalldataError(`universal router deadline ${decoded.deadline} is already in the past (now ${expected.now})`);
  }

  // 4. the swap command's own parameters, where decodable
  const swapIndex = decoded.commands.findIndex((c) => c === COMMAND.V3_SWAP_EXACT_IN || c === COMMAND.V2_SWAP_EXACT_IN || c === COMMAND.V4_SWAP);
  if (swapIndex === -1) throw new UniversalRouterCalldataError('universal router calldata contains no swap command');
  const swapInput = decoded.inputs[swapIndex];
  if (swapInput === undefined) throw new UniversalRouterCalldataError('universal router swap command has no matching input');

  let swap: DecodedSwapCommand | null;
  try {
    const swapCommand = decoded.commands[swapIndex];
    if (swapCommand === undefined) throw new UniversalRouterCalldataError('universal router swap command index is out of range');
    swap = decodeSwapCommand(swapCommand, swapInput);
  } catch (err) {
    throw new UniversalRouterCalldataError(`universal router swap input could not be decoded: ${err instanceof Error ? err.message : String(err)}`);
  }
  if (swap === null) return decoded; // V4_SWAP: nested encoding, covered by the quote echo + balance-delta verification.

  if (swap.amountIn !== expected.amountInRaw) {
    throw new UniversalRouterCalldataError(`universal router swaps ${swap.amountIn} of the token, but ${expected.amountInRaw} was requested`);
  }
  if (swap.tokenIn !== null && swap.tokenIn.toLowerCase() !== expected.tokenIn.toLowerCase()) {
    throw new UniversalRouterCalldataError(`universal router sells token ${swap.tokenIn}, but this swap was quoted for ${expected.tokenIn}`);
  }
  if (!swap.payerIsUser) {
    throw new UniversalRouterCalldataError(
      'universal router calldata has payerIsUser=false, meaning it expects the input token to already sit in the router. ' +
        'This exit pays from the wallet, so a false payer flag does not describe the transaction being requested -- failing closed.',
    );
  }
  if (swap.recipient.toLowerCase() !== expected.recipient.toLowerCase()) {
    throw new UniversalRouterCalldataError(`universal router sends output to ${swap.recipient}, but this exit expects ${expected.recipient}`);
  }
  if (expected.minReceivedRequired && swap.amountOutMin <= 0n) {
    throw new UniversalRouterCalldataError('minimum-received protection is enabled but the universal router calldata carries a zero amountOutMin');
  }
  return decoded;
}
