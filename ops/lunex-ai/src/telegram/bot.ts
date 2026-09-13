import type { Logger } from '../logger';
import type { StateStore } from '../stateStore';
import type { TelegramApi } from './botApi';
import { handleMessage } from './commands';
import type { CommandHandlerDeps } from './commands';

const defaultSleep = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

/**
 * The ONE Telegram control bot. Long-polls getUpdates and hands each text
 * message to `handleMessage`, which checks admin authorization first.
 *
 * The offset is persisted BEFORE a message is handled (at-most-once): if
 * the process dies mid-command, that command is not replayed after the
 * restart. A lost /status is harmless; a replayed /approve or /task is not.
 */
export class TelegramControlBot {
  private stopping = false;

  constructor(
    private readonly api: TelegramApi,
    private readonly store: StateStore,
    private readonly handler: Omit<CommandHandlerDeps, 'send'>,
    private readonly logger: Logger,
    private readonly sleep: (ms: number) => Promise<void> = defaultSleep,
    private readonly pollTimeoutSec = 30,
  ) {}

  /** Sends to every admin (a private chat's id equals the user's id; the admin must have sent /start once). */
  async notify(text: string): Promise<void> {
    for (const adminId of this.handler.adminIds) {
      try {
        await this.api.sendMessage(adminId, text);
      } catch (err) {
        this.logger.error('telegram_notify_failed', { adminId, message: err instanceof Error ? err.message : String(err) });
      }
    }
  }

  stop(): void {
    this.stopping = true;
  }

  /** Processes one getUpdates batch. Exposed for tests. */
  async pollOnce(): Promise<number> {
    const offset = this.store.getProgress().telegramOffset;
    const updates = await this.api.getUpdates(offset, this.pollTimeoutSec);
    for (const update of updates) {
      this.store.updateProgress({ telegramOffset: update.update_id + 1 });
      const message = update.message;
      if (!message?.text) continue;
      const reply = await handleMessage(
        { fromId: message.from?.id, chatId: message.chat.id, text: message.text },
        { ...this.handler, send: (chatId, text) => this.api.sendMessage(chatId, text) },
      );
      if (reply !== null) {
        try {
          await this.api.sendMessage(message.chat.id, reply);
        } catch (err) {
          this.logger.error('telegram_reply_failed', { message: err instanceof Error ? err.message : String(err) });
        }
      }
    }
    return updates.length;
  }

  async run(): Promise<void> {
    this.logger.info('telegram_polling_started', {});
    let failures = 0;
    while (!this.stopping) {
      try {
        await this.pollOnce();
        failures = 0;
      } catch (err) {
        failures++;
        this.logger.warn('telegram_poll_failed', { message: err instanceof Error ? err.message : String(err), failures });
        await this.sleep(Math.min(5000 * failures, 60_000));
      }
    }
    this.logger.info('telegram_polling_stopped', {});
  }
}
