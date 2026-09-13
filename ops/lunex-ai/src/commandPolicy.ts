/**
 * Command allowlist, enforced in code. Commands are argv arrays executed
 * WITHOUT a shell, so no quoting, globbing, pipes, `;`, `&&` or
 * substitution can ever smuggle a second command. Anything not explicitly
 * allowed here is refused -- including `node` (would reach
 * `dist/validate-live.js` / the trading bot), `npm start`, installs, and
 * every git operation that rewrites history or talks to a remote.
 */
export interface CommandRequest {
  program: string;
  args: readonly string[];
}

export type PolicyDecision =
  | { allowed: true; /** args the caller must scope-check as workspace paths */ pathArgs: string[] }
  | { allowed: false; reason: string };

export const ALLOWED_NPM_SCRIPTS = new Set([
  'typecheck',
  'typecheck:ui',
  'lint',
  'test',
  'build',
  'build:ui',
  'prisma:generate',
  'ai:typecheck',
  'ai:lint',
  'ai:test',
  'ai:build',
]);

const BRANCH_NAME = /^[A-Za-z0-9][A-Za-z0-9._/-]{0,120}$/;

const deny = (reason: string): PolicyDecision => ({ allowed: false, reason });
const allow = (pathArgs: string[] = []): PolicyDecision => ({ allowed: true, pathArgs });

function isValidBranch(name: string | undefined): name is string {
  return name !== undefined && BRANCH_NAME.test(name) && !name.includes('..') && !name.endsWith('/') && !name.endsWith('.lock');
}

function checkGit(args: readonly string[]): PolicyDecision {
  const [sub, ...rest] = args;
  if (sub === undefined) return deny('git requires a subcommand');
  // Global options (-c, -C, --git-dir, --work-tree, --exec-path...) can redirect git anywhere or inject config.
  if (sub.startsWith('-')) return deny('git global options are not allowed');
  const dangerous = rest.find((a) => /^--(output|ext-diff|upload-pack|receive-pack|exec|git-dir|work-tree)(=|$)/.test(a));
  if (dangerous) return deny(`git option ${dangerous} is not allowed`);

  switch (sub) {
    case 'status':
    case 'log':
    case 'show':
    case 'rev-parse':
    case 'ls-files':
    case 'shortlog':
      return allow();
    case 'diff':
      return allow(rest.filter((a) => !a.startsWith('-') && a !== 'HEAD' && !/^[0-9a-f]{7,40}$/.test(a) && !a.includes('..')));
    case 'branch': {
      if (rest.some((a) => ['-d', '-D', '--delete', '-m', '-M', '--move', '-f', '--force', '-c', '-C', '--copy', '-u', '--set-upstream-to', '--unset-upstream', '--edit-description'].includes(a))) {
        return deny('git branch may only list or create ai/* branches');
      }
      const names = rest.filter((a) => !a.startsWith('-'));
      if (names.length === 0) return allow();
      if (names.length === 1 && names[0]?.startsWith('ai/') && isValidBranch(names[0])) return allow();
      return deny('new branches must be named ai/<topic>');
    }
    case 'checkout':
    case 'switch': {
      if (rest.some((a) => ['-f', '--force', '-B', '-C', '--', '.', '--orphan', '--detach', '-p', '--patch', '--ours', '--theirs'].includes(a))) {
        return deny(`git ${sub} may only switch branches or create ai/* branches (no force, no path checkout)`);
      }
      const createFlag = sub === 'checkout' ? '-b' : '-c';
      if (rest[0] === createFlag) {
        return rest.length === 2 && rest[1]?.startsWith('ai/') && isValidBranch(rest[1]) ? allow() : deny('new branches must be named ai/<topic>');
      }
      return rest.length === 1 && isValidBranch(rest[0]) ? allow() : deny(`git ${sub} takes exactly one branch name`);
    }
    case 'add': {
      if (rest.some((a) => a === '-f' || a === '--force' || a.startsWith('--chmod'))) return deny('git add --force is not allowed (it would stage ignored secret files)');
      const paths = rest.filter((a) => !a.startsWith('-'));
      if (paths.length === 0 && !rest.includes('-A') && !rest.includes('--all')) return deny('git add needs paths or -A');
      return allow(paths);
    }
    case 'commit': {
      if (rest.some((a) => ['--amend', '--no-verify', '-n', '--no-gpg-sign', '--allow-empty', '--fixup', '--squash', '-C', '-c', '--reuse-message', '--reedit-message'].includes(a) || a.startsWith('--author') || a.startsWith('--date'))) {
        return deny('git commit may not amend, skip hooks/signing, or rewrite authorship');
      }
      if (!rest.includes('-m') && !rest.includes('-F')) return deny('git commit requires -m or -F');
      return allow();
    }
    case 'merge':
      return rest.length === 2 && rest[0] === '--ff-only' && isValidBranch(rest[1]) ? allow() : deny('git merge is only allowed as --ff-only <branch>');
    case 'stash':
      return rest.length === 1 && rest[0] === 'list' ? allow() : deny('only git stash list is allowed');
    default:
      return deny(`git ${sub} is not allowed (no push/pull/fetch/reset/clean/rebase/remote/config/tag)`);
  }
}

function checkNpm(args: readonly string[]): PolicyDecision {
  if (args[0] !== 'run') return deny('only `npm run <script>` is allowed (no install/ci/exec/publish/start)');
  const script = args[1];
  if (script === undefined || !ALLOWED_NPM_SCRIPTS.has(script)) {
    return deny(`npm script ${script ?? '(none)'} is not allowed; allowed: ${[...ALLOWED_NPM_SCRIPTS].join(', ')}`);
  }
  const extra = args.slice(2);
  if (extra.length === 0) return allow();
  if (extra[0] !== '--' || (script !== 'test' && script !== 'ai:test')) return deny('extra arguments are only allowed for test scripts, after --');
  const passThrough = extra.slice(1);
  if (passThrough.some((a) => a.startsWith('-') && !/^--(reporter=[a-z-]+|silent)$/.test(a))) return deny('only --reporter=<name> and --silent may be passed to tests');
  return allow(passThrough.filter((a) => !a.startsWith('-')));
}

function checkNpx(args: readonly string[]): PolicyDecision {
  if (args.some((a) => a === '-y' || a === '--yes' || a.startsWith('--package') || a === '-p' && args[0] !== 'tsc')) {
    return deny('npx may not install packages');
  }
  const [tool, ...rest] = args;
  switch (tool) {
    case 'vitest': {
      if (rest[0] !== 'run') return deny('only `npx vitest run` is allowed (watch mode never exits)');
      const opts = rest.slice(1).filter((a) => a.startsWith('-'));
      if (opts.some((a) => !/^--(reporter=[a-z-]+|silent|config=[\w./-]+)$/.test(a))) return deny('unsupported vitest option');
      return allow(rest.slice(1).filter((a) => !a.startsWith('-')).concat(opts.filter((a) => a.startsWith('--config=')).map((a) => a.slice('--config='.length))));
    }
    case 'tsc': {
      const bad = rest.find((a) => a.startsWith('-') && !['--noEmit', '-p', '--project', '--pretty', '--listFiles'].includes(a));
      if (bad) return deny(`tsc option ${bad} is not allowed`);
      const pIdx = rest.findIndex((a) => a === '-p' || a === '--project');
      return allow(pIdx >= 0 && rest[pIdx + 1] ? [rest[pIdx + 1] as string] : []);
    }
    case 'eslint': {
      if (rest.some((a) => a === '--fix' || a.startsWith('--rulesdir') || a.startsWith('--plugin') || a.startsWith('-c') || a.startsWith('--config'))) {
        return deny('eslint may only report (no --fix, no custom config/plugins)');
      }
      return allow(rest.filter((a) => !a.startsWith('-')).map((a) => a.replace(/[*{}]/g, '').split('/')[0] ?? '.').filter((a) => a !== ''));
    }
    case 'prisma':
      return rest.length === 1 && (rest[0] === 'generate' || rest[0] === 'validate') ? allow() : deny('only `npx prisma generate|validate` is allowed');
    default:
      return deny(`npx ${tool ?? '(none)'} is not allowed`);
  }
}

export function checkCommand(request: CommandRequest): PolicyDecision {
  // A multi-line commit message is the one legitimate newline: it is the
  // argv element right after `git commit -m`, and no shell is ever involved.
  const commitMessageIndex = request.program === 'git' && request.args[0] === 'commit' ? request.args.indexOf('-m') + 1 : 0;
  const badArg = request.args.some((a, i) => a.includes('\0') || ((a.includes('\n') || a.includes('\r')) && !(commitMessageIndex > 0 && i === commitMessageIndex)));
  if (badArg) return deny('arguments may not contain NUL or newlines (except a git commit -m message)');
  switch (request.program) {
    case 'git':
      return checkGit(request.args);
    case 'npm':
      return checkNpm(request.args);
    case 'npx':
      return checkNpx(request.args);
    default:
      return deny(`program ${request.program} is not on the allowlist (git, npm, npx)`);
  }
}
