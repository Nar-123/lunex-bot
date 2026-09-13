import fs from 'node:fs';
import { CommandRunner } from './commandRunner';
import { ConfigError, loadConfig } from './config';
import type { SupervisorConfig } from './config';
import { GitOps } from './gitOps';
import { TokenRouterClient } from './llm/tokenRouterClient';
import { JsonlLogger } from './logger';
import { recoverOnStartup } from './recovery';
import { ScopeGuard } from './scopeGuard';
import { collectSecretValues, createMasker } from './secretMask';
import { StateStore } from './stateStore';
import { Supervisor } from './supervisor/supervisor';
import { TaskQueue } from './taskQueue';
import { TelegramHttpApi } from './telegram/botApi';
import { TelegramControlBot } from './telegram/bot';

const SHUTDOWN_WAIT_MS = 50_000; // below systemd TimeoutStopSec=60

async function main(): Promise<void> {
  let config: SupervisorConfig;
  try {
    config = loadConfig();
  } catch (err) {
    // ConfigError messages name variables, never their values.
    console.error(`[lunex-ai] configuration error: ${err instanceof ConfigError ? err.message : 'unexpected error while loading configuration'}`);
    process.exit(2);
  }

  const mask = createMasker(collectSecretValues(process.env));
  const guard = new ScopeGuard({ workspaceDir: config.workspaceDir, aiHomeDir: config.aiHomeDir, deniedRoots: config.deniedRoots });
  if (!fs.existsSync(`${config.workspaceDir}/.git`)) {
    console.error('[lunex-ai] LUNEX_AI_WORKSPACE is not a git repository -- refusing to start');
    process.exit(2);
  }
  for (const dir of [config.stateDir, config.logsDir, config.reportsDir]) {
    fs.mkdirSync(guard.check(dir, 'write', 'supervisor'), { recursive: true, mode: 0o750 });
  }

  const logger = new JsonlLogger(config.logsDir, mask);
  const store = new StateStore(config.stateDir, undefined, (file, movedTo) => { logger.error('state_file_corrupt', { file, movedTo }); });
  const queue = new TaskQueue(store);
  const runner = new CommandRunner({ guard, mask, timeoutMs: config.commandTimeoutMs });
  const git = new GitOps(runner);
  const llm = new TokenRouterClient({ baseUrl: config.tokenRouterBaseUrl, apiKey: config.tokenRouterApiKey, model: config.model, timeoutMs: config.llmTimeoutMs, mask });
  const api = new TelegramHttpApi(config.telegramBotToken, mask);

  const botRef: { current: TelegramControlBot | null } = { current: null };
  const supervisor = new Supervisor({
    config,
    store,
    queue,
    git,
    runner,
    guard,
    llm,
    logger,
    mask,
    notifyText: async (text) => { await botRef.current?.notify(text); },
  });

  const recovery = await recoverOnStartup({ store, queue, snapshotGit: () => git.snapshot(), logger });
  const bot = new TelegramControlBot(api, store, { control: supervisor, adminIds: config.telegramAdminIds, logger, replyToUnauthorized: config.replyToUnauthorized }, logger);
  botRef.current = bot;

  logger.info('supervisor_started', {
    model: config.model,
    workspace: config.workspaceDir,
    integrationBranch: config.integrationBranch,
    recoveredTaskId: recovery.recoveredTask?.id ?? null,
    admins: config.telegramAdminIds.length,
  });
  await bot.notify(`LUNEX AI online.\nRecovery: ${recovery.note}\nModel: ${config.model} via TokenRouter\nSend /status or /help.`);

  const botRun = bot.run();
  const workerRun = supervisor.runWorker();

  let shuttingDown = false;
  const shutdown = async (reason: string, exitCode: number): Promise<void> => {
    if (shuttingDown) return;
    shuttingDown = true;
    logger.info('shutdown_started', { reason });
    bot.stop();
    supervisor.shutdown();
    const finished = await Promise.race([workerRun.then(() => true), new Promise<boolean>((resolve) => setTimeout(() => { resolve(false); }, SHUTDOWN_WAIT_MS))]);
    if (!finished) logger.warn('shutdown_task_still_running', { note: 'current_task stays "running"; recovery re-queues it on next start' });
    await bot.notify(`LUNEX AI going offline: ${reason}`).catch(() => undefined);
    logger.info('shutdown_complete', { reason });
    process.exit(exitCode);
  };

  supervisor.onRestartRequested = () => { void shutdown('restart requested via Telegram', 0); };
  process.on('SIGTERM', () => { void shutdown('SIGTERM', 0); });
  process.on('SIGINT', () => { void shutdown('SIGINT', 0); });
  process.on('unhandledRejection', (reason) => { logger.error('unhandled_rejection', { message: reason instanceof Error ? reason.message : String(reason) }); });
  process.on('uncaughtException', (err) => {
    logger.error('uncaught_exception', { message: err.message });
    void shutdown('uncaught exception', 1);
  });

  await Promise.all([botRun, workerRun]);
}

main().catch((err: unknown) => {
  const message = err instanceof Error ? err.message : String(err);
  console.error(`[lunex-ai] fatal: ${createMasker(collectSecretValues(process.env))(message)}`);
  process.exit(1);
});
