import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { StateStore } from '../src/stateStore';
import type { SupervisorControl } from '../src/supervisor/supervisor';
import { TelegramControlBot } from '../src/telegram/bot';
import { chunkMessage } from '../src/telegram/botApi';
import type { TelegramApi, TelegramUpdate } from '../src/telegram/botApi';
import { silentLogger } from './helpers';

const ADMIN = 111;
const STRANGER = 999;

let dir: string;
beforeEach(() => { dir = fs.mkdtempSync(path.join(os.tmpdir(), 'lunex-ai-bot-')); });
afterEach(() => { fs.rmSync(dir, { recursive: true, force: true }); });

const update = (id: number, fromId: number, text: string): TelegramUpdate => ({
  update_id: id,
  message: { message_id: id, from: { id: fromId }, chat: { id: fromId, type: 'private' }, text },
});

function fakeApi(batches: TelegramUpdate[][]): TelegramApi & { getUpdates: ReturnType<typeof vi.fn>; sendMessage: ReturnType<typeof vi.fn> } {
  return {
    getUpdates: vi.fn(async () => batches.shift() ?? []),
    sendMessage: vi.fn(async () => undefined),
  };
}

describe('TelegramControlBot', () => {
  it('replies only to the admin, and persists the offset BEFORE handling so a restart never replays a command', async () => {
    const store = new StateStore(dir);
    const api = fakeApi([[update(10, ADMIN, '/status'), update(11, STRANGER, '/status')]]);
    const offsetsSeenDuringHandling: number[] = [];
    const control = { status: vi.fn(async () => { offsetsSeenDuringHandling.push(store.getProgress().telegramOffset); return 'STATUS'; }) } as unknown as SupervisorControl;
    const bot = new TelegramControlBot(api, store, { control, adminIds: [ADMIN], logger: silentLogger(), replyToUnauthorized: false }, silentLogger());

    await bot.pollOnce();

    expect(api.getUpdates).toHaveBeenCalledWith(0, 30);
    expect(offsetsSeenDuringHandling).toEqual([11]);
    expect(api.sendMessage).toHaveBeenCalledTimes(1);
    expect(api.sendMessage).toHaveBeenCalledWith(ADMIN, 'STATUS');
    expect(store.getProgress().telegramOffset).toBe(12);

    // "restart": a fresh bot on the same state resumes after the handled updates
    const api2 = fakeApi([[]]);
    await new TelegramControlBot(api2, new StateStore(dir), { control, adminIds: [ADMIN], logger: silentLogger(), replyToUnauthorized: false }, silentLogger()).pollOnce();
    expect(api2.getUpdates).toHaveBeenCalledWith(12, 30);
  });

  it('notify reaches every admin and a send failure is logged, not thrown', async () => {
    const api = fakeApi([]);
    api.sendMessage.mockRejectedValueOnce(new Error('chat not found'));
    const logger = silentLogger();
    const bot = new TelegramControlBot(api, new StateStore(dir), { control: {} as SupervisorControl, adminIds: [1, 2], logger, replyToUnauthorized: false }, logger);

    await expect(bot.notify('report')).resolves.toBeUndefined();
    expect(api.sendMessage).toHaveBeenCalledWith(1, 'report');
    expect(api.sendMessage).toHaveBeenCalledWith(2, 'report');
    expect(logger.error).toHaveBeenCalledWith('telegram_notify_failed', expect.objectContaining({ adminId: 1 }));
  });

  it('run() survives polling errors and exits when stopped', async () => {
    const store = new StateStore(dir);
    const logger = silentLogger();
    let bot: TelegramControlBot | null = null;
    const api: TelegramApi = {
      getUpdates: vi.fn()
        .mockRejectedValueOnce(new Error('network down'))
        .mockImplementationOnce(async () => { bot?.stop(); return []; }),
      sendMessage: vi.fn(),
    };
    const sleep = vi.fn(async () => undefined);
    bot = new TelegramControlBot(api, store, { control: {} as SupervisorControl, adminIds: [ADMIN], logger, replyToUnauthorized: false }, logger, sleep);

    await bot.run();

    expect(api.getUpdates).toHaveBeenCalledTimes(2);
    expect(logger.warn).toHaveBeenCalledWith('telegram_poll_failed', expect.objectContaining({ failures: 1 }));
    expect(sleep).toHaveBeenCalledWith(5000);
  });
});

describe('chunkMessage', () => {
  it('splits long reports on line boundaries under the Telegram limit', () => {
    const text = Array.from({ length: 400 }, (_, i) => `line ${String(i)} ${'x'.repeat(20)}`).join('\n');
    const chunks = chunkMessage(text, 1000);
    expect(chunks.length).toBeGreaterThan(1);
    expect(chunks.every((c) => c.length <= 1000)).toBe(true);
    expect(chunks.join('\n')).toBe(text);
  });
});
