/**
 * The ONLY file in `ui/` that makes an HTTP call -- every view goes
 * through this, never `fetch` directly. Same loopback/same-origin
 * boundary discipline as `telegram/apiClient.ts`: `ui/` never imports
 * `positions/`/`capital/`/etc., only ever talks to `api/` over HTTP.
 *
 * Deliberately NOT `telegram/apiClient.ts`'s auto-relogin pattern
 * (Decision 4, Module 12): there is a real operator at the keyboard here,
 * so a plaintext password must never exist in browser code/storage in any
 * form. On a `401`, the stored token is cleared and `onUnauthorized` is
 * invoked so the app shell can show the login screen -- no retry, no
 * auto-anything.
 *
 * `fetchFn` and `tokenStore` are both injectable (constructor options,
 * defaulting to the real `fetch`/`sessionStorage`-backed
 * implementations) -- same dependency-inversion discipline used
 * throughout this project (e.g. `TelegramApiClient`) -- so this file's
 * actual request/401 logic is fully unit-testable in plain Node, with no
 * DOM/jsdom needed at all.
 */

export interface TokenStore {
  get(): string | null;
  set(token: string): void;
  clear(): void;
}

export class ApiError extends Error {
  constructor(
    message: string,
    public readonly status?: number,
  ) {
    super(message);
    this.name = 'ApiError';
  }
}

export interface ApiClientOptions {
  baseUrl?: string;
  fetchFn?: typeof fetch;
  tokenStore?: TokenStore;
  /** Called exactly once per 401 response, after the stored token has already been cleared. */
  onUnauthorized?: () => void;
}

export class ApiClient {
  private readonly baseUrl: string;
  private readonly fetchFn: typeof fetch;
  private readonly tokenStore: TokenStore;
  private readonly onUnauthorized: () => void;

  constructor(options: ApiClientOptions = {}, tokenStore: TokenStore) {
    this.baseUrl = options.baseUrl ?? '';
    // `.bind(globalThis)` is required, not stylistic -- verified live in a
    // real browser (this exact bug shipped once and was caught by manual
    // testing before this module was considered done): native browser
    // `fetch` enforces that it's invoked with `window`/`globalThis` as its
    // receiver. Assigning the bare function to `this.fetchFn` and later
    // calling `this.fetchFn(...)` invokes it with the `ApiClient` instance
    // as `this` instead, which throws `TypeError: Failed to execute
    // 'fetch' on 'Window': Illegal invocation`. Node's `fetch` happens not
    // to enforce this (which is why the identical pattern in
    // `telegram/apiClient.ts` never surfaced it), but relying on that
    // leniency would be an accident, not a guarantee.
    this.fetchFn = options.fetchFn ?? fetch.bind(globalThis);
    this.tokenStore = tokenStore;
    this.onUnauthorized = options.onUnauthorized ?? (() => undefined);
  }

  async login(username: string, password: string): Promise<void> {
    const res = await this.fetchFn(`${this.baseUrl}/auth/login`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ username, password }),
    });
    if (!res.ok) {
      const body = await res.json().catch(() => ({}));
      throw new ApiError((body as { error?: string }).error ?? `login failed: HTTP ${res.status}`, res.status);
    }
    const body = (await res.json()) as { token?: unknown };
    if (typeof body.token !== 'string' || body.token.length === 0) {
      throw new ApiError('login response did not include a token');
    }
    this.tokenStore.set(body.token);
  }

  logout(): void {
    this.tokenStore.clear();
  }

  private async request<T>(method: 'GET' | 'POST' | 'PATCH', path: string, body?: unknown): Promise<T> {
    const token = this.tokenStore.get();
    if (!token) {
      throw new ApiError('not logged in');
    }
    const res = await this.fetchFn(`${this.baseUrl}${path}`, {
      method,
      headers: {
        Authorization: `Bearer ${token}`,
        ...(body !== undefined ? { 'Content-Type': 'application/json' } : {}),
      },
      ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
    });

    if (res.status === 401) {
      // No retry, no auto-relogin -- Decision 4. Clear the stale token
      // and hand control to the app shell to show the login screen.
      this.tokenStore.clear();
      this.onUnauthorized();
      throw new ApiError('session expired', 401);
    }
    if (!res.ok) {
      const errBody = await res.json().catch(() => ({}));
      throw new ApiError((errBody as { error?: string }).error ?? `${method} ${path} failed: HTTP ${res.status}`, res.status);
    }
    return (await res.json()) as T;
  }

  get<T>(path: string): Promise<T> {
    return this.request<T>('GET', path);
  }

  post<T>(path: string, body?: unknown): Promise<T> {
    return this.request<T>('POST', path, body);
  }

  patch<T>(path: string, body?: unknown): Promise<T> {
    return this.request<T>('PATCH', path, body);
  }
}
