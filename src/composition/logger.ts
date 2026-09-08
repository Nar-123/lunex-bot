import { appendFileSync, mkdirSync } from 'node:fs';
import path from 'node:path';

/**
 * Minimal structured logging -- explicitly requested (Module 9B review) so
 * the bot isn't "blind" during the testing period before Telegram/UI exist
 * (Alert Push is fully on-demand per spec, `/status` doesn't exist yet).
 * Deliberately simple: console output (visible in any terminal/process
 * manager) plus a newline-delimited-JSON file, per line "boleh sederhana"
 * -- no log rotation, no external logging service, no configurable
 * transports. One line per event, structured, so an ad-hoc `grep`/`jq`
 * over the log file is enough to answer "what happened" during manual
 * testing.
 */
export interface Logger {
  info(event: string, data?: Record<string, unknown>): void;
  warn(event: string, data?: Record<string, unknown>): void;
  error(event: string, data?: Record<string, unknown>): void;
}

function jsonReplacer(_key: string, value: unknown): unknown {
  // JSON.stringify throws on a bare BigInt -- USDG raw amounts are BigInt everywhere in this codebase, so log data routinely contains them.
  return typeof value === 'bigint' ? value.toString() : value;
}

export interface ConsoleFileLoggerOptions {
  logDir?: string;
  logFileName?: string;
}

/**
 * Real implementation. Never lets a logging failure crash the bot -- if
 * the file write fails (disk full, permissions, directory missing and
 * uncreatable), the console line has already been written; the file
 * write is best-effort on top of that, not the primary channel.
 */
export function createConsoleFileLogger(options: ConsoleFileLoggerOptions = {}): Logger {
  const logDir = options.logDir ?? path.resolve(process.cwd(), 'logs');
  const logFile = path.join(logDir, options.logFileName ?? 'lunex-bot.log');

  function write(level: 'info' | 'warn' | 'error', event: string, data: Record<string, unknown>): void {
    const line = JSON.stringify({ ts: new Date().toISOString(), level, event, ...data }, jsonReplacer);
    if (level === 'error') console.error(line);
    else console.log(line);
    try {
      mkdirSync(logDir, { recursive: true });
      appendFileSync(logFile, line + '\n');
    } catch {
      // Deliberately swallowed -- see doc comment above.
    }
  }

  return {
    info: (event, data = {}) => write('info', event, data),
    warn: (event, data = {}) => write('warn', event, data),
    error: (event, data = {}) => write('error', event, data),
  };
}

/** Test/smoke-test double: captures lines in memory instead of writing to disk, so tests can assert on what was logged without a filesystem side effect. */
export function createInMemoryLogger(): Logger & { lines: Array<{ level: string; event: string; data: Record<string, unknown> }> } {
  const lines: Array<{ level: string; event: string; data: Record<string, unknown> }> = [];
  return {
    lines,
    info: (event, data = {}) => lines.push({ level: 'info', event, data }),
    warn: (event, data = {}) => lines.push({ level: 'warn', event, data }),
    error: (event, data = {}) => lines.push({ level: 'error', event, data }),
  };
}
