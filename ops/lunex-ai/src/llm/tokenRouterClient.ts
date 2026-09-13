import type { Masker } from '../secretMask';

export interface ChatMessage {
  role: 'system' | 'user' | 'assistant';
  content: string;
}

export interface Completion {
  content: string;
  promptTokens: number | null;
  completionTokens: number | null;
}

export interface LlmClient {
  complete(messages: readonly ChatMessage[]): Promise<Completion>;
}

export class LlmError extends Error {
  constructor(
    message: string,
    readonly status: number | null,
    readonly retryable: boolean,
  ) {
    super(message);
    this.name = 'LlmError';
  }
}

export interface TokenRouterClientOptions {
  baseUrl: string;
  apiKey: string;
  model: string;
  timeoutMs: number;
  mask: Masker;
  maxRetries?: number;
  temperature?: number;
  fetchImpl?: typeof fetch;
  sleep?: (ms: number) => Promise<void>;
}

interface ChatCompletionResponse {
  choices?: { message?: { content?: unknown } }[];
  usage?: { prompt_tokens?: unknown; completion_tokens?: unknown };
}

const defaultSleep = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

/**
 * TokenRouter's OpenAI-compatible Chat Completions endpoint
 * (`POST {baseUrl}/chat/completions`, `Authorization: Bearer <key>`; per
 * docs.tokenrouter.io). Plain text completions only: the agent speaks a
 * JSON-action protocol in the message body instead of relying on `tools`
 * or JSON mode, which the gateway documents as provider-dependent.
 *
 * The API key is used only in the Authorization header. Every error message
 * is masked (an upstream error body could echo request headers), and the
 * model is never switched automatically on failure.
 */
export class TokenRouterClient implements LlmClient {
  private readonly fetchImpl: typeof fetch;
  private readonly sleep: (ms: number) => Promise<void>;
  private readonly maxRetries: number;

  constructor(private readonly options: TokenRouterClientOptions) {
    this.fetchImpl = options.fetchImpl ?? fetch;
    this.sleep = options.sleep ?? defaultSleep;
    this.maxRetries = options.maxRetries ?? 3;
  }

  get model(): string {
    return this.options.model;
  }

  async complete(messages: readonly ChatMessage[]): Promise<Completion> {
    const { mask } = this.options;
    let lastError: LlmError = new LlmError('no attempt made', null, false);

    for (let attempt = 0; attempt <= this.maxRetries; attempt++) {
      const controller = new AbortController();
      const timer = setTimeout(() => { controller.abort(); }, this.options.timeoutMs);
      let response: Response;
      try {
        response = await this.fetchImpl(`${this.options.baseUrl}/chat/completions`, {
          method: 'POST',
          headers: { 'content-type': 'application/json', authorization: `Bearer ${this.options.apiKey}` },
          body: JSON.stringify({ model: this.options.model, messages, temperature: this.options.temperature ?? 0.2 }),
          signal: controller.signal,
        });
      } catch (err) {
        clearTimeout(timer);
        const reason = controller.signal.aborted ? `timed out after ${String(this.options.timeoutMs)}ms` : err instanceof Error ? err.message : String(err);
        lastError = new LlmError(mask(`TokenRouter request failed: ${reason}`), null, true);
        if (attempt < this.maxRetries) await this.sleep(this.backoffMs(attempt, null));
        continue;
      }
      clearTimeout(timer);

      if (!response.ok) {
        const body = (await response.text().catch(() => '')).slice(0, 800);
        const retryable = response.status === 408 || response.status === 429 || response.status >= 500;
        lastError = new LlmError(mask(`TokenRouter HTTP ${String(response.status)}: ${body}`), response.status, retryable);
        if (!retryable) throw lastError;
        if (attempt < this.maxRetries) await this.sleep(this.backoffMs(attempt, response.headers.get('retry-after')));
        continue;
      }

      let json: ChatCompletionResponse;
      try {
        json = (await response.json()) as ChatCompletionResponse;
      } catch {
        throw new LlmError('TokenRouter returned a non-JSON response', response.status, false);
      }
      const content = json.choices?.[0]?.message?.content;
      if (typeof content !== 'string' || content.trim() === '') {
        throw new LlmError('TokenRouter returned an empty completion', response.status, false);
      }
      const promptTokens = typeof json.usage?.prompt_tokens === 'number' ? json.usage.prompt_tokens : null;
      const completionTokens = typeof json.usage?.completion_tokens === 'number' ? json.usage.completion_tokens : null;
      return { content, promptTokens, completionTokens };
    }
    throw lastError;
  }

  private backoffMs(attempt: number, retryAfter: string | null): number {
    const seconds = retryAfter !== null ? Number(retryAfter) : NaN;
    if (Number.isFinite(seconds) && seconds > 0) return Math.min(seconds * 1000, 60_000);
    return Math.min(1000 * 2 ** attempt, 30_000);
  }
}
