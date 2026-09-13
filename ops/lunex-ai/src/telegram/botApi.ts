import type { Masker } from '../secretMask';

export interface TelegramMessage {
  message_id: number;
  from?: { id: number; username?: string };
  chat: { id: number; type: string };
  text?: string;
}

export interface TelegramUpdate {
  update_id: number;
  message?: TelegramMessage;
}

export interface TelegramApi {
  getUpdates(offset: number, timeoutSec: number): Promise<TelegramUpdate[]>;
  sendMessage(chatId: number, text: string): Promise<void>;
}

const TELEGRAM_MAX = 3800; // Telegram's hard limit is 4096; leave headroom

export function chunkMessage(text: string, max = TELEGRAM_MAX): string[] {
  if (text.length <= max) return [text];
  const chunks: string[] = [];
  let rest = text;
  while (rest.length > max) {
    const cut = rest.lastIndexOf('\n', max);
    const at = cut > max / 2 ? cut : max;
    chunks.push(rest.slice(0, at));
    rest = rest.slice(at).replace(/^\n/, '');
  }
  if (rest.length > 0) chunks.push(rest);
  return chunks;
}

interface TelegramResponse<T> {
  ok: boolean;
  result?: T;
  description?: string;
}

/**
 * Minimal Telegram Bot API client over fetch (no extra dependency). The
 * bot token only ever appears in the request URL; thrown errors carry the
 * API's description or the transport message (never the URL), and are
 * masked regardless. Messages are sent as plain text (no parse_mode), so
 * content from code, diffs or the model can't inject formatting or links.
 */
export class TelegramHttpApi implements TelegramApi {
  constructor(
    private readonly token: string,
    private readonly mask: Masker,
    private readonly fetchImpl: typeof fetch = fetch,
  ) {}

  private async call<T>(method: string, body: unknown, timeoutMs: number): Promise<T> {
    const controller = new AbortController();
    const timer = setTimeout(() => { controller.abort(); }, timeoutMs);
    try {
      let response: Response;
      try {
        response = await this.fetchImpl(`https://api.telegram.org/bot${this.token}/${method}`, {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify(body),
          signal: controller.signal,
        });
      } catch (err) {
        throw new Error(this.mask(`telegram ${method} transport error: ${controller.signal.aborted ? 'timeout' : err instanceof Error ? err.message : String(err)}`));
      }
      const json = (await response.json().catch(() => ({ ok: false, description: `HTTP ${String(response.status)}` }))) as TelegramResponse<T>;
      if (!json.ok || json.result === undefined) {
        throw new Error(this.mask(`telegram ${method} failed: ${json.description ?? `HTTP ${String(response.status)}`}`));
      }
      return json.result;
    } finally {
      clearTimeout(timer);
    }
  }

  getUpdates(offset: number, timeoutSec: number): Promise<TelegramUpdate[]> {
    return this.call<TelegramUpdate[]>('getUpdates', { offset, timeout: timeoutSec, allowed_updates: ['message'] }, (timeoutSec + 15) * 1000);
  }

  async sendMessage(chatId: number, text: string): Promise<void> {
    for (const chunk of chunkMessage(this.mask(text))) {
      await this.call('sendMessage', { chat_id: chatId, text: chunk, disable_web_page_preview: true }, 30_000);
    }
  }
}
