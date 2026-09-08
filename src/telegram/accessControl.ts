import type { Context, MiddlewareFn } from 'telegraf';
import { config } from '../config';
import type { Logger } from '../composition/logger';

/**
 * Decision 1: reuses `TELEGRAM_AUTHORIZED_USER_IDS`/
 * `config.telegram.authorizedUserIds` -- already built in Module 1, no new
 * config field. Registered as the FIRST middleware on the bot -- an
 * update from an id not on the allowlist is dropped here, before any
 * command handler ever runs.
 *
 * Silently drops (no `ctx.reply`, `next()` never called) rather than
 * replying "unauthorized" -- confirming to a stranger that this bot is
 * alive and responsive is information nobody outside the allowlist needs.
 * Logged server-side at `warn` (visible in `logs/lunex-bot.log`) so
 * repeated probing is still noticeable, just not to the prober.
 */
export function authorizedOnly(logger: Logger): MiddlewareFn<Context> {
  return async (ctx, next) => {
    const userId = ctx.from?.id;
    if (userId === undefined || !config.telegram.authorizedUserIds.includes(userId)) {
      logger.warn('telegram_unauthorized_update', { userId, chatId: ctx.chat?.id });
      return;
    }
    await next();
  };
}
