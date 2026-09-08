import { escapeHtml } from '../format.js';

export interface SettingsResponse {
  paused: boolean;
  positionSizePct: number;
  maxActivePositions: number;
  hardStopLossPct: number;
  trailingTpTriggerPct: number;
  /** Read-only, frozen server threshold -- never settable here. See Decision 5, Module 12. */
  pnlProtectionTriggerPct: number;
  updatedAt: string;
}

/**
 * Pure: data in, HTML string out. All four editable fields pre-filled
 * with the CURRENT server values (Decision 5 -- the gap this whole view
 * exists to close: Module 10 only ever built the write side). The frozen
 * `pnlProtectionTriggerPct` is embedded as a `data-` attribute so the
 * (impure, DOM-wiring) controller can read it for client-side validation
 * without a second fetch or a hardcoded copy.
 */
export function renderSettingsForm(s: SettingsResponse): string {
  return `
    <form id="settings-form" data-pnl-protection-trigger-pct="${s.pnlProtectionTriggerPct}">
      <p class="note">Nilai saat ini (per ${escapeHtml(new Date(s.updatedAt).toLocaleString())}). PNL Protection aktif otomatis di ${s.pnlProtectionTriggerPct}% (beku, tidak bisa diubah di sini).</p>

      <label>
        Position size (% dari free balance)
        <input type="number" step="0.01" name="positionSizePct" value="${s.positionSizePct}" />
        <span class="field-error" data-error-for="positionSizePct"></span>
      </label>

      <label>
        Max active positions
        <input type="number" step="1" name="maxActivePositions" value="${s.maxActivePositions}" />
        <span class="field-error" data-error-for="maxActivePositions"></span>
      </label>

      <label>
        Hard stop loss (%)
        <input type="number" step="0.01" name="hardStopLossPct" value="${s.hardStopLossPct}" />
        <span class="field-error" data-error-for="hardStopLossPct"></span>
      </label>

      <label>
        Trailing TP trigger (%)
        <input type="number" step="0.01" name="trailingTpTriggerPct" value="${s.trailingTpTriggerPct}" />
        <span class="field-error" data-error-for="trailingTpTriggerPct"></span>
      </label>

      <button type="submit">Simpan</button>
      <span id="settings-form-status"></span>
    </form>
  `;
}
