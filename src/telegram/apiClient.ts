import { config } from '../config';
import type { Logger } from '../composition/logger';

/**
 * The ONLY file in `telegram/` that makes an HTTP call -- everything else
 * in this module talks to `TelegramApiClient`, never to `fetch` directly,
 * never to `positions/`/`capital/`/etc. This is what keeps the
 * architectural boundary real: Telegram is a client of `api/`, over
 * loopback HTTP, exactly like `ui/` will be later -- even though both run
 * in the same Node process as the API server they're calling.
 *
 * Native `fetch` (Node 20+) -- same choice already made in
 * `swap/tradingApiClient.ts`, no new HTTP dependency.
 */

export class TelegramApiError extends Error {
  constructor(
    message: string,
    public readonly status?: number,
  ) {
    super(message);
    this.name = 'TelegramApiError';
  }
}

export interface TelegramApiClientOptions {
  baseUrl?: string;
  username?: string;
  password?: string;
  fetchFn?: typeof fetch;
  logger?: Logger;
  /** Test-injectable -- defaults to real `setTimeout`-based sleeping. */
  sleep?: (ms: number, signal?: AbortSignal) => Promise<void>;
}

const noopLogger: Logger = { info: () => undefined, warn: () => undefined, error: () => undefined };

/**
 * Genuinely cancels the underlying timer on abort (`clearTimeout`, not
 * just resolving a race early) -- a dangling `setTimeout` keeps Node's
 * event loop alive regardless of whether anything is still awaiting it,
 * which would defeat the entire point of making this abortable (see
 * `loginWithRetry`'s doc comment).
 */
function defaultSleep(ms: number, signal?: AbortSignal): Promise<void> {
  if (signal?.aborted) return Promise.resolve();
  return new Promise((resolve) => {
    const timer = setTimeout(() => {
      signal?.removeEventListener('abort', onAbort);
      resolve();
    }, ms);
    const onAbort = (): void => {
      clearTimeout(timer);
      resolve();
    };
    signal?.addEventListener('abort', onAbort, { once: true });
  });
}

const BACKOFF_BASE_MS = 2_000;
const BACKOFF_MAX_MS = 60_000;

/**
 * The bot's own identity as an API consumer: logs in once at startup
 * (`loginWithRetry`, unbounded backoff -- an unreachable API or a
 * misconfigured password must never crash-loop the process, per explicit
 * requirement), holds the JWT in memory, and re-logs-in exactly ONCE on a
 * `401` mid-request (there is no `/auth/refresh` -- confirmed not built in
 * Module 10 -- so a full re-login is the only option).
 */
export class TelegramApiClient {
  private readonly baseUrl: string;
  private readonly username: string;
  private readonly password: string;
  private readonly fetchFn: typeof fetch;
  private readonly logger: Logger;
  private readonly sleep: (ms: number, signal?: AbortSignal) => Promise<void>;
  private token: string | null = null;

  constructor(options: TelegramApiClientOptions = {}) {
    this.baseUrl = options.baseUrl ?? `http://localhost:${config.api.port}`;
    this.username = options.username ?? config.auth.adminUsername;
    this.password = options.password ?? config.auth.adminPassword;
    // `.bind(globalThis)` -- Node's `fetch` happens not to require its
    // receiver, but relying on that is an accident of the current Node
    // implementation, not a guarantee (see `ui/src/apiClient.ts`'s
    // identical fix, verified necessary live in a real browser, where the
    // unbound version throws "Illegal invocation" -- same underlying
    // pattern, fixed here defensively even though it isn't broken today).
    this.fetchFn = options.fetchFn ?? fetch.bind(globalThis);
    this.logger = options.logger ?? noopLogger;
    this.sleep = options.sleep ?? defaultSleep;
  }

  /** One login attempt. Throws `TelegramApiError` on any failure (network, non-200, malformed body) -- never swallows. */
  async login(): Promise<void> {
    const res = await this.fetchFn(`${this.baseUrl}/auth/login`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ username: this.username, password: this.password }),
    });
    if (!res.ok) {
      throw new TelegramApiError(`login failed: HTTP ${res.status}`, res.status);
    }
    const body = (await res.json()) as { token?: unknown };
    if (typeof body.token !== 'string' || body.token.length === 0) {
      throw new TelegramApiError('login response did not include a token');
    }
    this.token = body.token;
  }

  /**
   * Unbounded retry with exponential backoff (2s, 4s, 8s, ... capped at
   * 60s) -- deliberately never throws, never gives up. "JANGAN
   * crash-loop tanpa henti": an unreachable API at startup (very likely
   * -- this races against `startApiServer`) or a stale password must
   * degrade to "keep trying, log clearly," not "exit and let a process
   * supervisor restart us into the same failure over and over."
   *
   * `signal`, if given, lets this loop be cancelled from the outside --
   * needed so a misconfigured/unreachable API doesn't leave a `setTimeout`
   * pending forever, which would keep Node's event loop alive and block
   * `src/index.ts`'s graceful-shutdown path (specifically the branch where
   * it deliberately does NOT call `process.exit()` and instead waits for
   * the event loop to drain naturally). Checked at the top of every
   * iteration AND passed into `sleep` (`defaultSleep` genuinely
   * `clearTimeout`s on abort, not just resolving early) so an abort during
   * a long backoff wait is noticed almost immediately, not just before the
   * NEXT attempt. Returns silently on abort -- this is a normal, expected
   * cancellation, not a failure to log.
   */
  async loginWithRetry(signal?: AbortSignal): Promise<void> {
    let attempt = 0;
    for (;;) {
      if (signal?.aborted) return;
      try {
        await this.login();
        return;
      } catch (err) {
        const delayMs = Math.min(BACKOFF_BASE_MS * 2 ** attempt, BACKOFF_MAX_MS);
        this.logger.warn('telegram_login_failed', {
          attempt: attempt + 1,
          retryInMs: delayMs,
          message: err instanceof Error ? err.message : String(err),
        });
        await this.sleep(delayMs, signal);
        attempt++;
      }
    }
  }

  private authHeaders(): Record<string, string> {
    if (!this.token) throw new TelegramApiError('not logged in yet');
    return { Authorization: `Bearer ${this.token}` };
  }

  private async request<T>(method: 'GET' | 'POST' | 'PATCH', path: string, body?: unknown, isRetry = false): Promise<T> {
    const res = await this.fetchFn(`${this.baseUrl}${path}`, {
      method,
      headers: { ...this.authHeaders(), ...(body !== undefined ? { 'Content-Type': 'application/json' } : {}) },
      ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
    });

    if (res.status === 401 && !isRetry) {
      // Token expired (no refresh endpoint exists) -- re-login exactly
      // once, then retry the SAME request exactly once. A second 401
      // (or a re-login failure) is a real error, surfaced to the caller.
      await this.login();
      return this.request<T>(method, path, body, true);
    }
    if (!res.ok) {
      throw new TelegramApiError(`${method} ${path} failed: HTTP ${res.status}`, res.status);
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
