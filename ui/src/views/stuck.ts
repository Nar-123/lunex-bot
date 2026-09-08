import { escapeHtml } from '../format.js';

export interface StuckResponse {
  stuckTransactionAttempts: Array<{ id: string; idempotencyKey: string; purpose: string; status: string; attemptCount: number; firstAttemptedAt: string | null }>;
  stuckSwapRetryPositionIds: string[];
}

/** Pure: data in, HTML string out. Rendered prominently -- this is an attention signal, per explicit requirement. */
export function renderStuck(r: StuckResponse): string {
  const nothingStuck = r.stuckTransactionAttempts.length === 0 && r.stuckSwapRetryPositionIds.length === 0;
  if (nothingStuck) return '<p class="empty ok">Tidak ada yang stuck.</p>';

  const attemptRows = r.stuckTransactionAttempts
    .map(
      (a) => `
        <tr class="stuck-row">
          <td>${escapeHtml(a.idempotencyKey)}</td>
          <td>${escapeHtml(a.purpose)}</td>
          <td>${escapeHtml(a.status)}</td>
          <td>${a.attemptCount}x</td>
        </tr>`,
    )
    .join('');

  const swapRows = r.stuckSwapRetryPositionIds.map((id) => `<tr class="stuck-row"><td colspan="4">Swap retry stuck: position ${escapeHtml(id)}</td></tr>`).join('');

  return `
    <div class="alert-banner">⚠ Perhatian: ada transaksi/posisi yang stuck</div>
    <table class="data-table">
      <thead><tr><th>Idempotency Key</th><th>Purpose</th><th>Status</th><th>Attempts</th></tr></thead>
      <tbody>${attemptRows}${swapRows}</tbody>
    </table>
  `;
}
