import type { Logger } from '../logger';
import { PRIORITIES } from '../stateStore';
import type { Priority, Task } from '../stateStore';
import type { SupervisorControl } from '../supervisor/supervisor';
import { classifyMessage, detectStrategyPermission, inferPriority } from './naturalLanguage';

export interface IncomingMessage {
  fromId: number | undefined;
  chatId: number;
  text: string;
}

export interface CommandHandlerDeps {
  control: SupervisorControl;
  adminIds: readonly number[];
  logger: Logger;
  replyToUnauthorized: boolean;
  /** For results of long-running commands (/test, /build) that finish after the immediate acknowledgement. */
  send: (chatId: number, text: string) => Promise<void>;
}

export const HELP_TEXT = `LUNEX AI -- development supervisor for Lunex only (never trades, never deploys).

/status -- current task, worker state, git, last checkpoint
/progress -- steps of the running task, recent results, checkpoints
/queue -- queued tasks
/task [P0-P4] [--allow-strategy] <description> -- queue a task
/continue -- resume, or pick the next highest-value safe task
/pause -- pause at the next safe point
/resume -- resume the worker
/stop -- stop the running task at the next safe point, then pause
/clear -- clear queued tasks
/test -- run the Lunex test suite
/build -- typecheck + lint + build
/diff -- uncommitted diff
/git -- branch, HEAD, recent commits
/log [n] -- last n supervisor log lines
/audit [scope] -- queue an audit task
/approve <taskId> -- merge a task blocked by the strategy guard
/restart -- restart the supervisor service

Plain messages also work, e.g.:
"Periksa semua failure path pada exit transaction dan perbaiki tanpa mengubah strategi."
"Lanjutkan pengembangan Lunex." / "Apa yang sedang kamu kerjakan?"

Strategy changes are refused unless you say so explicitly (--allow-strategy).`;

export function parseCommand(text: string): { command: string; args: string } | null {
  const match = /^\/([a-zA-Z_]+)(?:@\w+)?(?:\s+([\s\S]*))?$/.exec(text.trim());
  if (!match?.[1]) return null;
  return { command: match[1].toLowerCase(), args: (match[2] ?? '').trim() };
}

/** `/task P1 --allow-strategy fix X` -> priority, permission flag, text. */
export function parseTaskArgs(args: string): { text: string; priority: Priority; allowStrategyChange: boolean } {
  let rest = args.trim();
  let priority: Priority | null = null;
  let allow = false;
  for (;;) {
    const token = /^(\S+)\s*/.exec(rest)?.[1];
    if (token && (PRIORITIES as readonly string[]).includes(token.toUpperCase()) && priority === null) {
      priority = token.toUpperCase() as Priority;
    } else if (token === '--allow-strategy') {
      allow = true;
    } else {
      break;
    }
    rest = rest.slice(token.length).trim();
  }
  return { text: rest, priority: priority ?? inferPriority(rest), allowStrategyChange: allow || detectStrategyPermission(rest) };
}

function queuedText(task: Task, natural: boolean): string {
  return [
    `${natural ? 'Understood -- queued' : 'Queued'} ${task.id} [${task.priority}]`,
    task.title,
    task.allowStrategyChange ? 'Strategy changes: EXPLICITLY ALLOWED for this task.' : 'Strategy changes: not allowed.',
  ].join('\n');
}

function background(deps: CommandHandlerDeps, chatId: number, label: string, work: () => Promise<string>): string {
  void work()
    .then((text) => deps.send(chatId, text))
    .catch((err: unknown) => deps.send(chatId, `${label} could not run: ${err instanceof Error ? err.message : String(err)}`))
    .catch((err: unknown) => { deps.logger.error('telegram_send_failed', { message: err instanceof Error ? err.message : String(err) }); });
  return `${label} started. The result will follow.`;
}

/**
 * Authorization first, before any parsing: an update from a user id not in
 * TELEGRAM_ADMIN_ID never reaches a handler. By default it gets no reply at
 * all (same convention as Lunex's own bot: don't confirm to a stranger that
 * the bot exists); it is always logged.
 *
 * Returns the immediate reply, or null for "send nothing".
 */
export async function handleMessage(msg: IncomingMessage, deps: CommandHandlerDeps): Promise<string | null> {
  if (msg.fromId === undefined || !deps.adminIds.includes(msg.fromId)) {
    deps.logger.warn('telegram_unauthorized', { fromId: msg.fromId ?? null, chatId: msg.chatId });
    return deps.replyToUnauthorized ? 'Unauthorized.' : null;
  }
  const { control } = deps;
  const text = msg.text.trim();
  if (text === '') return null;
  deps.logger.info('telegram_command', { fromId: msg.fromId, text: text.slice(0, 200) });

  try {
    const parsed = parseCommand(text);
    if (parsed) {
      switch (parsed.command) {
        case 'start':
        case 'help':
          return HELP_TEXT;
        case 'status':
          return await control.status();
        case 'progress':
          return control.progress();
        case 'queue':
          return control.queueList();
        case 'task': {
          const args = parseTaskArgs(parsed.args);
          if (args.text === '') return 'Usage: /task [P0-P4] [--allow-strategy] <description>';
          return queuedText(control.addTask(args.text, 'telegram-command', { priority: args.priority, allowStrategyChange: args.allowStrategyChange }), false);
        }
        case 'continue':
          return control.continueWork();
        case 'pause':
          return control.pause();
        case 'resume':
          return control.resume();
        case 'stop':
          return control.stop();
        case 'clear':
          return control.clearQueue();
        case 'test':
          return background(deps, msg.chatId, 'Test run', () => control.runTests());
        case 'build':
          return background(deps, msg.chatId, 'Build', () => control.runBuild());
        case 'diff':
          return await control.diff();
        case 'git':
          return await control.gitInfo();
        case 'log': {
          const n = Number(parsed.args || '20');
          return control.log(Number.isInteger(n) ? n : 20);
        }
        case 'audit':
          return queuedText(control.audit(parsed.args), false);
        case 'approve':
          if (!/^T-[\w-]+$/.test(parsed.args)) return 'Usage: /approve <taskId>';
          return await control.approve(parsed.args);
        case 'restart':
          return control.restart();
        default:
          return 'Unknown command. Send /help.';
      }
    }

    const intent = classifyMessage(text);
    switch (intent.kind) {
      case 'status':
        return await control.status();
      case 'progress':
        return control.progress();
      case 'continue':
        return control.continueWork();
      case 'pause':
        return control.pause();
      case 'resume':
        return control.resume();
      case 'stop':
        return control.stop();
      case 'queue':
        return control.queueList();
      case 'test':
        return background(deps, msg.chatId, 'Test run', () => control.runTests());
      case 'build':
        return background(deps, msg.chatId, 'Build', () => control.runBuild());
      case 'task':
        return queuedText(control.addTask(intent.text, 'telegram-natural', { priority: intent.priority, allowStrategyChange: intent.allowStrategyChange }), true);
    }
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    deps.logger.error('telegram_command_failed', { message });
    return `Error: ${message}`;
  }
}
