/**
 * Secret masking applied to EVERY string that leaves the process: Telegram
 * messages, log lines, LLM prompts built from command output, reports.
 * Two layers: exact known values (taken from this process's own env) and
 * shape-based patterns for secrets the process never saw (e.g. a key a
 * developer pasted into a file the agent read).
 */
export const MASK = '***MASKED***';

const SECRET_ENV_NAME = /(TOKEN|SECRET|PASSWORD|PASSWD|PRIVATE|API_KEY|APIKEY|MNEMONIC|SEED|CREDENTIAL)/i;

/** Values of env vars whose NAME looks secret. Short values are skipped -- masking "true" everywhere would be noise, not safety. */
export function collectSecretValues(env: NodeJS.ProcessEnv): string[] {
  const out: string[] = [];
  for (const [name, value] of Object.entries(env)) {
    if (value && value.length >= 8 && SECRET_ENV_NAME.test(name)) out.push(value);
  }
  return out;
}

function escapeRegExp(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

const PATTERNS: readonly [RegExp, string][] = [
  [/-----BEGIN [A-Z ]*PRIVATE KEY-----[\s\S]*?-----END [A-Z ]*PRIVATE KEY-----/g, MASK],
  [/\b\d{6,12}:[A-Za-z0-9_-]{30,}\b/g, MASK], // Telegram bot token
  [/(Bearer\s+)[A-Za-z0-9._~+/=-]{12,}/gi, `$1${MASK}`],
  [/\b(?:sk|rk|pk)-[A-Za-z0-9_-]{16,}\b/g, MASK],
  [/\bgh[pousr]_[A-Za-z0-9]{36,}\b/g, MASK],
  [/\bAKIA[0-9A-Z]{16}\b/g, MASK],
  [/\$2[aby]\$\d{2}\$[./A-Za-z0-9]{53}/g, MASK], // bcrypt hash
  // 32-byte hex ONLY in a key-ish context -- tx hashes and pool ids must stay readable in diffs.
  [/((?:private|priv|secret|mnemonic|seed)[_\s-]?(?:key)?["']?\s*[:=]\s*["']?)0x[0-9a-fA-F]{64}/gi, `$1${MASK}`],
  // NAME=value / NAME: value for secret-looking names (env files, logs).
  [/\b([A-Z0-9_]*(?:PRIVATE_KEY|API_KEY|SECRET|TOKEN|PASSWORD|MNEMONIC)[A-Z0-9_]*)(\s*[=:]\s*)(["']?)([^\s"'`]{6,})\3/g, `$1$2$3${MASK}$3`],
];

export type Masker = (text: string) => string;

export function createMasker(secretValues: readonly string[]): Masker {
  const exact = [...new Set(secretValues.filter((v) => v.length >= 8))].sort((a, b) => b.length - a.length);
  const exactRe = exact.length > 0 ? new RegExp(exact.map(escapeRegExp).join('|'), 'g') : null;
  return (text: string): string => {
    let out = exactRe ? text.replace(exactRe, MASK) : text;
    for (const [re, replacement] of PATTERNS) out = out.replace(re, replacement);
    return out;
  };
}
