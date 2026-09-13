import { ConfigError, loadConfig } from '../config';
import type { SupervisorConfig } from '../config';
import { collectSecretValues, createMasker } from '../secretMask';
import { TelegramHttpApi } from '../telegram/botApi';

/**
 * Deployment check: confirms the configured token belongs to a reachable bot
 * and that no webhook is set (a webhook makes getUpdates polling fail).
 * Prints the bot's public username only -- never the token. Sends no message.
 * Exit 0 = ready for polling.
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

  const api = new TelegramHttpApi(config.telegramBotToken, mask);
  try {
    const me = await api.getMe();
    const webhook = await api.getWebhookInfo();
    const webhookSet = webhook.url !== '';
    print({
      ok: me.is_bot && !webhookSet,
      botUsername: me.username ?? null,
      isBot: me.is_bot,
      webhookSet,
      pendingUpdates: webhook.pending_update_count,
      adminIdsConfigured: config.telegramAdminIds.length,
    });
    process.exit(me.is_bot && !webhookSet ? 0 : 1);
  } catch (err) {
    print({ ok: false, stage: 'request', error: err instanceof Error ? err.message : String(err) });
    process.exit(1);
  }
}

main().catch((err: unknown) => {
  console.log(createMasker(collectSecretValues(process.env))(JSON.stringify({ ok: false, stage: 'fatal', error: err instanceof Error ? err.message : String(err) })));
  process.exit(1);
});
