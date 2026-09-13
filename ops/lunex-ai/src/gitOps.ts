import type { CommandResult, CommandRunner } from './commandRunner';

export interface GitSnapshot {
  branch: string | null;
  head: string | null;
  dirty: boolean;
  changedFiles: string[];
}

export class GitError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'GitError';
  }
}

export function slugify(text: string): string {
  const slug = text.toLowerCase().normalize('NFKD').replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 40).replace(/-+$/, '');
  return slug === '' ? 'task' : slug;
}

/** Parses `git status --porcelain -z`. Renames yield the NEW path (the old one follows as its own NUL field and is skipped). */
export function parsePorcelainZ(output: string): string[] {
  const fields = output.split('\0');
  const files: string[] = [];
  for (let i = 0; i < fields.length; i++) {
    const entry = fields[i];
    if (!entry || entry.length < 4) continue;
    const status = entry.slice(0, 2);
    files.push(entry.slice(3));
    if (status.includes('R') || status.includes('C')) i++;
  }
  return files;
}

/**
 * Git operations for the supervisor, all through the allowlisted
 * CommandRunner (so the same policy that constrains the agent constrains
 * the supervisor). Never pushes, never resets, never deletes a branch.
 *
 * Branch model: every task gets `ai/<slug>-<id>` cut from the integration
 * branch (default `ai/develop`). A task that passes verification AND the
 * strategy guard is fast-forwarded into the integration branch; anything
 * else stays on its own branch for the operator. Nothing reaches `main` or
 * a remote without a human.
 */
export class GitOps {
  constructor(private readonly runner: CommandRunner) {}

  private async git(args: string[], unmasked = false): Promise<CommandResult> {
    return this.runner.run({ program: 'git', args }, { unmasked });
  }

  private async gitOk(args: string[], unmasked = false): Promise<string> {
    const result = await this.git(args, unmasked);
    if (result.exitCode !== 0) {
      throw new GitError(`git ${args.join(' ')} failed (exit ${String(result.exitCode)}): ${result.stderr.trim().slice(0, 600)}`);
    }
    return result.stdout;
  }

  async snapshot(): Promise<GitSnapshot> {
    const [branch, head, status] = await Promise.all([
      this.git(['rev-parse', '--abbrev-ref', 'HEAD']),
      this.git(['rev-parse', 'HEAD']),
      this.git(['status', '--porcelain', '-z']),
    ]);
    const changedFiles = status.exitCode === 0 ? parsePorcelainZ(status.stdout) : [];
    return {
      branch: branch.exitCode === 0 ? branch.stdout.trim() : null,
      head: head.exitCode === 0 ? head.stdout.trim() : null,
      dirty: changedFiles.length > 0,
      changedFiles,
    };
  }

  async branchExists(name: string): Promise<boolean> {
    const result = await this.git(['rev-parse', '--verify', '--quiet', `refs/heads/${name}`]);
    return result.exitCode === 0;
  }

  async ensureIntegrationBranch(name: string): Promise<void> {
    if (await this.branchExists(name)) {
      await this.gitOk(['checkout', name]);
    } else {
      await this.gitOk(['checkout', '-b', name]);
    }
  }

  /** Cuts a fresh task branch from the integration branch. Refuses to start on a dirty tree -- uncommitted work is never discarded or carried silently into another task. */
  async startTaskBranch(taskId: string, title: string, integrationBranch: string): Promise<string> {
    const snap = await this.snapshot();
    if (snap.dirty) {
      throw new GitError(`working tree has uncommitted changes (${snap.changedFiles.slice(0, 10).join(', ')}) -- refusing to start a new task branch`);
    }
    await this.ensureIntegrationBranch(integrationBranch);
    const name = `ai/${slugify(title)}-${taskId.slice(-4).toLowerCase()}`;
    if (await this.branchExists(name)) {
      await this.gitOk(['checkout', name]);
    } else {
      await this.gitOk(['checkout', '-b', name]);
    }
    return name;
  }

  async checkout(branch: string): Promise<void> {
    await this.gitOk(['checkout', branch]);
  }

  async stageAll(): Promise<void> {
    await this.gitOk(['add', '-A']);
  }

  /** Paths currently staged (after stageAll). */
  async stagedFiles(): Promise<string[]> {
    return (await this.gitOk(['diff', '--cached', '--name-only'])).split('\n').map((l) => l.trim()).filter(Boolean);
  }

  /**
   * Only the ADDED lines of the staged diff, UNMASKED -- the input to the
   * pre-commit secret scan, which compares it against its masked form. Masked
   * output would always compare equal and let secrets through. Never log,
   * report, or hand this string to the model.
   */
  async stagedAddedLines(): Promise<string> {
    const diff = await this.gitOk(['diff', '--cached', '--unified=0'], true);
    return diff.split('\n').filter((l) => l.startsWith('+') && !l.startsWith('+++')).map((l) => l.slice(1)).join('\n');
  }

  async commitStaged(message: string): Promise<string> {
    await this.gitOk(['commit', '-m', message]);
    return (await this.gitOk(['rev-parse', 'HEAD'])).trim();
  }

  async fastForward(integrationBranch: string, taskBranch: string): Promise<void> {
    await this.gitOk(['checkout', integrationBranch]);
    await this.gitOk(['merge', '--ff-only', taskBranch]);
  }

  async diffStat(): Promise<string> {
    return (await this.gitOk(['diff', '--stat', 'HEAD'])).trim();
  }

  async diff(maxChars: number): Promise<string> {
    const out = await this.gitOk(['diff', 'HEAD']);
    return out.length > maxChars ? `${out.slice(0, maxChars)}\n[...diff truncated...]` : out;
  }

  async logOneline(count: number): Promise<string> {
    return (await this.gitOk(['log', '--oneline', `-${String(count)}`])).trim();
  }
}
