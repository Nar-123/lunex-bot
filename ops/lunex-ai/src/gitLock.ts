import fs from 'node:fs';
import path from 'node:path';

export interface ProcInfo {
  pid: number;
  comm: string;
  /** Resolved working directory, or null when it cannot be read (e.g. another user's process). */
  cwd: string | null;
}

export interface StaleLockResult {
  action: 'none' | 'removed' | 'kept';
  detail: string;
}

export const GIT_LOCK_FILES = ['index.lock', 'HEAD.lock'] as const;

export function listLinuxProcesses(procRoot = '/proc'): ProcInfo[] {
  const out: ProcInfo[] = [];
  let entries: string[];
  try {
    entries = fs.readdirSync(procRoot);
  } catch {
    return out;
  }
  for (const entry of entries) {
    if (!/^\d+$/.test(entry)) continue;
    let comm: string;
    try {
      comm = fs.readFileSync(path.join(procRoot, entry, 'comm'), 'utf8').trim();
    } catch {
      continue; // process exited
    }
    let cwd: string | null = null;
    try {
      cwd = fs.readlinkSync(path.join(procRoot, entry, 'cwd'));
    } catch {
      cwd = null;
    }
    out.push({ pid: Number(entry), comm, cwd });
  }
  return out;
}

function isInside(child: string, parent: string): boolean {
  const rel = path.relative(path.resolve(parent), path.resolve(child));
  return rel === '' || (!rel.startsWith('..') && !path.isAbsolute(rel));
}

export interface ClearStaleGitLocksOptions {
  platform?: NodeJS.Platform;
  processes?: () => ProcInfo[];
  selfPid?: number;
}

/**
 * A SIGKILL or power loss during `git add`/`git commit` leaves `.git/index.lock`
 * (or `HEAD.lock`) behind, and every later git command fails until it is gone --
 * the supervisor would block every task after a crash.
 *
 * At startup the previous supervisor instance and all of its children are
 * dead (systemd KillMode=control-group), so a lock is stale UNLESS another git
 * process is working in this repository, e.g. an operator's manual command.
 * Conservative by design: a git process whose working directory cannot be read,
 * or a platform where processes cannot be inspected, keeps the lock and reports it.
 */
export function clearStaleGitLocks(workspaceDir: string, options: ClearStaleGitLocksOptions = {}): StaleLockResult {
  const present = GIT_LOCK_FILES.map((name) => path.join(workspaceDir, '.git', name)).filter((file) => fs.existsSync(file));
  if (present.length === 0) return { action: 'none', detail: 'no git lock files' };
  const names = present.map((file) => path.basename(file)).join(', ');

  if ((options.platform ?? process.platform) !== 'linux') {
    return { action: 'kept', detail: `${names} present; process inspection unavailable on this platform -- remove it manually once no git command is running` };
  }
  const selfPid = options.selfPid ?? process.pid;
  const gitProcesses = (options.processes ?? listLinuxProcesses)().filter((p) => p.pid !== selfPid && (p.comm === 'git' || p.comm.startsWith('git-')));
  const blocking = gitProcesses.filter((p) => p.cwd === null || isInside(p.cwd, workspaceDir));
  if (blocking.length > 0) {
    return { action: 'kept', detail: `${names} present; git process(es) ${blocking.map((p) => String(p.pid)).join(', ')} may be using the repository` };
  }
  for (const file of present) fs.unlinkSync(file);
  return { action: 'removed', detail: `${names} removed (left by an interrupted git command; no git process was using the repository)` };
}
