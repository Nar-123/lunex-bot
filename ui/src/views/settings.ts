import { escapeHtml } from '../format.js';

export interface SettingsResponse {
  paused: boolean;
  positionSizePct: number;
  maxActivePositions: number;
  hardStopLossPct: number;
  trailingTpTriggerPct: number;
  /**
   * Read-only, frozen server threshold -- never settable here. Renamed
   * from `pnlProtectionTriggerPct` in TIER 3: this is the drawdown at
   * which the Meridian-aligned Safety Exit ARMS (it then closes on a
   * recovery back to breakeven). Displayed for context only; TIER 3
   * removed the cross-field validation it used to feed.
   */
  safetyExitTriggerPct: number;
  updatedAt: string;
}

/**
 * Pure: data in, HTML string out. All four editable fields pre-filled
 * with the CURRENT server values (Decision 5 -- the gap this whole view
 * exists to close: Module 10 only ever built the write side). The frozen
 * `safetyExitTriggerPct` is shown read-only for context; TIER 3 dropped
 * the `data-` attribute that used to carry it into client-side
 * cross-field validation, because that rule no longer exists on either
 * side.
 */
export function renderSettingsForm(s: SettingsResponse): string {
  return `
    <form id="settings-form">
      <p class="note">Nilai saat ini (per ${escapeHtml(new Date(s.updatedAt).toLocaleString())}). Safety Exit arming otomatis di ${s.safetyExitTriggerPct}% max drawdown (beku, tidak bisa diubah di sini).</p>

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
