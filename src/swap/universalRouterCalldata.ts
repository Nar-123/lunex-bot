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
 * The only commands an exit swap is allowed to contain: exactly the two whose
 * every parameter this module decodes and checks (D7).
 *
 *  - `V4_SWAP` is REFUSED. Its payload is a nested V4Router action program
 *    (settle/take/swap actions with their own currencies and recipients); this
 *    release does not decode it, and a partial decoder would be worse than none.
 *    The client also requests `protocols: ['V2','V3']`, so the API should not
 *    offer V4 routes at all -- this refusal is the backstop if it does.
 *  - `SWEEP` and `PAY_PORTION` are REFUSED too. They move whatever the router
 *    holds to a recipient they name; with every leg paying the wallet directly
 *    they would be inert, but an accepted command whose parameters are never
 *    checked is exactly what this module exists to rule out. No observed exit
 *    route uses them.
 */
export const ALLOWED_EXIT_COMMANDS: ReadonlySet<number> = new Set([COMMAND.V3_SWAP_EXACT_IN, COMMAND.V2_SWAP_EXACT_IN]);

/** Swap commands that exist but are refused outright, each with its reason. */
const REFUSED_SWAP_COMMANDS: ReadonlyMap<number, string> = new Map([
  [COMMAND.V4_SWAP, 'V4_SWAP carries a nested V4Router action program that this release does not decode -- refused rather than partially trusted'],
  [COMMAND.V3_SWAP_EXACT_OUT, 'exact-OUTPUT swaps are not how an exit is quoted (EXACT_INPUT only)'],
  [COMMAND.V2_SWAP_EXACT_OUT, 'exact-OUTPUT swaps are not how an exit is quoted (EXACT_INPUT only)'],
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

/**
 * V3 path is `token (20) | fee (3) | token (20) | ...`, so its length is
 * 20 + 23n bytes for n >= 1 hops. The first 20 bytes are the input token.
 * Anything else is malformed and yields `null`, which the caller REJECTS.
 */
function firstTokenOfV3Path(path: `0x${string}`): Address | null {
  const bytes = (path.length - 2) / 2;
  if (!Number.isInteger(bytes) || bytes < 43 || (bytes - 20) % 23 !== 0) return null;
  return `0x${path.slice(2, 42)}`;
}

/**
 * Decodes one V2/V3 EXACT-INPUT swap leg into the fields the policy checks.
 * Returns `null` for anything else -- including `V4_SWAP` -- and the policy
 * treats `null` as a rejection, never as "nothing to check". (Before D7 the
 * V4 case returned early and was described as covered by the quote echo and
 * the post-swap balance check; neither validates the calldata before signing,
 * so that reasoning was wrong and has been removed.)
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
  return null; // not a V2/V3 exact-input leg -- the caller rejects it
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
 *
 * D7: EVERY command is examined and EVERY swap leg is validated. The previous
 * version located the first swap command with `findIndex` and checked only
 * that one, so a legitimate first leg could carry an unchecked second leg (an
 * attacker recipient, a zero minimum) straight through.
 */
export function assertUniversalRouterCallSafe(data: string, expected: UniversalRouterExpectation): DecodedUniversalRouterCall {
  const decoded = decodeUniversalRouterExecute(data);
  const hex = (c: number): string => `0x${c.toString(16).padStart(2, '0')}`;

  // 1. one deadline per batch: present, and in the future
  if (decoded.deadline <= 0n) throw new UniversalRouterCalldataError(`universal router deadline is not set (${decoded.deadline})`);
  if (decoded.deadline < BigInt(expected.now)) {
    throw new UniversalRouterCalldataError(`universal router deadline ${decoded.deadline} is already in the past (now ${expected.now})`);
  }

  // 2. every command, in order -- nothing is skipped or tolerated
  let total = 0n;
  let legs = 0;
  decoded.commands.forEach((c, i) => {
    if (SIGNATURE_COMMANDS.has(c)) {
      throw new UniversalRouterCalldataError(
        `universal router calldata contains ${commandName(c)} (${hex(c)}) at position ${i}, which consumes an EIP-712 signature. ` +
          'This project has no EIP-712 signing capability and refuses to sign a batch whose permit slot it cannot fill -- failing closed.',
      );
    }
    const refused = REFUSED_SWAP_COMMANDS.get(c);
    if (refused !== undefined) {
      throw new UniversalRouterCalldataError(`universal router calldata contains ${commandName(c)} (${hex(c)}) at position ${i}: ${refused}`);
    }
    if (!ALLOWED_EXIT_COMMANDS.has(c)) {
      throw new UniversalRouterCalldataError(
        `universal router calldata contains ${commandName(c)} (${hex(c)}) at position ${i}, which is not an allowed exit-swap command ` +
          `(allowed: ${[...ALLOWED_EXIT_COMMANDS].map(commandName).join(', ')})`,
      );
    }

    // 3. a V2/V3 exact-in leg: decode it and check every field
    const input = decoded.inputs[i];
    if (input === undefined) throw new UniversalRouterCalldataError(`universal router swap command at position ${i} has no matching input`);
    let leg: DecodedSwapCommand | null;
    try {
      leg = decodeSwapCommand(c, input);
    } catch (err) {
      throw new UniversalRouterCalldataError(`universal router swap leg ${i} could not be decoded: ${err instanceof Error ? err.message : String(err)}`);
    }
    if (leg === null) throw new UniversalRouterCalldataError(`universal router swap leg ${i} (${commandName(c)}) is not a decodable exact-input swap`);

    if (leg.tokenIn === null) {
      throw new UniversalRouterCalldataError(`universal router swap leg ${i} has a malformed path -- its input token cannot be determined, so the leg is refused rather than the token check skipped`);
    }
    if (leg.tokenIn.toLowerCase() !== expected.tokenIn.toLowerCase()) {
      throw new UniversalRouterCalldataError(`universal router swap leg ${i} sells token ${leg.tokenIn}, but this swap was quoted for ${expected.tokenIn}`);
    }
    if (leg.amountIn <= 0n) throw new UniversalRouterCalldataError(`universal router swap leg ${i} has a non-positive input amount ${leg.amountIn}`);
    if (leg.recipient.toLowerCase() !== expected.recipient.toLowerCase()) {
      throw new UniversalRouterCalldataError(`universal router swap leg ${i} sends output to ${leg.recipient}, but this exit expects ${expected.recipient}`);
    }
    if (!leg.payerIsUser) {
      throw new UniversalRouterCalldataError(
        `universal router swap leg ${i} has payerIsUser=false, meaning it expects the input token to already sit in the router. ` +
          'This exit pays every leg from the wallet, so a false payer flag does not describe the transaction being requested -- failing closed.',
      );
    }
    if (leg.amountOutMin <= 0n) {
      throw new UniversalRouterCalldataError(`universal router swap leg ${i} carries a zero amountOutMin -- an unbounded leg is refused on every exit`);
    }
    total += leg.amountIn;
    legs += 1;
  });

  if (legs === 0) throw new UniversalRouterCalldataError('universal router calldata contains no swap leg');
  // 4. exact-input: the legs together must sell EXACTLY the requested amount
  if (total !== expected.amountInRaw) {
    const short = total < expected.amountInRaw;
    throw new UniversalRouterCalldataError(
      `universal router swap legs sell ${total} of the token in total across ${legs} leg(s), but exactly ${expected.amountInRaw} was requested ` +
        `(${short ? 'short' : 'over'} by ${short ? expected.amountInRaw - total : total - expected.amountInRaw})`,
    );
  }
  return decoded;
}
