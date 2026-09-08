import { escapeHtml } from '../format.js';

export interface LogLine {
  ts?: string;
  level?: string;
  event?: string;
  [key: string]: unknown;
}
export interface LogsResponse {
  lines: LogLine[];
}

/** Pure: data in, HTML string out. Manual refresh only (Decision 6) -- no auto-poll, so no "last updated" staleness concern to render. */
export function renderLogs(r: LogsResponse): string {
  if (r.lines.length === 0) return '<p class="empty">Belum ada log.</p>';

  const rows = r.lines
    .slice()
    .reverse() // newest first
    .map((l) => {
      const { ts, level, event, ...rest } = l;
      const extra = Object.keys(rest).length > 0 ? escapeHtml(JSON.stringify(rest)) : '';
      return `
        <tr class="log-row log-${escapeHtml(level ?? 'info')}">
          <td class="mono">${escapeHtml(ts ?? '?')}</td>
          <td>${escapeHtml(level ?? '?')}</td>
          <td>${escapeHtml(event ?? '?')}</td>
          <td class="mono log-extra">${extra}</td>
        </tr>`;
    })
    .join('');

  return `
    <table class="data-table">
      <thead><tr><th>Time</th><th>Level</th><th>Event</th><th>Data</th></tr></thead>
      <tbody>${rows}</tbody>
    </table>
  `;
}
