import { describe, expect, it, vi } from 'vitest';
import { TelegramApiClient, TelegramApiError } from '../../src/telegram/apiClient';

function jsonResponse(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } });
}

function makeClient(overrides: Partial<ConstructorParameters<typeof TelegramApiClient>[0]> = {}) {
  return new TelegramApiClient({
    baseUrl: 'http://localhost:9999',
    username: 'admin',
    password: 'secret',
    ...overrides,
  });
}

describe('TelegramApiClient.login', () => {
  it('POSTs credentials and stores the returned token', async () => {
    const fetchFn = vi.fn(async (_url: string | URL, init?: RequestInit) => {
      expect(JSON.parse(init!.body as string)).toEqual({ username: 'admin', password: 'secret' });
      return jsonResponse(200, { token: 'jwt-abc' });
    });
    const client = makeClient({ fetchFn: fetchFn as unknown as typeof fetch });

    await client.login();

    // Confirm the token is actually used on the next request.
    const fetchFn2 = vi.fn(async (_url: string | URL, _init?: RequestInit) => jsonResponse(200, { ok: true }));
    (client as unknown as { fetchFn: typeof fetch }).fetchFn = fetchFn2 as unknown as typeof fetch;
    await client.get('/status');
    const headers = (fetchFn2.mock.calls[0]?.[1] as RequestInit).headers as Record<string, string>;
    expect(headers.Authorization).toBe('Bearer jwt-abc');
  });

  it('throws TelegramApiError on a non-ok response', async () => {
    const fetchFn = vi.fn(async () => jsonResponse(401, { error: 'invalid credentials' }));
    const client = makeClient({ fetchFn: fetchFn as unknown as typeof fetch });

    await expect(client.login()).rejects.toThrow(TelegramApiError);
  });

  it('throws when the response has no usable token', async () => {
    const fetchFn = vi.fn(async () => jsonResponse(200, {}));
    const client = makeClient({ fetchFn: fetchFn as unknown as typeof fetch });

    await expect(client.login()).rejects.toThrow(/token/);
  });
});

describe('TelegramApiClient request methods -- 401 mid-request behavior', () => {
  it('on a 401, re-logs in exactly once and retries the SAME request exactly once, succeeding if the retry is ok', async () => {
    let call = 0;
    const fetchFn = vi.fn(async (url: string | URL) => {
      call++;
      const u = String(url);
      if (u.endsWith('/auth/login')) return jsonResponse(200, { token: `jwt-${call}` });
      if (call === 2) return jsonResponse(401, { error: 'expired' }); // first real request: expired token
      return jsonResponse(200, { positions: [] }); // the retried request
    });
    const client = makeClient({ fetchFn: fetchFn as unknown as typeof fetch });
    await client.login(); // call 1: login

    const result = await client.get<{ positions: unknown[] }>('/positions'); // call 2: 401, call 3: re-login, call 4: retry

    expect(result).toEqual({ positions: [] });
    expect(fetchFn).toHaveBeenCalledTimes(4);
  });

  it('a SECOND consecutive 401 (after the one re-login) surfaces as an error, not an infinite loop', async () => {
    const fetchFn = vi.fn(async (url: string | URL) => {
      const u = String(url);
      if (u.endsWith('/auth/login')) return jsonResponse(200, { token: 'jwt-x' });
      return jsonResponse(401, { error: 'still invalid' }); // every real request 401s
    });
    const client = makeClient({ fetchFn: fetchFn as unknown as typeof fetch });
    await client.login();

    await expect(client.get('/positions')).rejects.toThrow(TelegramApiError);
    // login (1) + first /positions 401 (2) + re-login (3) + retried /positions 401 (4) = 4 calls, never more.
    expect(fetchFn).toHaveBeenCalledTimes(4);
  });

  it('a re-login failure after a 401 propagates as an error rather than retrying forever', async () => {
    let loginCalls = 0;
    const fetchFn = vi.fn(async (url: string | URL) => {
      const u = String(url);
      if (u.endsWith('/auth/login')) {
        loginCalls++;
        if (loginCalls === 1) return jsonResponse(200, { token: 'jwt-1' });
        return jsonResponse(500, { error: 'API down' }); // re-login fails
      }
      return jsonResponse(401, { error: 'expired' });
    });
    const client = makeClient({ fetchFn: fetchFn as unknown as typeof fetch });
    await client.login();

    await expect(client.get('/status')).rejects.toThrow(TelegramApiError);
  });
});

describe('TelegramApiClient.loginWithRetry', () => {
  it('retries with the expected exponential backoff sequence until login succeeds, never throwing', async () => {
    let attempts = 0;
    const fetchFn = vi.fn(async () => {
      attempts++;
      if (attempts < 3) return jsonResponse(500, { error: 'API not ready' });
      return jsonResponse(200, { token: 'jwt-final' });
    });
    const sleepCalls: number[] = [];
    const sleep = vi.fn(async (ms: number) => {
      sleepCalls.push(ms);
    });
    const client = makeClient({ fetchFn: fetchFn as unknown as typeof fetch, sleep });

    await expect(client.loginWithRetry()).resolves.toBeUndefined();

    expect(attempts).toBe(3);
    expect(sleepCalls).toEqual([2000, 4000]); // base, then doubled -- capped separately, not reached here
  });

  it('never throws even after many consecutive failures (well past gmgn-cli-style maxRetries bounds), and keeps retrying until it eventually succeeds', async () => {
    // Deliberately NOT an open-ended "spin until aborted" race -- an
    // injected `sleep` that resolves instantly, combined with a fetchFn
    // that never succeeds, turns this into a tight microtask loop that
    // can starve a real `setTimeout`-based abort indefinitely (verified:
    // an earlier version of this test crashed the process with an
    // out-of-memory error this way). A fixed, deterministic failure count
    // proves the same thing -- "many failures, never throws, keeps
    // retrying" -- without any real-time race at all.
    const FAILURES_BEFORE_SUCCESS = 12; // well past EXECUTION.STUCK_ATTEMPT_MAX_RETRIES (5) / gmgn-cli's own maxRetries bound
    let attempts = 0;
    const fetchFn = vi.fn(async () => {
      attempts++;
      if (attempts <= FAILURES_BEFORE_SUCCESS) return jsonResponse(503, { error: 'down' });
      return jsonResponse(200, { token: 'jwt-final' });
    });
    const sleep = vi.fn(async () => undefined); // resolve instantly -- this test only cares about attempt count/never-throws, not real timing
    const client = makeClient({ fetchFn: fetchFn as unknown as typeof fetch, sleep });

    await expect(client.loginWithRetry()).resolves.toBeUndefined();

    expect(attempts).toBe(FAILURES_BEFORE_SUCCESS + 1);
    expect(sleep).toHaveBeenCalledTimes(FAILURES_BEFORE_SUCCESS);
  });

  it('an aborted signal stops the retry loop promptly and resolves (does not throw)', async () => {
    const fetchFn = vi.fn(async () => jsonResponse(500, { error: 'down' }));
    const sleep = vi.fn(async () => undefined);
    const client = makeClient({ fetchFn: fetchFn as unknown as typeof fetch, sleep });
    const controller = new AbortController();
    controller.abort();

    await expect(client.loginWithRetry(controller.signal)).resolves.toBeUndefined();
    expect(fetchFn).not.toHaveBeenCalled(); // aborted before the very first attempt
  });

  it('CRITICAL: an abort during a real backoff wait (default sleep, no injected sleep) cancels the underlying timer instead of waiting out the full 2s base delay', async () => {
    const fetchFn = vi.fn(async () => jsonResponse(500, { error: 'down' }));
    const client = makeClient({ fetchFn: fetchFn as unknown as typeof fetch }); // no injected sleep -- real setTimeout-based defaultSleep
    const controller = new AbortController();

    const start = Date.now();
    setTimeout(() => controller.abort(), 50);
    await client.loginWithRetry(controller.signal);
    const elapsed = Date.now() - start;

    expect(elapsed).toBeLessThan(500); // well under the 2000ms base backoff -- proves the real timer was cancelled, not just raced
  });
});
