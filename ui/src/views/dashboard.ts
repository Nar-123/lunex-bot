import { escapeHtml, formatUsdgRaw } from '../format.js';

export interface StatusResponse {
  paused: boolean;
  capital: { freeUsdgBalance: string; totalDeployedUsdg: string; activePositionsCount: number; exposurePct: number };
  positions: { active: number; opening: number; closing: number };
}

/** Pure: data in, HTML string out -- unit-testable without a DOM. */
export function renderDashboard(s: StatusResponse): string {
  return `
    <section class="dashboard">
      <div class="status-badge ${s.paused ? 'paused' : 'running'}">${s.paused ? 'PAUSED' : 'RUNNING'}</div>
      <div class="stat-grid">
        <div class="stat"><span class="stat-label">Active</span><span class="stat-value">${s.positions.active}</span></div>
        <div class="stat"><span class="stat-label">Opening</span><span class="stat-value">${s.positions.opening}</span></div>
        <div class="stat"><span class="stat-label">Closing</span><span class="stat-value">${s.positions.closing}</span></div>
      </div>
      <div class="stat-grid">
        <div class="stat"><span class="stat-label">Free USDG</span><span class="stat-value">${escapeHtml(formatUsdgRaw(s.capital.freeUsdgBalance))}</span></div>
        <div class="stat"><span class="stat-label">Deployed USDG</span><span class="stat-value">${escapeHtml(formatUsdgRaw(s.capital.totalDeployedUsdg))}</span></div>
        <div class="stat"><span class="stat-label">Exposure</span><span class="stat-value">${s.capital.exposurePct.toFixed(1)}%</span></div>
      </div>
    </section>
  `;
}
