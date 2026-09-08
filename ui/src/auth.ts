/**
 * JWT storage -- `sessionStorage`, deliberately not `localStorage` or a
 * pure in-memory variable. Reasoning (see README's Module 12 section for
 * the full write-up): with no `/auth/refresh` endpoint and a 15-minute
 * `JWT_EXPIRY`, `localStorage`'s long-term persistence buys nothing (the
 * operator must fully re-authenticate every 15 minutes regardless), and
 * in-memory-only forces a full re-login on every accidental page reload
 * for no real security gain (any XSS payload running in the page can
 * read a JS variable exactly as easily as `sessionStorage`).
 * `sessionStorage` is the sweet spot: gone the moment the tab closes, but
 * survives a reload within the same session.
 */

import type { TokenStore } from './apiClient.js';

const TOKEN_KEY = 'lunex_ui_token';

export function getToken(): string | null {
  return sessionStorage.getItem(TOKEN_KEY);
}

export function setToken(token: string): void {
  sessionStorage.setItem(TOKEN_KEY, token);
}

export function clearToken(): void {
  sessionStorage.removeItem(TOKEN_KEY);
}

export function isLoggedIn(): boolean {
  return getToken() !== null;
}

/** The real `TokenStore` (Decision 3) `ApiClient` is constructed with in the actual app (`app.ts`) -- tests inject their own in-memory fake instead. */
export function sessionTokenStore(): TokenStore {
  return { get: getToken, set: setToken, clear: clearToken };
}
