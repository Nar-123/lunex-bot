import { Telegraf } from 'telegraf';
import { message } from 'telegraf/filters';
import type { Context } from 'telegraf';
import { config } from '../config';
import type { Logger } from '../composition/logger';
import { TelegramApiClient } from './apiClient';
import { authorizedOnly } from './accessControl';
import { ConfirmationStore } from './confirmation';
import { handleStatus, handlePositions, handleReport, handleStuck, handleCooldowns, handleLogs, handlePause, handleResume } from './commands';

export interface TelegramBotDeps {
  logger: Logger;
}

export interface RunningTelegramBot {
  stop: () => Promise<void>;
}

/** Extracts the text after a command, e.g. "/logs 50" -> "50"; undefined if there's no argument. */
function commandArg(ctx: Context): string | undefined {
  if (!ctx.has(message('text'))) return undefined;
  const parts = ctx.message.text.trim().split(/\s+/);
  return parts.length > 1 ? parts[1] : undefined;
}

/**
 * Wires the bot's middleware/command pipeline. `authorizedOnly` is
 * registered FIRST -- everything after it only ever runs for allowlisted
 * `ctx.from.id`s (Decision 1). The plain-text handler (for confirming
 * `/pause`/`/resume`) is registered LAST, so it only ever sees messages
 * that didn't match any command above it (telegraf's own middleware
 * composition -- a matched `bot.command()` stops the chain there).
 */
export function createTelegramBot(apiClient: TelegramApiClient, deps: TelegramBotDeps): Telegraf {
  const bot = new Telegraf(config.telegram.botToken);
  const confirmations = new ConfirmationStore();

  bot.use(authorizedOnly(deps.logger));

  bot.command('status', (ctx) => handleStatus(apiClient, ctx));
  bot.command('positions', (ctx) => handlePositions(apiClient, ctx));
  bot.command('report', (ctx) => handleReport(apiClient, ctx));
  bot.command('stuck', (ctx) => handleStuck(apiClient, ctx));
  bot.command('cooldowns', (ctx) => handleCooldowns(apiClient, ctx));
  bot.command('logs', (ctx) => handleLogs(apiClient, ctx, commandArg(ctx)));
  bot.command('pause', (ctx) => handlePause(apiClient, confirmations, ctx));
  bot.command('resume', (ctx) => handleResume(apiClient, confirmations, ctx));

  bot.on(message('text'), async (ctx) => {
    const chatId = ctx.chat.id;
    await confirmations.tryConsume(chatId, ctx.message.text);
  });

  return bot;
}

/**
 * Logs in (`loginWithRetry` -- unbounded, never throws) BEFORE
 * `bot.launch()`, so the bot never starts accepting commands with no
 * usable token ("login saat startup, sebelum mulai dengarkan pesan").
 * Returns a `stop()` for graceful shutdown alongside the rest of
 * `src/index.ts`'s shutdown sequence.
 *
 * `signal`, if given and fired before login succeeds (e.g. the process is
 * shutting down while still retrying an unreachable API), aborts the
 * retry loop and resolves to `null` instead of ever calling `bot.launch()`
 * -- there's nothing to stop in that case, and the caller (`src/index.ts`)
 * should just treat the bot as never having started.
 */
export async function startTelegramBot(deps: TelegramBotDeps, signal?: AbortSignal): Promise<RunningTelegramBot | null> {
  if (config.telegram.botToken !== '' && config.telegram.authorizedUserIds.length === 0) {
    deps.logger.warn('telegram_no_authorized_users', {
      message:
        'TELEGRAM_BOT_TOKEN is set but TELEGRAM_AUTHORIZED_USER_IDS is empty -- the bot will start and log in ' +
        'successfully, but every incoming message will be silently dropped by accessControl.ts until this is ' +
        'filled in. If this is intentional (staged deployment), no action needed; otherwise, set ' +
        'TELEGRAM_AUTHORIZED_USER_IDS.',
    });
  }

  const apiClient = new TelegramApiClient({ logger: deps.logger });
  await apiClient.loginWithRetry(signal);
  if (signal?.aborted) return null;

  const bot = createTelegramBot(apiClient, deps);
  // `bot.launch()` deliberately NOT awaited -- telegraf's own polling loop
  // only resolves that promise once the bot is STOPPED, so awaiting it
  // here would block this function (and everything after it in
  // `src/index.ts`) forever. Standard telegraf idiom: launch in the
  // background, attach a rejection handler for a genuine launch failure
  // (e.g. an invalid token), return control immediately.
  bot.launch().catch((err: unknown) => {
    deps.logger.error('telegram_bot_launch_failed', { message: err instanceof Error ? err.message : String(err) });
  });
  deps.logger.info('telegram_bot_started', {});

  return {
    stop: () => {
      // grammY's stop() is synchronous fire-and-forget; returning an
      // already-resolved Promise keeps the RunningTelegramBot contract
      // (an awaited stop) without a no-op async.
      bot.stop('SIGTERM');
      return Promise.resolve();
    },
  };
}
