import fs from 'node:fs';
import path from 'node:path';

export type AccessMode = 'read' | 'write' | 'execute';
/** The LLM-driven agent is restricted further than the supervisor's own bookkeeping. */
export type Actor = 'agent' | 'supervisor';

export class ScopeViolation extends Error {
  constructor(message: string, readonly requestedPath: string) {
    super(message);
    this.name = 'ScopeViolation';
  }
}

export interface ScopeGuardOptions {
  workspaceDir: string;
  aiHomeDir: string;
  deniedRoots: readonly string[];
  /** Workspace-relative prefixes the AGENT may never write: its own guardrails, git internals, runtime state. */
  protectedWritePrefixes?: readonly string[];
}

export const DEFAULT_PROTECTED_WRITE_PREFIXES = ['.git', 'ops/lunex-ai', '.ai', 'node_modules', '.github', 'dist'] as const;

const SECRET_FILE_NAME = /(^id_(rsa|dsa|ecdsa|ed25519)$)|\.(pem|key|p12|pfx|keystore|jks)$/i;

export function isEnvFileName(base: string): boolean {
  const lower = base.toLowerCase();
  return (lower === '.env' || lower.startsWith('.env.') || lower.endsWith('.env')) && lower !== '.env.example';
}

function norm(p: string): string {
  return process.platform === 'win32' ? p.toLowerCase() : p;
}

function isInside(child: string, parent: string): boolean {
  const rel = path.relative(norm(parent), norm(child));
  return rel === '' || (!rel.startsWith('..') && !path.isAbsolute(rel));
}

/**
 * Resolves symlinks on the longest EXISTING ancestor, then re-appends the
 * not-yet-existing tail. A write to `workspace/link-to-prod/new-file` is
 * therefore judged by where `link-to-prod` really points, even though
 * `new-file` does not exist yet.
 */
export function realResolve(p: string): string {
  const abs = path.resolve(p);
  let existing = abs;
  const rest: string[] = [];
  while (!fs.existsSync(existing)) {
    const parent = path.dirname(existing);
    if (parent === existing) break;
    rest.unshift(path.basename(existing));
    existing = parent;
  }
  let real = existing;
  try {
    real = fs.realpathSync.native(existing);
  } catch {
    // unreadable ancestor: judge the lexical path (still subject to every deny rule below)
  }
  return path.join(real, ...rest);
}

/**
 * Filesystem boundary enforced in code. Every agent file operation and
 * every command working directory goes through `check()` BEFORE any I/O.
 * Order: denied roots (lexical and real path) -> allowed roots -> secret
 * files -> write protections. Deny always wins.
 */
export class ScopeGuard {
  private readonly workspace: string;
  private readonly aiHome: string;
  private readonly denied: readonly string[];
  private readonly protectedPrefixes: readonly string[];

  constructor(options: ScopeGuardOptions) {
    this.workspace = realResolve(options.workspaceDir);
    this.aiHome = realResolve(options.aiHomeDir);
    this.denied = options.deniedRoots.flatMap((d) => [path.resolve(d), realResolve(d)]);
    this.protectedPrefixes = (options.protectedWritePrefixes ?? DEFAULT_PROTECTED_WRITE_PREFIXES).map((p) => path.join(this.workspace, p));
  }

  get workspaceDir(): string {
    return this.workspace;
  }

  /** Returns the resolved absolute path when allowed; throws ScopeViolation otherwise. Relative paths are relative to the workspace. */
  check(requested: string, mode: AccessMode, actor: Actor = 'agent'): string {
    if (requested.includes('\0')) throw new ScopeViolation('path contains a NUL byte', requested);
    const lexical = path.resolve(this.workspace, requested);
    const real = realResolve(lexical);

    for (const d of this.denied) {
      if (isInside(lexical, d) || isInside(real, d)) {
        throw new ScopeViolation(`access to ${d} is forbidden for the Lunex AI supervisor`, requested);
      }
    }

    const inWorkspace = isInside(real, this.workspace);
    const inAiHome = isInside(real, this.aiHome);
    if (!inWorkspace && !inAiHome) {
      throw new ScopeViolation('path is outside the Lunex workspace and the Lunex AI home', requested);
    }

    const base = path.basename(real);
    if (isEnvFileName(base)) throw new ScopeViolation('.env files are never read or written (secrets)', requested);
    if (SECRET_FILE_NAME.test(base)) throw new ScopeViolation('key/certificate files are never read or written', requested);

    if (mode === 'execute' && !inWorkspace) {
      throw new ScopeViolation('commands may only run inside the Lunex workspace', requested);
    }

    if (mode === 'write' && actor === 'agent') {
      if (!inWorkspace) throw new ScopeViolation('the agent may only write inside the Lunex workspace', requested);
      if (real === this.workspace) throw new ScopeViolation('the workspace root itself is not writable', requested);
      for (const prefix of this.protectedPrefixes) {
        if (isInside(real, prefix)) {
          throw new ScopeViolation(`${path.relative(this.workspace, prefix)} is protected from agent writes`, requested);
        }
      }
    }

    return real;
  }

  /** Non-throwing variant for filters (e.g. search results). */
  isAllowed(requested: string, mode: AccessMode, actor: Actor = 'agent'): boolean {
    try {
      this.check(requested, mode, actor);
      return true;
    } catch {
      return false;
    }
  }

  /** Workspace-relative, forward-slash form -- for reports and prompts. */
  relative(absPath: string): string {
    return path.relative(this.workspace, absPath).split(path.sep).join('/');
  }
}
