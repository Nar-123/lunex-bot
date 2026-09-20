/**
 * VERIFIED against the installed `viem` version: `sendRawTransaction`
 * does NOT go through viem's typed node-error wrapping (unlike
 * `call`/`estimateGas`) -- it's a bare `client.request(...)` call, so
 * whatever the node returns comes back as a generic `RpcRequestError`.
 * That class (like every viem `BaseError`) sets `details: error.message`
 * from the raw underlying error and always appends a `Details: ...` line
 * to the final `.message` string -- so the exact raw node text (e.g.
 * "nonce too low", "already known") is reliably present as a substring
 * of `err.message` regardless of how many wrapping layers viem adds.
 * That's what makes plain substring matching on `.message` (rather than
 * a more brittle `instanceof` check against viem's typed error classes,
 * which don't even apply to this specific RPC call) both correct and
 * simple here.
 *
 * Classifies a broadcast (`eth_sendRawTransaction`-equivalent) error
 * message so `executeCriticalTransaction` can distinguish a deterministic,
 * synchronous rejection from a genuinely ambiguous network failure
 * (timeout, connection refused, RPC 5xx, or anything unrecognized).
 *
 * Deliberately conservative -- per explicit review, this must NOT make
 * the default more aggressive. Only patterns that are unambiguous facts
 * about this exact signed payload are classified as anything other than
 * `AMBIGUOUS`; everything else (including any message not matched below)
 * stays `AMBIGUOUS` exactly as it always has.
 *
 * `POSSIBLY_OURS` exists because "nonce too low" and "replacement
 * transaction underpriced" both have a real, non-rare alternate meaning:
 * our own earlier broadcast of this EXACT signed payload already landed
 * (in the mempool or even mined), and this is a redundant retry seeing
 * that fact reflected back. The caller MUST check for a receipt under
 * our own tx hash before concluding this payload is dead -- never assume
 * either way.
 *
 * Deliberately NOT included: "nonce too high" -- per review, its meaning
 * varies by client/config (some nodes still eventually accept it once a
 * gap-filling tx lands), so it stays `AMBIGUOUS` rather than risk
 * abandoning a transaction that could still succeed.
 */
export type BroadcastErrorClassification =
  | { kind: 'ALREADY_KNOWN' }
  | { kind: 'FEE_TOO_LOW' }
  | { kind: 'POSSIBLY_OURS' }
  | { kind: 'DEFINITIVE_REJECTED'; reason: string }
  | { kind: 'AMBIGUOUS' };

export function classifyBroadcastError(message: string): BroadcastErrorClassification {
  const lower = message.toLowerCase();

  if (lower.includes('already known')) {
    return { kind: 'ALREADY_KNOWN' };
  }

  if (lower.includes('nonce too low') || lower.includes('replacement transaction underpriced')) {
    return { kind: 'POSSIBLY_OURS' };
  }

  // Node-side base-fee admission check (geth ErrFeeCapTooLow; returned by the
  // production provider as JSON-RPC -32000, VERIFIED live 2026-09-19). A
  // deterministic statement about THIS payload at THIS moment: the node did
  // not accept it, and the same signed bytes become acceptable again once the
  // base fee falls back under the signed price. Not ambiguous, not dead --
  // the caller keeps the SAME signed payload (same nonce, same hash) and
  // re-broadcasts it; it still checks for a receipt under our hash first,
  // because an EARLIER broadcast of these exact bytes may have landed.
  if (lower.includes('max fee per gas less than block base fee')) {
    return { kind: 'FEE_TOO_LOW' };
  }

  if (lower.includes('insufficient funds')) {
    return { kind: 'DEFINITIVE_REJECTED', reason: message };
  }

  return { kind: 'AMBIGUOUS' };
}
