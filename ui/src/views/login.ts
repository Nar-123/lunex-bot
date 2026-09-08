import { escapeHtml } from '../format.js';

/** Pure: error string in (or none), HTML string out. */
export function renderLogin(error?: string): string {
  return `
    <form id="login-form" class="login-form">
      <h1>Lunex Bot</h1>
      ${error ? `<p class="field-error">${escapeHtml(error)}</p>` : ''}
      <label>Username <input type="text" name="username" autocomplete="username" required /></label>
      <label>Password <input type="password" name="password" autocomplete="current-password" required /></label>
      <button type="submit">Login</button>
    </form>
  `;
}
