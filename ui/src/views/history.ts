import { escapeHtml, formatUsdgRaw, formatDate } from '../format.js';

export interface ClosedPosition {
  id: string;
  tokenAddress: string;
  tokenSymbol: string;
  entryUsdgRaw: string;
  closedAt: string | null;
  closeReason: string | null;
  realizedPnlAvailable: boolean;
  /** Present only when realizedPnlAvailable is true -- raw-unit decimal strings, formatted for display only. */
  realizedPnlUsdgRaw?: string;
  realizedUsdgRaw?: string;
}
export interface ClosedPositionsResponse {
  positions: ClosedPosition[];
}

/** PnL cell: a sign-prefixed formatted amount when measured, an honest dash when not -- never a fabricated number. */
function renderPnlCell(p: ClosedPosition): string {
  if (!p.realizedPnlAvailable || p.realizedPnlUsdgRaw === undefined) return '<td>-</td>';
  try {
    const value = BigInt(p.realizedPnlUsdgRaw);
    const sign = value < 0n ? '-' : '+';
    return `<td class="mono">${sign}${escapeHtml(formatUsdgRaw((value < 0n ? -value : value).toString()))}</td>`;
  } catch {
    return '<td>-</td>';
  }
}

/**
 * Pure: data in, HTML string out. VALIDATION PHASE: now displays the
 * MEASURED realized PnL (exit receipts minus entry) when the server
 * reports it; positions the exit could not measure honestly show '-'.
 * The number is exactly what the server persisted from confirmed
 * receipts -- no client-side estimation anywhere.
 */
export function renderHistory(r: ClosedPositionsResponse): string {
  if (r.positions.length === 0) return '<p class="empty">Belum ada posisi yang closed.</p>';

  const rows = r.positions
    .map(
      (p) => `
        <tr>
          <td>${escapeHtml(p.tokenSymbol)}</td>
          <td class="mono">${escapeHtml(p.tokenAddress)}</td>
          <td>${escapeHtml(formatUsdgRaw(p.entryUsdgRaw))}</td>
          ${renderPnlCell(p)}
          <td>${escapeHtml(formatDate(p.closedAt))}</td>
          <td>${escapeHtml(p.closeReason ?? '-')}</td>
        </tr>`,
    )
    .join('');

  const note = r.positions.some((p) => p.realizedPnlAvailable)
    ? '<p class="note">PNL realized = hasil exit di chain (receipt terkonfirmasi) dikurangi entry. "-" = tidak terukur.</p>'
    : '<p class="note">PNL/fee realized belum tersedia -- lihat catatan Module 11/12 di README.</p>';

  return `
    ${note}
    <table class="data-table">
      <thead><tr><th>Token</th><th>Address</th><th>Entry</th><th>PNL Realized</th><th>Closed At</th><th>Reason</th></tr></thead>
      <tbody>${rows}</tbody>
    </table>
  `;
}
