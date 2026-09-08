/** Shared, pure formatting/escaping helpers used by every view's render function. */

/** Every piece of server-sourced text (token symbols, close reasons, log content) is escaped before going into an HTML string -- GMGN-sourced token data and log content are not trusted input. */
export function escapeHtml(value: unknown): string {
  return String(value)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

/**
 * USDG raw-unit decimal string (e.g. `entryUsdgRaw`) formatted as human
 * units. Assumes 18 decimals -- the project-wide default
 * (`USDG_DECIMALS` in `config/env.ts`) and the only value ever actually
 * used in this codebase's examples/fixtures; the API does not currently
 * expose the configured decimals count for display purposes, so this is
 * a disclosed display-only assumption, not a financial computation.
 */
export function formatUsdgRaw(raw: string): string {
  try {
    const value = BigInt(raw);
    const whole = value / 10n ** 18n;
    const frac = value % 10n ** 18n;
    const fracStr = frac.toString().padStart(18, '0').slice(0, 2);
    return `${whole.toString()}.${fracStr} USDG`;
  } catch {
    return `${raw} (raw)`;
  }
}

export function formatPct(value: number): string {
  return `${value >= 0 ? '+' : ''}${value.toFixed(2)}%`;
}

export function formatDate(value: string | null | undefined): string {
  if (!value) return '-';
  const d = new Date(value);
  return Number.isNaN(d.getTime()) ? String(value) : d.toLocaleString();
}

export function formatMs(ms: number): string {
  if (ms < 60_000) return `${Math.ceil(ms / 1000)}s`;
  if (ms < 3_600_000) return `${Math.ceil(ms / 60_000)}m`;
  return `${Math.ceil(ms / 3_600_000)}h`;
}
