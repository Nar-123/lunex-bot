import { config } from './config';
import { createRealAppDeps, startApp } from './composition';
import { startApiServer } from './api';
import { startTelegramBot } from './telegram';
import type { RunningTelegramBot } from './telegram';
import { disconnectPrismaClient } from './storage/prismaClient';

/**
 * Application entrypoint (Modules 9B + 10 + 11) — real wiring for all
 * three live cycles (30-minute screening, 15-second monitoring, 15-second
 * exit+open-resume), the HTTP API server, and the Telegram bot (the
 * first real API client -- see `telegram/apiClient.ts`'s doc comment for
 * the loopback-HTTP-only boundary this deliberately respects). Thin: all
 * actual logic lives in `composition/`/`api/`/`telegram/` so it can be
 * exercised directly by tests without spawning a real process — this
 * file only does process-level concerns (construct real deps, start
 * everything, wire OS signals for graceful shutdown).
 */
async function main(): Promise<void> {
  const deps = createRealAppDeps();
  deps.logger.info('startup', { chainId: config.chain.chainId, env: config.nodeEnv, db: config.database.provider });

  const { stop } = startApp(deps);
  const httpServer = await startApiServer(deps);
  deps.logger.info('api_server_started', { port: config.api.port, host: config.api.host });

  // Telegram is an optional integration (empty token = disabled, a
  // supported/documented state, not an error) -- started AFTER the API
  // server is actually listening, since the bot's own login
  // (`loginWithRetry`) is the first real HTTP client of it. NOT awaited
  // in the main sequential flow: if login is stuck retrying (API slow to
  // become reachable, wrong credentials), the process must still be able
  // to register its signal handlers and respond to SIGTERM/SIGINT
  // immediately -- awaiting an unbounded retry loop here would block that.
  const telegramAbortController = new AbortController();
  let telegramBot: RunningTelegramBot | null = null;
  if (config.telegram.botToken !== '') {
    startTelegramBot(deps, telegramAbortController.signal)
      .then((bot) => {
        telegramBot = bot;
      })
      .catch((err) => {
        deps.logger.error('telegram_bot_start_failed', { message: err instanceof Error ? err.message : String(err) });
      });
  } else {
    deps.logger.info('telegram_disabled', { message: 'TELEGRAM_BOT_TOKEN is empty -- Telegram integration disabled.' });
  }

  let shuttingDown = false;
  const shutdown = async (signal: string): Promise<void> => {
    if (shuttingDown) return;
    shuttingDown = true;
    deps.logger.info('shutdown_signal_received', { signal });

    // The HTTP server, the three cycles, and the Telegram bot are
    // independent concerns -- closed in parallel. `server.close()` stops
    // accepting new connections and waits for in-flight requests to
    // finish on its own; no timeout knob is needed here the way cycle
    // shutdown needs one -- HTTP requests in this API are only
    // reads/settings-writes, never a blockchain-critical multi-step
    // transaction, so none of `stop()`'s "never cancel mid-flight"
    // caution applies to it. `telegramAbortController.abort()` is
    // harmless to call even if the bot already started (or was disabled
    // entirely) -- it only matters if `loginWithRetry` is still looping.
    const closeHttpServer = new Promise<void>((resolve, reject) => {
      httpServer.close((err) => (err ? reject(err) : resolve()));
    });
    telegramAbortController.abort();
    const closeTelegramBot = telegramBot ? telegramBot.stop() : Promise.resolve();
    const [{ timedOut }] = await Promise.all([stop(), closeHttpServer, closeTelegramBot]);

    if (timedOut) {
      // `stop()`'s own doc comment: a timeout NEVER cancels the in-flight
      // work, it only stops WAITING for it -- so at this point a
      // TransactionAttempt write or a position-status update may still be
      // running, abandoned in the background. Forcing `process.exit()`
      // here would kill the process mid-write, which is exactly the
      // outcome graceful shutdown exists to prevent. Deliberately NOT
      // calling `process.exit()` in this branch: Node's event loop keeps
      // the process alive on its own for as long as that abandoned work
      // (and anything it's still waiting on -- an RPC call, a DB write)
      // is genuinely still running, and exits naturally, with the
      // abandoned work having actually finished, the moment it's truly
      // idle. This can take longer than `shutdownTimeoutMs` -- that is
      // the accepted tradeoff (see `config.composition.shutdownTimeoutMs`'s
      // doc comment in `config/env.ts`), not a bug.
      deps.logger.warn('shutdown_timed_out', {
        message: `A cycle was still running after ${config.composition.shutdownTimeoutMs}ms -- refusing to force-exit while work may still be in flight. The process will exit on its own once that work finishes.`,
      });
      return;
    }

    await disconnectPrismaClient();
    deps.logger.info('shutdown_complete', {});
    process.exit(0);
  };

  process.on('SIGTERM', () => {
    void shutdown('SIGTERM');
  });
  process.on('SIGINT', () => {
    void shutdown('SIGINT');
  });
}

main().catch((err) => {
  // Not routed through the structured logger -- if construction itself
  // failed (e.g. bad config), the logger may not exist yet either.
  console.error('[lunex-bot] fatal startup error:', err);
  process.exit(1);
});
