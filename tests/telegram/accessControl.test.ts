import { describe, expect, it, vi, beforeEach, afterEach } from 'vitest';
import type { Context } from 'telegraf';
import { authorizedOnly } from '../../src/telegram/accessControl';
import { createInMemoryLogger } from '../../src/composition/logger';
import { config } from '../../src/config';

function fakeCtx(fromId: number | undefined, chatId = 999): { ctx: Context; reply: ReturnType<typeof vi.fn> } {
  const reply = vi.fn(async () => undefined);
  const ctx = {
    from: fromId === undefined ? undefined : { id: fromId },
    chat: { id: chatId },
    reply,
  } as unknown as Context;
  return { ctx, reply };
}

describe('authorizedOnly', () => {
  const originalIds = config.telegram.authorizedUserIds;

  beforeEach(() => {
    (config.telegram as { authorizedUserIds: number[] }).authorizedUserIds = [111, 222];
  });

  afterEach(() => {
    (config.telegram as { authorizedUserIds: number[] }).authorizedUserIds = originalIds;
  });

  it('calls next() for an update from an authorized id', async () => {
    const logger = createInMemoryLogger();
    const middleware = authorizedOnly(logger);
    const { ctx } = fakeCtx(111);
    const next = vi.fn(async () => undefined);

    await middleware(ctx, next);

    expect(next).toHaveBeenCalledTimes(1);
  });

  it('does NOT call next() for an update from an unauthorized id, and does NOT reply', async () => {
    const logger = createInMemoryLogger();
    const middleware = authorizedOnly(logger);
    const { ctx, reply } = fakeCtx(999999);
    const next = vi.fn(async () => undefined);

    await middleware(ctx, next);

    expect(next).not.toHaveBeenCalled();
    expect(reply).not.toHaveBeenCalled(); // explicit: silent drop, not a rejection message (Decision 1)
  });

  it('logs a warn server-side for a dropped update', async () => {
    const logger = createInMemoryLogger();
    const middleware = authorizedOnly(logger);
    const { ctx } = fakeCtx(999999, 555);
    await middleware(ctx, vi.fn(async () => undefined));

    const warnLine = logger.lines.find((l) => l.event === 'telegram_unauthorized_update');
    expect(warnLine).toBeDefined();
    expect(warnLine?.level).toBe('warn');
    expect(warnLine?.data.userId).toBe(999999);
    expect(warnLine?.data.chatId).toBe(555);
  });

  it('drops an update with no `from` at all (e.g. a channel post) rather than throwing', async () => {
    const logger = createInMemoryLogger();
    const middleware = authorizedOnly(logger);
    const { ctx, reply } = fakeCtx(undefined);
    const next = vi.fn(async () => undefined);

    await middleware(ctx, next);

    expect(next).not.toHaveBeenCalled();
    expect(reply).not.toHaveBeenCalled();
  });
});
