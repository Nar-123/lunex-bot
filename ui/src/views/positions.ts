import { escapeHtml, formatUsdgRaw, formatMs } from '../format.js';

export interface ActivePosition {
  id: string;
  tokenAddress: string;
  tokenSymbol: string;
  entryUsdgRaw: string;
  openedAt: string | null;
  metrics: { ok: true; pnlPct: number; yieldPct: number; inRange: boolean } | { ok: false; reason: string };
  oor: { outOfRange: boolean; elapsedMs: number; remainingMs: number };
}
export interface PositionsResponse {
  positions: ActivePosition[];
}

/** Pure: data in, HTML string out. */
export function renderPositions(r: PositionsResponse): string {
  if (r.positions.length === 0) return '<p class="empty">Tidak ada posisi aktif.</p>';

  const rows = r.positions
    .map((p) => {
      const metricsCell = p.metrics.ok
        ? `<span class="${p.metrics.pnlPct >= 0 ? 'positive' : 'negative'}">${(p.metrics.pnlPct * 100).toFixed(2)}%</span> / yield ${(p.metrics.yieldPct * 100).toFixed(2)}% / ${p.metrics.inRange ? 'in range' : '<span class="warn">OUT OF RANGE</span>'}`
        : `<span class="warn">metrics error: ${escapeHtml(p.metrics.reason)}</span>`;
      const oorCell = p.oor.outOfRange ? `<span class="warn">OOR ${formatMs(p.oor.elapsedMs)} (grace ${formatMs(p.oor.remainingMs)} left)</span>` : 'in range';
      return `
        <tr>
          <td>${escapeHtml(p.tokenSymbol)}</td>
          <td class="mono">${escapeHtml(p.tokenAddress)}</td>
          <td>${escapeHtml(formatUsdgRaw(p.entryUsdgRaw))}</td>
          <td>${metricsCell}</td>
          <td>${oorCell}</td>
        </tr>`;
    })
    .join('');

  return `
    <table class="data-table">
      <thead><tr><th>Token</th><th>Address</th><th>Entry</th><th>PNL / Yield / Range</th><th>OOR</th></tr></thead>
      <tbody>${rows}</tbody>
    </table>
  `;
}
