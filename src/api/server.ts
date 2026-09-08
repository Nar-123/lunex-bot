import express from 'express';
import type { Express } from 'express';
import type { Server } from 'node:http';
import path from 'node:path';
import cors from 'cors';
import helmet from 'helmet';
import { config } from '../config';
import { authMiddleware, createAuthRouter } from '../auth';
import type { LoginRateLimiterOptions } from '../auth';
import type { AppDeps } from '../composition/types';
import { createStatusRouter } from './routes/status';
import { createPositionsRouter } from './routes/positions';
import { createStuckRouter } from './routes/stuck';
import { createCooldownsRouter } from './routes/cooldowns';
import { createLogsRouter } from './routes/logs';
import { createControlRouter } from './routes/control';
import { createSettingsRouter } from './routes/settings';

export interface CreateApiServerOptions {
  /** Test-only override -- lets tests use a short rate-limit window instead of the real 15-minute default. */
  loginRateLimiterOptions?: LoginRateLimiterOptions;
  /** Test-only override -- points `GET /logs` at a throwaway log file instead of `logs/lunex-bot.log`. */
  logFilePath?: string;
}

/**
 * Builds the Express app -- the single HTTP backend `api/`/`auth/`
 * (Module 10) that Telegram/UI will both consume later as separate
 * clients (neither is built here). Every route below `POST /auth/login`
 * requires a valid JWT (`authMiddleware`); `POST /auth/login` is the only
 * unauthenticated route, and the only rate-limited one.
 *
 * TLS is NEVER terminated here -- `API_HTTPS_CERT_PATH`/`API_HTTPS_KEY_PATH`
 * (present in config since Module 1) stay unused; HTTPS is a reverse-proxy/
 * deployment-layer concern, documented in README, not implemented in this
 * Node process per explicit instruction.
 */
export function createApiServer(deps: AppDeps, options: CreateApiServerOptions = {}): Express {
  const app = express();

  // Real client IP behind a reverse proxy -- needed for the login rate
  // limiter's IP-keyed store to work correctly; `config.api.trustProxy`
  // has existed since Module 1, unused until now.
  app.set('trust proxy', config.api.trustProxy);

  app.use(helmet());
  // Empty corsOrigin (default) -- no cross-origin browser access at all,
  // conservative by default. A configured origin enables it explicitly.
  app.use(cors(config.api.corsOrigin ? { origin: config.api.corsOrigin } : { origin: false }));
  app.use(express.json());

  // Module 12 (ui/): same-origin static serving, mounted BEFORE
  // authMiddleware -- the browser needs to load the login page and app
  // shell with no token yet; ui/'s own JS decides whether to show login
  // or the dashboard, the server never gates static file delivery on
  // auth. Deliberately under a dedicated `/app` prefix, not bare `/`, so
  // there is no ambiguity with the API's own top-level routes below
  // (`/status`, `/positions`, etc.). No SPA-fallback wildcard route: this
  // app never does client-side URL routing (every "page" is a JS-driven
  // tab switch within the one index.html express.static already serves
  // at `GET /app` via its default index-file lookup), so there is no
  // deep-link path that could 404 and need a fallback to catch.
  app.use('/app', express.static(path.join(__dirname, '../../ui/dist')));
  app.get('/', (_req, res) => res.redirect('/app'));

  app.use('/auth', createAuthRouter(options.loginRateLimiterOptions));

  app.use(authMiddleware);
  app.use('/status', createStatusRouter(deps));
  app.use('/positions/stuck', createStuckRouter(deps));
  app.use('/positions', createPositionsRouter(deps));
  app.use('/cooldowns', createCooldownsRouter(deps));
  app.use('/logs', createLogsRouter(options.logFilePath));
  app.use('/control', createControlRouter(deps));
  app.use('/settings', createSettingsRouter(deps));

  return app;
}

/** Starts listening on `config.api.port`/`host`. Returns the underlying `http.Server` so callers (`src/index.ts`) can `.close()` it on shutdown. */
export function startApiServer(deps: AppDeps, options: CreateApiServerOptions = {}): Promise<Server> {
  const app = createApiServer(deps, options);
  return new Promise((resolve) => {
    const server = app.listen(config.api.port, config.api.host, () => resolve(server));
  });
}
