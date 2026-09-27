import { fallback, http, type Transport } from 'viem';

/**
 * RPC endpoint selection and transport composition for every chain READ this
 * project makes -- and, through `execution/viemTxSteps.ts`, for broadcast and
 * receipt reads too, since they all go through `getPublicClient()`.
 *
 * ## Why this exists
 *
 * The public client used to be `http(config.chain.rpcUrl)` -- a SINGLE
 * endpoint. `RPC_FALLBACK_URLS` was parsed into `config.chain.rpcFallbackUrls`
 * and listed in the chain definition's `rpcUrls`, but viem's `http()` never
 * rotates through that array, so the fallbacks were decorative. When the
 * primary provider returned `429 Monthly capacity limit exceeded`
 * (2026-09-26), every chain read failed even though two healthy endpoints were
 * configured/reachable: the startup execution-target verification would fail
 * closed, and no exit could be built, simulated or broadcast.
 *
 * ## How failover works
 *
 * `fallback([...])` asks endpoint 0 first and moves to the next ONLY when the
 * error is not a deterministic answer. viem's own `shouldThrow` classification
 * decides that (viem 2.56.3): it rethrows immediately -- without trying another
 * provider -- for `TransactionRejectedRpcError`, `UserRejectedRequestError`,
 * `WalletConnectSessionSettlementError`, code 5000, and anything whose message
 * matches `ExecutionRevertedError`. That is exactly the behaviour this project
 * wants:
 *
 *  - a 429, a 5xx, a timeout or a socket error is a PROVIDER problem -> try the
 *    next endpoint;
 *  - an `eth_call` that REVERTS is a real answer from the chain -> it must NOT
 *    be re-asked elsewhere (a reverting simulation is a legitimate "no", and
 *    shopping it around providers could turn a refusal into an accident).
 *
 * `rank: false` (viem's default, set explicitly here) keeps the operator's
 * configured order fixed: primary first, then each fallback in the order given.
 * Latency-based ranking is deliberately NOT used -- deployment behaviour must be
 * reproducible, and a "fastest" provider is not necessarily the trusted one.
 *
 * ## Bounded latency, no retry storm
 *
 * `fallback` instantiates each inner transport with `retryCount: 0`, so one pass
 * makes exactly ONE attempt per endpoint; the retry budget lives on the fallback
 * itself. With `PASS_RETRIES = 1` a request therefore makes at most
 *
 *     (PASS_RETRIES + 1) passes x N endpoints = 2N attempts,
 *
 * each capped by `REQUEST_TIMEOUT_MS`, so the worst case is `2 * N * 8s`
 * (32s for the two endpoints configured in production). Note this is FASTER
 * than the previous single-endpoint default (viem's `retryCount: 3` with
 * exponential backoff against one dead provider), while additionally surviving
 * the loss of a whole provider. Adding endpoints extends the worst case
 * linearly -- that is the cost an operator accepts per extra entry.
 *
 * Failover does not hide a persistent outage: when every endpoint fails the
 * final error propagates unchanged, and each caller's existing fail-closed
 * handling applies (the execution-target gate refuses swaps, the exit defers,
 * `executeCriticalTransaction` reports an ambiguous/resumable step -- nothing
 * is fabricated and nothing is mutated).
 */

/** Per-attempt cap. One attempt per endpoint per pass (see the doc comment). */
export const RPC_REQUEST_TIMEOUT_MS = 8_000;
/** Extra passes over the whole endpoint list. 1 => at most 2 attempts per endpoint. */
export const RPC_PASS_RETRIES = 1;
/** Delay between passes; short, because a pass has already cost real time. */
export const RPC_PASS_RETRY_DELAY_MS = 250;

export interface ResolvedRpcEndpoints {
  /** In priority order: the primary first, then each usable fallback. */
  urls: string[];
  /**
   * Entries dropped because they were empty, malformed, or duplicates --
   * reported by INDEX only. An RPC URL can embed an API key, so the URLs
   * themselves are never surfaced here (see `execution/redactError.ts`, which
   * scrubs them from error text for the same reason).
   */
  dropped: { index: number; reason: 'empty' | 'malformed' | 'duplicate' }[];
}

function isUsableRpcUrl(value: string): boolean {
  try {
    const parsed = new URL(value);
    return parsed.protocol === 'http:' || parsed.protocol === 'https:';
  } catch {
    return false;
  }
}

/**
 * Builds the ordered endpoint list. The PRIMARY is authoritative: if it is
 * missing or malformed this throws rather than silently promoting a fallback to
 * primary -- a deployment must never end up talking to a different provider than
 * the operator configured without saying so. Fallback entries are individually
 * skipped when unusable, so one typo cannot take the bot offline.
 */
export function resolveRpcEndpoints(primary: string, fallbacks: readonly string[] = []): ResolvedRpcEndpoints {
  const trimmedPrimary = typeof primary === 'string' ? primary.trim() : '';
  if (!isUsableRpcUrl(trimmedPrimary)) {
    throw new Error('RPC_URL is missing or not an http(s) URL -- refusing to build a chain client without a usable primary endpoint');
  }
  const urls = [trimmedPrimary];
  const dropped: ResolvedRpcEndpoints['dropped'] = [];
  fallbacks.forEach((raw, i) => {
    const url = typeof raw === 'string' ? raw.trim() : '';
    if (url === '') {
      dropped.push({ index: i, reason: 'empty' });
      return;
    }
    if (!isUsableRpcUrl(url)) {
      dropped.push({ index: i, reason: 'malformed' });
      return;
    }
    if (urls.includes(url)) {
      dropped.push({ index: i, reason: 'duplicate' });
      return;
    }
    urls.push(url);
  });
  return { urls, dropped };
}

/**
 * Composes the ordered endpoints into one transport. `transportFactory` is
 * injectable for tests only; production always uses viem's `http`.
 *
 * NOTE: `retryCount` is deliberately NOT set on the individual transports --
 * `http()` resolves `config.retryCount ?? injected`, so setting it here would
 * override the `0` that `fallback` injects and multiply the attempts per pass.
 */
export function buildRpcTransport(
  urls: readonly string[],
  options: { transportFactory?: (url: string) => Transport; timeoutMs?: number; passRetries?: number } = {},
): Transport {
  if (urls.length === 0) throw new Error('cannot build an RPC transport with no endpoints');
  const timeout = options.timeoutMs ?? RPC_REQUEST_TIMEOUT_MS;
  const factory = options.transportFactory ?? ((url: string) => http(url, { timeout }));
  return fallback(
    urls.map((url) => factory(url)),
    { rank: false, retryCount: options.passRetries ?? RPC_PASS_RETRIES, retryDelay: RPC_PASS_RETRY_DELAY_MS },
  );
}
