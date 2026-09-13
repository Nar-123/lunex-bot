import fs from 'node:fs';
import path from 'node:path';
import type { Masker } from './secretMask';

export type LogLevel = 'debug' | 'info' | 'warn' | 'error';

export interface Logger {
  debug(event: string, data?: Record<string, unknown>): void;
  info(event: string, data?: Record<string, unknown>): void;
  warn(event: string, data?: Record<string, unknown>): void;
  error(event: string, data?: Record<string, unknown>): void;
  /** Last `lines` log lines (already masked) -- backs Telegram /log. */
  tail(lines: number): string[];
}

function replacer(_key: string, value: unknown): unknown {
  if (typeof value === 'bigint') return value.toString();
  if (value instanceof Error) return { name: value.name, message: value.message };
  return value;
}

/**
 * Structured JSON-lines log, one file per UTC day under `.ai/logs/`, also
 * echoed to stdout for journald. Every line is masked AFTER serialization,
 * so a secret nested anywhere in `data` is still caught.
 */
export class JsonlLogger implements Logger {
  constructor(
    private readonly dir: string,
    private readonly mask: Masker,
    private readonly echo = true,
    private readonly now: () => Date = () => new Date(),
  ) {
    fs.mkdirSync(dir, { recursive: true });
  }

  private fileFor(date: Date): string {
    return path.join(this.dir, `supervisor-${date.toISOString().slice(0, 10)}.jsonl`);
  }

  private write(level: LogLevel, event: string, data: Record<string, unknown> = {}): void {
    const ts = this.now();
    let line: string;
    try {
      line = this.mask(JSON.stringify({ ts: ts.toISOString(), level, event, ...data }, replacer));
    } catch {
      line = this.mask(JSON.stringify({ ts: ts.toISOString(), level, event, note: 'unserializable log data' }));
    }
    try {
      fs.appendFileSync(this.fileFor(ts), `${line}\n`, { mode: 0o640 });
    } catch {
      // logging must never take the supervisor down; stdout still has it
    }
    if (this.echo) {
      if (level === 'error' || level === 'warn') console.error(line);
      else console.log(line);
    }
  }

  debug(event: string, data?: Record<string, unknown>): void { this.write('debug', event, data); }
  info(event: string, data?: Record<string, unknown>): void { this.write('info', event, data); }
  warn(event: string, data?: Record<string, unknown>): void { this.write('warn', event, data); }
  error(event: string, data?: Record<string, unknown>): void { this.write('error', event, data); }

  tail(lines: number): string[] {
    const today = this.now();
    const yesterday = new Date(today.getTime() - 24 * 60 * 60 * 1000);
    const collected: string[] = [];
    for (const date of [yesterday, today]) {
      const file = this.fileFor(date);
      if (fs.existsSync(file)) collected.push(...fs.readFileSync(file, 'utf8').split('\n').filter((l) => l !== ''));
    }
    return collected.slice(-lines).map((l) => this.mask(l));
  }
}
