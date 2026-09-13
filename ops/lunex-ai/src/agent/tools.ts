import fs from 'node:fs';
import path from 'node:path';
import { CommandRefused } from '../commandRunner';
import type { CommandRunner } from '../commandRunner';
import { ScopeViolation } from '../scopeGuard';
import type { ScopeGuard } from '../scopeGuard';
import type { Masker } from '../secretMask';
import type { AgentAction } from './actionParser';

export interface ToolResult {
  ok: boolean;
  output: string;
}

export interface AgentToolsContext {
  guard: ScopeGuard;
  runner: CommandRunner;
  mask: Masker;
  onCheckpoint: (phase: string, note: string) => void;
}

const MAX_READ_CHARS = 60_000;
const MAX_FILE_BYTES = 2_000_000;
const MAX_SEARCH_RESULTS = 200;
const MAX_RUN_OUTPUT = 20_000;
const SKIP_DIRS = new Set(['node_modules', '.git', 'dist', '.ai', 'coverage', 'data', 'test-results', 'playwright-report']);

function tail(text: string, max: number): string {
  return text.length > max ? `[...truncated...]\n${text.slice(text.length - max)}` : text;
}

/**
 * Executes one parsed agent action. EVERY filesystem path goes through the
 * scope guard before any I/O and EVERY command through the runner's
 * allowlist. A refusal is returned to the model as a normal tool result
 * ("REFUSED: ...") so it can adapt, and is logged by the caller -- it is
 * never retried with a weaker check.
 */
export class AgentTools {
  readonly writtenFiles = new Set<string>();

  constructor(private readonly ctx: AgentToolsContext) {}

  async execute(action: Exclude<AgentAction, { type: 'finish' }>): Promise<ToolResult> {
    try {
      switch (action.type) {
        case 'read_file':
          return this.readFile(action.path, action.startLine, action.endLine);
        case 'list_dir':
          return this.listDir(action.path);
        case 'search':
          return this.search(action.pattern, action.path ?? '.');
        case 'write_file':
          return this.writeFile(action.path, action.content);
        case 'replace_in_file':
          return this.replaceInFile(action.path, action.old, action.new);
        case 'run':
          return await this.run(action.program, action.args);
        case 'checkpoint':
          this.ctx.onCheckpoint(action.phase, action.note);
          return { ok: true, output: 'checkpoint saved' };
      }
    } catch (err) {
      if (err instanceof ScopeViolation || err instanceof CommandRefused) {
        return { ok: false, output: `REFUSED: ${this.ctx.mask(err.message)}` };
      }
      return { ok: false, output: `ERROR: ${this.ctx.mask(err instanceof Error ? err.message : String(err))}` };
    }
  }

  private readFile(requested: string, startLine?: number, endLine?: number): ToolResult {
    const abs = this.ctx.guard.check(requested, 'read');
    const stat = fs.statSync(abs);
    if (!stat.isFile()) return { ok: false, output: 'not a regular file' };
    if (stat.size > MAX_FILE_BYTES) return { ok: false, output: `file is ${String(stat.size)} bytes; too large to read` };
    const lines = fs.readFileSync(abs, 'utf8').split('\n');
    const from = Math.max(1, startLine ?? 1);
    const to = Math.min(lines.length, endLine ?? lines.length);
    const numbered = lines.slice(from - 1, to).map((l, i) => `${String(from + i)}\t${l}`).join('\n');
    const body = numbered.length > MAX_READ_CHARS ? `${numbered.slice(0, MAX_READ_CHARS)}\n[...truncated: request a smaller line range...]` : numbered;
    return { ok: true, output: this.ctx.mask(`${this.ctx.guard.relative(abs)} (lines ${String(from)}-${String(to)} of ${String(lines.length)})\n${body}`) };
  }

  private listDir(requested: string): ToolResult {
    const abs = this.ctx.guard.check(requested, 'read');
    const entries = fs.readdirSync(abs, { withFileTypes: true })
      .filter((e) => this.ctx.guard.isAllowed(path.join(abs, e.name), 'read'))
      .map((e) => (e.isDirectory() ? `${e.name}/` : e.isSymbolicLink() ? `${e.name}@` : e.name))
      .sort();
    return { ok: true, output: entries.join('\n') || '(empty)' };
  }

  private search(pattern: string, requested: string): ToolResult {
    let re: RegExp;
    try {
      re = new RegExp(pattern);
    } catch (err) {
      return { ok: false, output: `invalid regex: ${err instanceof Error ? err.message : String(err)}` };
    }
    const root = this.ctx.guard.check(requested, 'read');
    const results: string[] = [];
    const walk = (dir: string): void => {
      for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
        if (results.length >= MAX_SEARCH_RESULTS) return;
        if (entry.isSymbolicLink()) continue; // never follow links during a walk
        const full = path.join(dir, entry.name);
        if (entry.isDirectory()) {
          if (!SKIP_DIRS.has(entry.name) && this.ctx.guard.isAllowed(full, 'read')) walk(full);
        } else if (entry.isFile() && this.ctx.guard.isAllowed(full, 'read') && fs.statSync(full).size <= 1_000_000) {
          const lines = fs.readFileSync(full, 'utf8').split('\n');
          lines.forEach((line, i) => {
            if (results.length < MAX_SEARCH_RESULTS && re.test(line)) results.push(`${this.ctx.guard.relative(full)}:${String(i + 1)}: ${line.slice(0, 300)}`);
          });
        }
      }
    };
    if (fs.statSync(root).isDirectory()) walk(root);
    const suffix = results.length >= MAX_SEARCH_RESULTS ? `\n[...stopped at ${String(MAX_SEARCH_RESULTS)} matches...]` : '';
    return { ok: true, output: this.ctx.mask(results.length > 0 ? results.join('\n') + suffix : 'no matches') };
  }

  private writeFile(requested: string, content: string): ToolResult {
    const abs = this.ctx.guard.check(requested, 'write');
    fs.mkdirSync(path.dirname(abs), { recursive: true });
    fs.writeFileSync(abs, content);
    this.writtenFiles.add(this.ctx.guard.relative(abs));
    return { ok: true, output: `wrote ${this.ctx.guard.relative(abs)} (${String(content.length)} chars)` };
  }

  private replaceInFile(requested: string, oldText: string, newText: string): ToolResult {
    if (oldText === '') return { ok: false, output: 'old text must not be empty' };
    const abs = this.ctx.guard.check(requested, 'write');
    const current = fs.readFileSync(abs, 'utf8');
    const occurrences = current.split(oldText).length - 1;
    if (occurrences !== 1) return { ok: false, output: `old text must match exactly once; found ${String(occurrences)} matches` };
    fs.writeFileSync(abs, current.replace(oldText, () => newText));
    this.writtenFiles.add(this.ctx.guard.relative(abs));
    return { ok: true, output: `edited ${this.ctx.guard.relative(abs)}` };
  }

  private async run(program: string, args: string[]): Promise<ToolResult> {
    const result = await this.ctx.runner.run({ program, args });
    const header = `$ ${result.command}\nexit=${String(result.exitCode)}${result.timedOut ? ' TIMEOUT' : ''} (${String(result.durationMs)}ms)`;
    const body = tail(`${result.stdout}\n${result.stderr}`.trim(), MAX_RUN_OUTPUT);
    return { ok: result.exitCode === 0 && !result.timedOut, output: `${header}\n${body}` };
  }
}
