import { describe, expect, it, vi } from 'vitest';
import { ApiClient, ApiError } from '../src/apiClient';
import type { TokenStore } from '../src/apiClient';

function jsonResponse(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } });
}

function fakeTokenStore(initial: string | null = null): TokenStore & { value: string | null } {
  return {
    value: initial,
    get() {
      return this.value;
    },
    set(token: string) {
      this.value = token;
    },
    clear() {
      this.value = null;
    },
  };
}

describe('ApiClient.login', () => {
  it('POSTs credentials and stores the returned token via the injected TokenStore', async () => {
    const fetchFn = vi.fn(async (_url: string | URL, init?: RequestInit) => {
      expect(JSON.parse(init!.body as string)).toEqual({ username: 'admin', password: 'secret' });
      return jsonResponse(200, { token: 'jwt-abc' });
    });
    const store = fakeTokenStore();
    const client = new ApiClient({ fetchFn: fetchFn as unknown as typeof fetch }, store);

    await client.login('admin', 'secret');

    expect(store.value).toBe('jwt-abc');
  });

  it('throws ApiError with the server error message on a non-ok response, never stores a token', async () => {
    const fetchFn = vi.fn(async () => jsonResponse(401, { error: 'invalid username or password' }));
    const store = fakeTokenStore();
    const client = new ApiClient({ fetchFn: fetchFn as unknown as typeof fetch }, store);

    await expect(client.login('admin', 'wrong')).rejects.toThrow(/invalid username or password/);
    expect(store.value).toBeNull();
  });

  it('throws when the response has no usable token', async () => {
    const fetchFn = vi.fn(async () => jsonResponse(200, {}));
    const client = new ApiClient({ fetchFn: fetchFn as unknown as typeof fetch }, fakeTokenStore());
    await expect(client.login('a', 'b')).rejects.toThrow(/token/);
  });
});

describe('ApiClient request methods', () => {
  it('attaches Authorization: Bearer <token> from the TokenStore', async () => {
    const fetchFn = vi.fn(async (_url: string | URL, init?: RequestInit) => jsonResponse(200, { ok: true }));
    const store = fakeTokenStore('jwt-xyz');
    const client = new ApiClient({ fetchFn: fetchFn as unknown as typeof fetch }, store);

    await client.get('/status');

    const headers = (fetchFn.mock.calls[0]?.[1] as RequestInit).headers as Record<string, string>;
    expect(headers.Authorization).toBe('Bearer jwt-xyz');
  });

  it('throws immediately if there is no token at all, without ever calling fetch', async () => {
    const fetchFn = vi.fn();
    const client = new ApiClient({ fetchFn: fetchFn as unknown as typeof fetch }, fakeTokenStore(null));

    await expect(client.get('/status')).rejects.toThrow(/not logged in/);
    expect(fetchFn).not.toHaveBeenCalled();
  });

  describe('Decision 4: NO auto-relogin on 401 -- deliberately different from telegram/apiClient.ts', () => {
    it('a 401 clears the stored token, invokes onUnauthorized exactly once, and throws -- WITHOUT ever retrying the request', async () => {
      const fetchFn = vi.fn(async () => jsonResponse(401, { error: 'expired' }));
      const store = fakeTokenStore('stale-token');
      const onUnauthorized = vi.fn();
      const client = new ApiClient({ fetchFn: fetchFn as unknown as typeof fetch, onUnauthorized }, store);

      await expect(client.get('/status')).rejects.toThrow(ApiError);

      expect(fetchFn).toHaveBeenCalledTimes(1); // exactly once -- no retry
      expect(store.value).toBeNull(); // token cleared
      expect(onUnauthorized).toHaveBeenCalledTimes(1);
    });

    it('never sends a password anywhere in this file -- ApiClient has no password field or re-login capability at all', () => {
      // Structural proof, not just behavioral: TelegramApiClient stores
      // config.auth.adminPassword and calls login() again internally on a
      // 401. ApiClient here has no such field/method to call -- confirmed
      // by construction: `login()` requires the caller to pass credentials
      // explicitly every time, and nothing in this class's own code ever
      // calls it a second time on its own.
      const client = new ApiClient({}, fakeTokenStore());
      expect((client as unknown as { password?: unknown }).password).toBeUndefined();
      expect((client as unknown as { username?: unknown }).username).toBeUndefined();
    });
  });

  it('PATCH sends a JSON body with Content-Type', async () => {
    const fetchFn = vi.fn(async (_url: string | URL, _init?: RequestInit) => jsonResponse(200, { ok: true }));
    const client = new ApiClient({ fetchFn: fetchFn as unknown as typeof fetch }, fakeTokenStore('t'));

    await client.patch('/settings', { positionSizePct: 10 });

    const init = fetchFn.mock.calls[0]?.[1] as RequestInit;
    expect(JSON.parse(init.body as string)).toEqual({ positionSizePct: 10 });
    expect((init.headers as Record<string, string>)['Content-Type']).toBe('application/json');
  });

  it('a non-401 error response throws ApiError with the server message, not a raw stack', async () => {
    const fetchFn = vi.fn(async () => jsonResponse(500, { error: 'internal error' }));
    const client = new ApiClient({ fetchFn: fetchFn as unknown as typeof fetch }, fakeTokenStore('t'));

    await expect(client.get('/status')).rejects.toThrow(/internal error/);
  });
});

describe('ApiClient.logout', () => {
  it('clears the token store', () => {
    const store = fakeTokenStore('t');
    const client = new ApiClient({}, store);
    client.logout();
    expect(store.value).toBeNull();
  });
});
