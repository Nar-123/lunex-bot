import { ConfigError, loadConfig } from '../config';
import type { SupervisorConfig } from '../config';
import { LlmError, TokenRouterClient } from '../llm/tokenRouterClient';
import { collectSecretValues, createMasker } from '../secretMask';

/**
 * Deployment check: ONE tiny chat completion against TokenRouter with the
 * configured model, using the same client the supervisor uses. Prints only
 * non-secret facts: base URL, model, HTTP status, latency, token counts and a
 * short preview of the reply. Exit 0 = the model answered.
 */
async function main(): Promise<void> {
  const mask = createMasker(collectSecretValues(process.env));
  const print = (data: Record<string, unknown>): void => { console.log(mask(JSON.stringify(data))); };
  let config: SupervisorConfig;
  try {
    config = loadConfig();
  } catch (err) {
    print({ ok: false, stage: 'config', error: err instanceof ConfigError ? err.message : 'unexpected configuration error' });
    process.exit(2);
  }

  const client = new TokenRouterClient({ baseUrl: config.tokenRouterBaseUrl, apiKey: config.tokenRouterApiKey, model: config.model, timeoutMs: 90_000, mask, maxRetries: 1 });
  const started = Date.now();
  try {
    const completion = await client.complete([{ role: 'user', content: 'Reply with exactly the word OK and nothing else.' }]);
    print({
      ok: true,
      baseUrl: config.tokenRouterBaseUrl,
      model: config.model,
      latencyMs: Date.now() - started,
      replyPreview: completion.content.trim().slice(0, 40),
      promptTokens: completion.promptTokens,
      completionTokens: completion.completionTokens,
    });
    process.exit(0);
  } catch (err) {
    print({
      ok: false,
      stage: 'request',
      baseUrl: config.tokenRouterBaseUrl,
      model: config.model,
      latencyMs: Date.now() - started,
      status: err instanceof LlmError ? err.status : null,
      error: err instanceof Error ? err.message : String(err),
    });
    process.exit(1);
  }
}

main().catch((err: unknown) => {
  console.log(createMasker(collectSecretValues(process.env))(JSON.stringify({ ok: false, stage: 'fatal', error: err instanceof Error ? err.message : String(err) })));
  process.exit(1);
});
