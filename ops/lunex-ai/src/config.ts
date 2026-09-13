import path from 'node:path';

/**
 * Supervisor configuration, loaded ONLY from environment variables (the
 * systemd EnvironmentFile on the VPS). No credential has a default and no
 * error message ever includes a variable's value.
 */
export interface SupervisorConfig {
  telegramBotToken: string;
  telegramAdminIds: readonly number[];
  tokenRouterApiKey: string;
  tokenRouterBaseUrl: string;
  model: string;
  workspaceDir: string;
  aiHomeDir: string;
  stateDir: string;
  logsDir: string;
  reportsDir: string;
  /** Absolute roots the supervisor must never read, write or execute in. Deny always wins over allow. */
  deniedRoots: readonly string[];
  /** Branch every task branch is cut from and fast-forwarded into. Never pushed. */
  integrationBranch: string;
  maxAgentSteps: number;
  maxDebugRounds: number;
  commandTimeoutMs: number;
  llmTimeoutMs: number;
  autonomousIdle: boolean;
  idleTaskCooldownMs: number;
  maxSelfTasksPerDay: number;
  replyToUnauthorized: boolean;
}

export class ConfigError extends Error {}

/** Verified against docs.tokenrouter.io (OpenAI-compatible gateway). */
export const DEFAULT_TOKENROUTER_BASE_URL = 'https://api.tokenrouter.io/v1';
/** Requested by the operator. Not listed in TokenRouter's public docs -- UNVERIFIED until the first real call. */
export const DEFAULT_MODEL = 'z-ai/glm-5.3-free';
export const DEFAULT_WORKSPACE = '/opt/lunex/workspace/lunex';
export const DEFAULT_AI_HOME = '/opt/lunex/ai';
export const DEFAULT_DENIED_ROOTS = ['/opt/lunex/production', '/opt/lunex/trading', '/root'] as const;

function required(env: NodeJS.ProcessEnv, name: string): string {
  const value = env[name]?.trim();
  if (!value) throw new ConfigError(`${name} is required but not set`);
  return value;
}

function positiveInt(env: NodeJS.ProcessEnv, name: string, fallback: number): number {
  const raw = env[name]?.trim();
  if (!raw) return fallback;
  const n = Number(raw);
  if (!Number.isInteger(n) || n <= 0) throw new ConfigError(`${name} must be a positive integer`);
  return n;
}

function bool(env: NodeJS.ProcessEnv, name: string, fallback: boolean): boolean {
  const raw = env[name]?.trim().toLowerCase();
  if (!raw) return fallback;
  if (raw === 'true' || raw === '1') return true;
  if (raw === 'false' || raw === '0') return false;
  throw new ConfigError(`${name} must be true or false`);
}

export function parseAdminIds(raw: string): number[] {
  const ids = raw.split(',').map((s) => s.trim()).filter((s) => s !== '');
  if (ids.length === 0) throw new ConfigError('TELEGRAM_ADMIN_ID must contain at least one numeric Telegram user id');
  return ids.map((s) => {
    if (!/^\d{1,20}$/.test(s)) throw new ConfigError('TELEGRAM_ADMIN_ID must be a comma-separated list of numeric Telegram user ids');
    return Number(s);
  });
}

function isInside(child: string, parent: string): boolean {
  const rel = path.relative(parent, child);
  return rel === '' || (!rel.startsWith('..') && !path.isAbsolute(rel));
}

export function loadConfig(env: NodeJS.ProcessEnv = process.env): SupervisorConfig {
  const telegramBotToken = required(env, 'TELEGRAM_BOT_TOKEN');
  const telegramAdminIds = parseAdminIds(required(env, 'TELEGRAM_ADMIN_ID'));
  const tokenRouterApiKey = required(env, 'TOKENROUTER_API_KEY');

  const tokenRouterBaseUrl = (env.TOKENROUTER_BASE_URL?.trim() || DEFAULT_TOKENROUTER_BASE_URL).replace(/\/+$/, '');
  if (!/^https:\/\//.test(tokenRouterBaseUrl)) throw new ConfigError('TOKENROUTER_BASE_URL must be an https:// URL');

  const workspaceDir = path.resolve(env.LUNEX_AI_WORKSPACE?.trim() || DEFAULT_WORKSPACE);
  const aiHomeDir = path.resolve(env.LUNEX_AI_HOME?.trim() || DEFAULT_AI_HOME);
  const extraDenied = (env.LUNEX_AI_EXTRA_DENIED_PATHS ?? '').split(',').map((s) => s.trim()).filter(Boolean);
  const deniedRoots = [...DEFAULT_DENIED_ROOTS, ...extraDenied].map((p) => path.resolve(p));

  for (const denied of deniedRoots) {
    for (const [name, dir] of [['LUNEX_AI_WORKSPACE', workspaceDir], ['LUNEX_AI_HOME', aiHomeDir]] as const) {
      if (isInside(dir, denied) || isInside(denied, dir)) {
        throw new ConfigError(`${name} overlaps a denied path (${denied}) -- refusing to start`);
      }
    }
  }

  const stateBase = path.join(workspaceDir, '.ai');
  return {
    telegramBotToken,
    telegramAdminIds,
    tokenRouterApiKey,
    tokenRouterBaseUrl,
    model: env.LUNEX_AI_MODEL?.trim() || DEFAULT_MODEL,
    workspaceDir,
    aiHomeDir,
    stateDir: path.join(stateBase, 'state'),
    logsDir: path.join(stateBase, 'logs'),
    reportsDir: path.join(stateBase, 'reports'),
    deniedRoots,
    integrationBranch: env.LUNEX_AI_INTEGRATION_BRANCH?.trim() || 'ai/develop',
    maxAgentSteps: positiveInt(env, 'LUNEX_AI_MAX_AGENT_STEPS', 60),
    maxDebugRounds: positiveInt(env, 'LUNEX_AI_MAX_DEBUG_ROUNDS', 3),
    commandTimeoutMs: positiveInt(env, 'LUNEX_AI_COMMAND_TIMEOUT_MS', 15 * 60 * 1000),
    llmTimeoutMs: positiveInt(env, 'LUNEX_AI_LLM_TIMEOUT_MS', 5 * 60 * 1000),
    autonomousIdle: bool(env, 'LUNEX_AI_AUTONOMOUS_IDLE', true),
    idleTaskCooldownMs: positiveInt(env, 'LUNEX_AI_IDLE_TASK_COOLDOWN_MS', 30 * 60 * 1000),
    maxSelfTasksPerDay: positiveInt(env, 'LUNEX_AI_MAX_SELF_TASKS_PER_DAY', 10),
    replyToUnauthorized: bool(env, 'LUNEX_AI_REPLY_UNAUTHORIZED', false),
  };
}
