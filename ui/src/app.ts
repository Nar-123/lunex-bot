import { ApiClient, ApiError } from './apiClient.js';
import { sessionTokenStore, isLoggedIn } from './auth.js';
import { renderLogin } from './views/login.js';
import { renderDashboard } from './views/dashboard.js';
import type { StatusResponse } from './views/dashboard.js';
import { renderPositions } from './views/positions.js';
import type { PositionsResponse } from './views/positions.js';
import { renderStuck } from './views/stuck.js';
import type { StuckResponse } from './views/stuck.js';
import { renderCooldowns } from './views/cooldowns.js';
import type { CooldownsResponse } from './views/cooldowns.js';
import { renderLogs } from './views/logs.js';
import type { LogsResponse } from './views/logs.js';
import { renderHistory } from './views/history.js';
import type { ClosedPositionsResponse } from './views/history.js';
import { renderSettingsForm } from './views/settings.js';
import type { SettingsResponse } from './views/settings.js';
import {
  validatePositionSizePct,
  validateMaxActivePositions,
  validateHardStopLossPct,
  validateTrailingTpTriggerPct,
} from './validators.js';

const loginScreen = document.getElementById('login-screen') as HTMLDivElement;
const appShell = document.getElementById('app-shell') as HTMLDivElement;
const viewContainer = document.getElementById('view-container') as HTMLElement;
const mainNav = document.getElementById('main-nav') as HTMLElement;
const pauseBtn = document.getElementById('pause-btn') as HTMLButtonElement;
const resumeBtn = document.getElementById('resume-btn') as HTMLButtonElement;
const logoutBtn = document.getElementById('logout-btn') as HTMLButtonElement;

let apiClient: ApiClient;
let activePollTimer: ReturnType<typeof setInterval> | null = null;

function stopPolling(): void {
  if (activePollTimer !== null) {
    clearInterval(activePollTimer);
    activePollTimer = null;
  }
}

function showLogin(error?: string): void {
  stopPolling();
  appShell.hidden = true;
  loginScreen.hidden = false;
  loginScreen.innerHTML = renderLogin(error);
  const form = document.getElementById('login-form') as HTMLFormElement;
  form.addEventListener('submit', async (e) => {
    e.preventDefault();
    const data = new FormData(form);
    try {
      await apiClient.login(String(data.get('username')), String(data.get('password')));
      showApp();
    } catch (err) {
      showLogin(err instanceof ApiError ? err.message : 'Login gagal, coba lagi.');
    }
  });
}

function showApp(): void {
  loginScreen.hidden = true;
  appShell.hidden = false;
  loadView('dashboard');
}

// ---- Per-view loaders: fetch (via apiClient) + mount the pure render output. Polling intervals per Decision 6. ----

async function loadDashboard(): Promise<void> {
  const s = await apiClient.get<StatusResponse>('/status');
  viewContainer.innerHTML = renderDashboard(s);
}

async function loadPositions(): Promise<void> {
  const r = await apiClient.get<PositionsResponse>('/positions');
  viewContainer.innerHTML = renderPositions(r);
}

async function loadStuck(): Promise<void> {
  const r = await apiClient.get<StuckResponse>('/positions/stuck');
  viewContainer.innerHTML = renderStuck(r);
}

async function loadCooldowns(): Promise<void> {
  const r = await apiClient.get<CooldownsResponse>('/cooldowns');
  viewContainer.innerHTML = renderCooldowns(r);
}

async function loadLogs(): Promise<void> {
  const r = await apiClient.get<LogsResponse>('/logs');
  viewContainer.innerHTML = `<div class="refresh-row"><button id="logs-refresh" type="button">Refresh</button></div>${renderLogs(r)}`;
  document.getElementById('logs-refresh')?.addEventListener('click', () => void safeLoad(loadLogs));
}

async function loadHistory(): Promise<void> {
  const r = await apiClient.get<ClosedPositionsResponse>('/positions?status=closed');
  viewContainer.innerHTML = `<div class="refresh-row"><button id="history-refresh" type="button">Refresh</button></div>${renderHistory(r)}`;
  document.getElementById('history-refresh')?.addEventListener('click', () => void safeLoad(loadHistory));
}

async function loadSettings(): Promise<void> {
  const s = await apiClient.get<SettingsResponse>('/settings');
  viewContainer.innerHTML = renderSettingsForm(s);
  wireSettingsForm();
}

function wireSettingsForm(): void {
  const form = document.getElementById('settings-form') as HTMLFormElement;

  const fieldValidators: Record<string, (value: number) => { valid: boolean; error?: string }> = {
    positionSizePct: validatePositionSizePct,
    maxActivePositions: validateMaxActivePositions,
    hardStopLossPct: validateHardStopLossPct,
    trailingTpTriggerPct: validateTrailingTpTriggerPct,
  };

  function validateField(name: string): boolean {
    const input = form.elements.namedItem(name) as HTMLInputElement | null;
    const errorEl = form.querySelector(`[data-error-for="${name}"]`);
    if (!input || !errorEl) return true;
    const value = Number(input.value);
    // TIER 3: no cross-field rule any more -- per-field bounds only, the
    // same set the server still enforces.
    const result = fieldValidators[name]?.(value) ?? { valid: true };
    errorEl.textContent = result.valid ? '' : (result.error ?? '');
    return result.valid;
  }

  for (const name of Object.keys(fieldValidators)) {
    (form.elements.namedItem(name) as HTMLInputElement | null)?.addEventListener('input', () => validateField(name));
  }

  form.addEventListener('submit', async (e) => {
    e.preventDefault();
    const allValid = Object.keys(fieldValidators).every((name) => validateField(name));
    const statusEl = document.getElementById('settings-form-status');
    if (!allValid) {
      if (statusEl) statusEl.textContent = 'Perbaiki field yang error dulu.';
      return;
    }
    const data = new FormData(form);
    const body = {
      positionSizePct: Number(data.get('positionSizePct')),
      maxActivePositions: Number(data.get('maxActivePositions')),
      hardStopLossPct: Number(data.get('hardStopLossPct')),
      trailingTpTriggerPct: Number(data.get('trailingTpTriggerPct')),
    };
    try {
      await apiClient.patch('/settings', body);
      // Reload FIRST, THEN set the success message -- `loadSettings()`
      // fully re-renders `#settings-form` (fresh, server-confirmed
      // values, not just the just-submitted ones), which replaces
      // `#settings-form-status` with a brand new, empty element. Setting
      // the message BEFORE the reload (verified live: an earlier version
      // did exactly this) means it's overwritten before ever being
      // visible -- the reload must finish first, then the NEW status
      // element gets the message.
      await loadSettings();
      const newStatusEl = document.getElementById('settings-form-status');
      if (newStatusEl) newStatusEl.textContent = 'Tersimpan.';
    } catch (err) {
      if (statusEl) statusEl.textContent = err instanceof ApiError ? err.message : 'Gagal menyimpan.';
    }
  });
}

interface ViewDef {
  load: () => Promise<void>;
  pollMs: number | null; // Decision 6 -- null means load-once/manual-refresh only
}

const views: Record<string, ViewDef> = {
  dashboard: { load: loadDashboard, pollMs: 15_000 },
  positions: { load: loadPositions, pollMs: 15_000 },
  stuck: { load: loadStuck, pollMs: 30_000 },
  cooldowns: { load: loadCooldowns, pollMs: 30_000 },
  logs: { load: loadLogs, pollMs: null },
  history: { load: loadHistory, pollMs: null },
  settings: { load: loadSettings, pollMs: null },
};

/**
 * Wraps every view's `load()` -- a bare `void view.load()` would leave an
 * unhandled promise rejection AND a permanently-blank view container on
 * any fetch failure (verified live: a real environment where `/status`
 * needs RPC access it doesn't have produced exactly this -- a blank
 * dashboard with no on-screen indication anything went wrong, console-only).
 * A `401` is already handled by `apiClient`'s own `onUnauthorized`
 * callback (clears the token, shows the login screen) -- this only needs
 * to cover every OTHER failure with a plain, non-raw-error message.
 */
async function safeLoad(load: () => Promise<void>): Promise<void> {
  try {
    await load();
  } catch (err) {
    if (err instanceof ApiError && err.status === 401) return; // already handled by onUnauthorized
    viewContainer.innerHTML = `<p class="field-error">Gagal memuat data, coba lagi.</p>`;
  }
}

function loadView(name: string): void {
  stopPolling();
  for (const btn of mainNav.querySelectorAll('button[data-view]')) {
    btn.classList.toggle('active', btn.getAttribute('data-view') === name);
  }
  const view = views[name];
  if (!view) return;
  void safeLoad(view.load);
  if (view.pollMs !== null) {
    activePollTimer = setInterval(() => void safeLoad(view.load), view.pollMs);
  }
}

mainNav.addEventListener('click', (e) => {
  const target = e.target as HTMLElement;
  const name = target.getAttribute('data-view');
  if (name) loadView(name);
});

pauseBtn.addEventListener('click', () => {
  if (!window.confirm('Yakin mau pause bot? Tidak ada deployment baru sampai di-resume.')) return;
  void apiClient.post('/control/pause').then(() => loadView('dashboard'));
});

resumeBtn.addEventListener('click', () => {
  if (!window.confirm('Yakin mau resume bot?')) return;
  void apiClient.post('/control/resume').then(() => loadView('dashboard'));
});

logoutBtn.addEventListener('click', () => {
  apiClient.logout();
  showLogin();
});

function main(): void {
  apiClient = new ApiClient({ onUnauthorized: () => showLogin('Sesi berakhir, silakan login lagi.') }, sessionTokenStore());
  if (isLoggedIn()) {
    showApp();
  } else {
    showLogin();
  }
}

main();
