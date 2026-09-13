import { spawn } from 'node:child_process';
import type { ChildProcess, SpawnOptions } from 'node:child_process';
import { checkCommand } from './commandPolicy';
import type { CommandRequest } from './commandPolicy';
import type { ScopeGuard } from './scopeGuard';
import type { Masker } from './secretMask';

export interface CommandResult {
  /** Masked, human-readable form of the argv -- safe for logs and Telegram. */
  command: string;
  exitCode: number | null;
  stdout: string;
  stderr: string;
  timedOut: boolean;
  durationMs: number;
}

export class CommandRefused extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'CommandRefused';
  }
}

/**
 * Child processes never inherit the supervisor's environment: the Telegram
 * token and TokenRouter key live only in THIS process. Children get a
 * minimal allowlist plus test-mode flags, so a Lunex test or build can
 * never read those secrets, and nothing it spawns defaults to production.
 */
const ENV_PASSTHROUGH = ['PATH', 'HOME', 'LANG', 'LC_ALL', 'TZ', 'TMPDIR', 'TEMP', 'TMP', 'SystemRoot', 'ComSpec', 'PATHEXT', 'USERPROFILE', 'APPDATA', 'LOCALAPPDATA', 'npm_config_cache'];

export function buildChildEnv(parent: NodeJS.ProcessEnv): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = {};
  for (const key of ENV_PASSTHROUGH) {
    const value = parent[key];
    if (value !== undefined) env[key] = value;
  }
  env.CI = '1';
  env.NODE_ENV = 'test';
  env.NO_COLOR = '1';
  env.FORCE_COLOR = '0';
  env.GIT_TERMINAL_PROMPT = '0';
  env.GIT_CONFIG_NOSYSTEM = '1';
  return env;
}

const MAX_OUTPUT_CHARS = 200_000;
const WIN_SHELL_META = /[&|<>^%"!`]/;

function appendCapped(current: string, chunk: string): string {
  const next = current + chunk;
  return next.length > MAX_OUTPUT_CHARS ? `[...truncated...]\n${next.slice(next.length - MAX_OUTPUT_CHARS)}` : next;
}

export interface RunOptions {
  timeoutMs?: number;
  /**
   * Return stdout/stderr WITHOUT masking. Supervisor-internal only (the
   * pre-commit secret scan must see the real content to detect it); the
   * agent's tool path never sets this, and such output must never be logged,
   * sent to Telegram, or given to the model.
   */
  unmasked?: boolean;
}

export interface CommandRunnerOptions {
  guard: ScopeGuard;
  mask: Masker;
  timeoutMs: number;
  parentEnv?: NodeJS.ProcessEnv;
  /** Injectable for tests. */
  spawnImpl?: (command: string, args: readonly string[], options: SpawnOptions) => ChildProcess;
}

/**
 * The ONLY way the supervisor or the agent executes anything. Order of
 * checks, all before spawn: command allowlist -> every path argument through
 * the scope guard -> working directory is the workspace. Commands run one at
 * a time (a test run and a build must never race over the same files).
 */
export class CommandRunner {
  private tail: Promise<unknown> = Promise.resolve();

  constructor(private readonly options: CommandRunnerOptions) {}

  run(request: CommandRequest, runOptions: RunOptions = {}): Promise<CommandResult> {
    const decision = checkCommand(request);
    if (!decision.allowed) return Promise.reject(new CommandRefused(decision.reason));
    try {
      for (const p of decision.pathArgs) this.options.guard.check(p, 'read');
    } catch (err) {
      return Promise.reject(err instanceof Error ? err : new Error(String(err)));
    }
    const cwd = this.options.guard.check('.', 'execute', 'supervisor');
    if (process.platform === 'win32' && request.program !== 'git' && request.args.some((a) => WIN_SHELL_META.test(a))) {
      return Promise.reject(new CommandRefused('shell metacharacters are not allowed in npm/npx arguments on Windows'));
    }

    const next = this.tail.then(() => this.exec(request, cwd, runOptions.timeoutMs ?? this.options.timeoutMs, runOptions.unmasked === true));
    this.tail = next.catch(() => undefined);
    return next;
  }

  private exec(request: CommandRequest, cwd: string, timeoutMs: number, unmasked: boolean): Promise<CommandResult> {
    const { mask } = this.options;
    const outputMask = unmasked ? (text: string): string => text : mask;
    const spawnImpl = this.options.spawnImpl ?? spawn;
    const command = mask([request.program, ...request.args].join(' '));
    const started = Date.now();
    // npm/npx are .cmd shims on Windows and cannot be spawned without a shell;
    // arguments were already screened for shell metacharacters above. On
    // Linux (the VPS) no shell is ever involved.
    const useShell = process.platform === 'win32' && request.program !== 'git';
    const detached = process.platform !== 'win32';

    return new Promise<CommandResult>((resolve) => {
      let stdout = '';
      let stderr = '';
      let timedOut = false;
      let settled = false;
      let child: ChildProcess;
      try {
        child = spawnImpl(request.program, request.args, {
          cwd,
          env: buildChildEnv(this.options.parentEnv ?? process.env),
          shell: useShell,
          windowsHide: true,
          detached,
          stdio: ['ignore', 'pipe', 'pipe'],
        });
      } catch (err) {
        resolve({ command, exitCode: null, stdout: '', stderr: mask(err instanceof Error ? err.message : String(err)), timedOut: false, durationMs: Date.now() - started });
        return;
      }

      const killTree = (signal: NodeJS.Signals): void => {
        try {
          if (detached && child.pid !== undefined) process.kill(-child.pid, signal);
          else child.kill(signal);
        } catch {
          // already exited
        }
      };
      const timer = setTimeout(() => {
        timedOut = true;
        killTree('SIGTERM');
        setTimeout(() => { killTree('SIGKILL'); }, 5000).unref();
      }, timeoutMs);

      child.stdout?.on('data', (chunk: Buffer) => { stdout = appendCapped(stdout, chunk.toString('utf8')); });
      child.stderr?.on('data', (chunk: Buffer) => { stderr = appendCapped(stderr, chunk.toString('utf8')); });

      const finish = (exitCode: number | null, extraErr?: string): void => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        resolve({
          command,
          exitCode,
          stdout: outputMask(stdout),
          stderr: outputMask(extraErr ? `${stderr}\n${extraErr}` : stderr),
          timedOut,
          durationMs: Date.now() - started,
        });
      };
      child.on('error', (err) => { finish(null, err.message); });
      child.on('close', (code) => { finish(code); });
    });
  }
}
