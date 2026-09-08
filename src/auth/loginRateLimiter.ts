import { rateLimit } from 'express-rate-limit';
import type { RequestHandler } from 'express';
import { config } from '../config';

export interface LoginRateLimiterOptions {
  windowMs?: number;
  maxAttempts?: number;
}

/**
 * Rate-limits `POST /auth/login`. Per explicit requirement, this counts
 * FAILED attempts only ("N kali gagal," not N attempts total) --
 * `skipSuccessfulRequests: true` means a correct login never counts against
 * the window, only wrong-password/wrong-username attempts do. Keyed by
 * client IP (the library's default `keyGenerator`), which is only
 * meaningful when `config.api.trustProxy` is set correctly behind a
 * reverse proxy (wired in `api/server.ts`) -- there is no IP whitelist by
 * design (spec), so this is the only defense against brute-forcing the
 * single admin account.
 *
 * `windowMs`/`maxAttempts` are explicit override parameters (defaulting to
 * `config.auth.loginRateLimitWindowMs`/`MaxAttempts`) so tests can use a
 * short window instead of waiting out the real 15-minute default.
 */
export function createLoginRateLimiter(options: LoginRateLimiterOptions = {}): RequestHandler {
  return rateLimit({
    windowMs: options.windowMs ?? config.auth.loginRateLimitWindowMs,
    limit: options.maxAttempts ?? config.auth.loginRateLimitMaxAttempts,
    standardHeaders: true,
    legacyHeaders: false,
    skipSuccessfulRequests: true,
    message: { error: 'too many failed login attempts, try again later' },
  });
}
