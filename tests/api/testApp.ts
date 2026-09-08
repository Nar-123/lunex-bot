import type { Express } from 'express';
import { createApiServer } from '../../src/api/server';
import { signAccessToken } from '../../src/auth/jwt';
import { config } from '../../src/config';
import type { AppDeps } from '../../src/composition/types';
import { createFakeAppDeps } from '../composition/fakeAppDeps';

/** A valid `Authorization` header value for tests that aren't exercising login/auth-middleware themselves -- mints a token directly (bypassing the login endpoint's bcrypt check, which the shared test fixture hash can't satisfy). */
export function authHeader(): string {
  return `Bearer ${signAccessToken(config.auth.adminUsername)}`;
}

/**
 * Builds a real Express app (`createApiServer`, unmodified) wired to a
 * fully fake `AppDeps` (same in-memory/fake-port pattern every other
 * composition-level test in this project uses) -- no server actually
 * listens on a port; `supertest` drives the app directly in-process.
 */
export function buildTestApp(overrides: Partial<AppDeps> = {}): { app: Express; deps: AppDeps } {
  const deps = createFakeAppDeps(overrides);
  const app = createApiServer(deps, { loginRateLimiterOptions: { windowMs: 200, maxAttempts: 3 } });
  return { app, deps };
}
