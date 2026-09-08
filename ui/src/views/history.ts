import { escapeHtml, formatUsdgRaw, formatDate } from '../format.js';

export interface ClosedPosition {
  id: string;
  tokenAddress: string;
  tokenSymbol: string;
  entryUsdgRaw: string;
  closedAt: string | null;
  closeReason: string | null;
  realizedPnlAvailable: false;
}
export interface ClosedPositionsResponse {
  positions: ClosedPosition[];
}

/**
 * Pure: data in, HTML string out. Deliberately shows entry size / close
 * time / close reason ONLY -- never computes or displays a PNL/fee
 * number. That data genuinely isn't persisted server-side yet (flagged as
 * an open TODO since Module 11 -- see README's Module 11/12 sections);
 * estimating it here would risk silently showing a wrong number, exactly
 * what this project's numeric-proof discipline exists to prevent.
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
          <td>${escapeHtml(formatDate(p.closedAt))}</td>
          <td>${escapeHtml(p.closeReason ?? '-')}</td>
        </tr>`,
    )
    .join('');

  return `
    <p class="note">PNL/fee realized belum tersedia -- lihat catatan Module 11/12 di README.</p>
    <table class="data-table">
      <thead><tr><th>Token</th><th>Address</th><th>Entry</th><th>Closed At</th><th>Reason</th></tr></thead>
      <tbody>${rows}</tbody>
    </table>
  `;
}
