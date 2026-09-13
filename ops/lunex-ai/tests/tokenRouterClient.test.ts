import { describe, expect, it, vi } from 'vitest';
import { LlmError, TokenRouterClient } from '../src/llm/tokenRouterClient';
import { createMasker } from '../src/secretMask';

const API_KEY = 'trk-test-0123456789abcdefghijklmnop';
const BASE = 'https://api.tokenrouter.io/v1';
const MODEL = 'z-ai/glm-5.3-free';
const mask = createMasker([API_KEY]);

function jsonResponse(status: number, body: unknown, headers: Record<string, string> = {}): Response {
  return new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json', ...headers } });
}

function okCompletion(content: string): Response {
  return jsonResponse(200, { choices: [{ message: { role: 'assistant', content } }], usage: { prompt_tokens: 11, completion_tokens: 7 } });
}

function client(fetchImpl: typeof fetch, extra: { maxRetries?: number; timeoutMs?: number } = {}) {
  const sleep = vi.fn(async () => undefined);
  return { sleep, c: new TokenRouterClient({ baseUrl: BASE, apiKey: API_KEY, model: MODEL, timeoutMs: extra.timeoutMs ?? 5000, mask, fetchImpl, sleep, maxRetries: extra.maxRetries ?? 3 }) };
}

describe('TokenRouterClient (mocked gateway)', () => {
  it('POSTs an OpenAI-compatible chat completion with bearer auth and the configured model', async () => {
    const fetchImpl = vi.fn(async () => okCompletion('{"thought":"x","action":{"type":"list_dir","path":"src"}}'));
    const { c } = client(fetchImpl as unknown as typeof fetch);

    const result = await c.complete([{ role: 'user', content: 'hi' }]);

    expect(result).toEqual({ content: '{"thought":"x","action":{"type":"list_dir","path":"src"}}', promptTokens: 11, completionTokens: 7 });
    const [url, init] = fetchImpl.mock.calls[0] as unknown as [string, RequestInit];
    expect(url).toBe(`${BASE}/chat/completions`);
    expect((init.headers as Record<string, string>).authorization).toBe(`Bearer ${API_KEY}`);
    const body = JSON.parse(init.body as string) as { model: string; messages: unknown[] };
    expect(body.model).toBe(MODEL);
    expect(body.messages).toEqual([{ role: 'user', content: 'hi' }]);
  });

  it('retries 429 honouring Retry-After, then succeeds -- with the SAME model (never switches automatically)', async () => {
    const fetchImpl = vi.fn()
      .mockResolvedValueOnce(jsonResponse(429, { error: 'rate limited' }, { 'retry-after': '2' }))
      .mockResolvedValueOnce(okCompletion('done'));
    const { c, sleep } = client(fetchImpl as unknown as typeof fetch);

    await expect(c.complete([{ role: 'user', content: 'x' }])).resolves.toMatchObject({ content: 'done' });
    expect(sleep).toHaveBeenCalledWith(2000);
    const models = fetchImpl.mock.calls.map((call) => (JSON.parse((call[1] as RequestInit).body as string) as { model: string }).model);
    expect(models).toEqual([MODEL, MODEL]);
  });

  it('gives up after maxRetries on persistent 5xx with a retryable LlmError', async () => {
    const fetchImpl = vi.fn(async () => jsonResponse(503, { error: 'upstream down' }));
    const { c } = client(fetchImpl as unknown as typeof fetch, { maxRetries: 2 });
    const err = await c.complete([{ role: 'user', content: 'x' }]).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(LlmError);
    expect((err as LlmError).retryable).toBe(true);
    expect(fetchImpl).toHaveBeenCalledTimes(3);
  });

  it('does not retry 4xx (bad key / unknown model) and never leaks the key in the error, even if the gateway echoes it', async () => {
    const fetchImpl = vi.fn(async () => jsonResponse(401, { error: `invalid api key ${API_KEY}` }));
    const { c } = client(fetchImpl as unknown as typeof fetch);
    const err = (await c.complete([{ role: 'user', content: 'x' }]).catch((e: unknown) => e)) as LlmError;
    expect(err).toBeInstanceOf(LlmError);
    expect(err.status).toBe(401);
    expect(err.retryable).toBe(false);
    expect(err.message).not.toContain(API_KEY);
    expect(fetchImpl).toHaveBeenCalledTimes(1);
  });

  it('retries transport errors and masks their messages', async () => {
    const fetchImpl = vi.fn()
      .mockRejectedValueOnce(new Error(`connect ECONNREFUSED (key ${API_KEY})`))
      .mockResolvedValueOnce(okCompletion('ok'));
    const { c } = client(fetchImpl as unknown as typeof fetch);
    await expect(c.complete([{ role: 'user', content: 'x' }])).resolves.toMatchObject({ content: 'ok' });

    const failing = vi.fn(async () => { throw new Error(`boom ${API_KEY}`); });
    const { c: c2 } = client(failing as unknown as typeof fetch, { maxRetries: 0 });
    const err = (await c2.complete([{ role: 'user', content: 'x' }]).catch((e: unknown) => e)) as LlmError;
    expect(err.message).not.toContain(API_KEY);
  });

  it('reports a timeout when the gateway does not answer in time', async () => {
    const hanging = vi.fn((_url: string, init: RequestInit) => new Promise<Response>((_resolve, reject) => {
      init.signal?.addEventListener('abort', () => { reject(new Error('aborted')); });
    }));
    const { c } = client(hanging as unknown as typeof fetch, { maxRetries: 0, timeoutMs: 20 });
    await expect(c.complete([{ role: 'user', content: 'x' }])).rejects.toThrow(/timed out/);
  });

  it('rejects an empty completion instead of treating it as an answer', async () => {
    const fetchImpl = vi.fn(async () => jsonResponse(200, { choices: [{ message: { content: '' } }] }));
    const { c } = client(fetchImpl as unknown as typeof fetch);
    await expect(c.complete([{ role: 'user', content: 'x' }])).rejects.toThrow(/empty completion/);
  });
});
