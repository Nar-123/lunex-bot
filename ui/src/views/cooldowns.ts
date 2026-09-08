import { escapeHtml, formatMs } from '../format.js';

export interface CooldownsResponse {
  cooldowns: Array<{ tokenAddress: string; remainingMs: number; cooldownEndsAt: number }>;
}

/** Pure: data in, HTML string out. */
export function renderCooldowns(r: CooldownsResponse): string {
  if (r.cooldowns.length === 0) return '<p class="empty">Tidak ada token dalam cooldown.</p>';

  const rows = r.cooldowns
    .map((c) => `<tr><td class="mono">${escapeHtml(c.tokenAddress)}</td><td>${formatMs(c.remainingMs)}</td></tr>`)
    .join('');

  return `
    <table class="data-table">
      <thead><tr><th>Token</th><th>Remaining</th></tr></thead>
      <tbody>${rows}</tbody>
    </table>
  `;
}
