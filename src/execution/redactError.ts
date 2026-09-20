import { config } from '../config';

/**
 * Secret-safe rendering of error text for logs and the database.
 *
 * viem error messages have this layout (verified against viem 2.56.3):
 *
 *   <shortMessage>
 *
 *   URL: <rpc url -- the provider API key lives in its path>
 *   Request body: <JSON-RPC request -- for a broadcast, the SIGNED RAW TX>
 *
 *   Details: <the provider's own error text>
 *   Version: viem@x.y.z
 *
 * The previous implementation cut everything from "Request body:" to the end,
 * which also discarded "Details:" -- the only line naming the real cause (e.g.
 * "max fee per gas less than block base fee ... maxFeePerGas: N, baseFee: M").
 * Now only the request body itself is removed; Details survives, while every
 * secret class stays redacted:
 *  - RPC / any URL path+query (host kept)       - request body
 *  - Authorization / Bearer / token headers      - JWTs
 *  - signed raw transactions / signatures (long hex)
 *  - private-key-labelled 32-byte hex
 *  - the exact configured secret values (private key, admin password, JWT
 *    secret, API keys, Telegram bot token, RPC URLs)
 */

const REDACTED = '<redacted>';
/** Values shorter than this are never treated as secrets (an empty/tiny value would redact ordinary text). */
const MIN_SECRET_LENGTH = 8;

function escapeRegExp(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function urlSecretPart(u: string): string {
  try {
    const url = new URL(u);
    return `${url.username}${url.password ? `:${url.password}` : ''}${url.pathname === '/' ? '' : url.pathname}${url.search}`;
  } catch {
    return u; // unparseable: treat the whole value as secret
  }
}

/** Exact configured secret values; empty/short values are ignored (they would redact ordinary text). */
export function configuredSecrets(): string[] {
  const values = [
    config.executorPrivateKey,
    config.auth.adminPassword,
    config.auth.jwtSecret,
    config.gmgn.apiKey,
    config.uniswapTradingApi.apiKey,
    config.telegram.botToken,
    // RPC URLs: only the path+query carries the provider key -- the host stays
    // readable (rule 3 below also strips any URL path generically).
    ...[config.chain.rpcUrl, ...config.chain.rpcFallbackUrls].map(urlSecretPart),
  ];
  const out = new Set<string>();
  for (const v of values) {
    if (typeof v !== 'string' || v.length < MIN_SECRET_LENGTH) continue;
    out.add(v);
    if (/^0x[0-9a-fA-F]+$/.test(v)) out.add(v.slice(2)); // also without the 0x prefix
  }
  return [...out].sort((a, b) => b.length - a.length);
}

export function redactSecrets(text: string, secrets: readonly string[] = configuredSecrets()): string {
  let out = text;
  // 1. the JSON-RPC request body, up to (not including) the Details/Version lines
  out = out.replace(/Request body:[\s\S]*?(?=\s(?:Details|Version):|$)/g, `Request body: ${REDACTED}`);
  // 2. URLs: keep scheme+host only (removes any key-bearing path/query)
  out = out.replace(/\b((?:https?|wss?):\/\/[^/\s"'`?#]+)[^\s"'`]*/gi, `$1/${REDACTED}`);
  // 3. exact configured secret values wherever else they appear
  for (const s of secrets) if (s.length >= MIN_SECRET_LENGTH) out = out.replace(new RegExp(escapeRegExp(s), 'g'), REDACTED);
  // 4. credentials in header-like / key-value form
  out = out.replace(/\b(authorization|proxy-authorization|x-api-key|api[-_]?key|cookie)(\s*["']?\s*[:=]\s*["']?)(?:bearer\s+|basic\s+)?[^\s"',;}]+/gi, `$1$2${REDACTED}`);
  out = out.replace(/\bbearer\s+[A-Za-z0-9._~+/=-]+/gi, `Bearer ${REDACTED}`);
  // 5. JWTs anywhere
  out = out.replace(/\beyJ[A-Za-z0-9_-]{5,}\.[A-Za-z0-9_-]{5,}\.[A-Za-z0-9_-]+/g, '<redacted-jwt>');
  // 6. private-key-labelled 32-byte hex (tx hashes, which share the shape, stay readable)
  out = out.replace(/\b(private[\s_-]?key|privkey|secret)(\s*["']?\s*[:=]?\s*["']?)(0x)?[0-9a-fA-F]{64}\b/gi, `$1$2${REDACTED}`);
  // 7. signed raw transactions / signatures / calldata blobs
  out = out.replace(/0x[0-9a-fA-F]{130,}/g, (m) => `0x<redacted ${(m.length - 2) / 2} bytes>`);
  return out;
}
