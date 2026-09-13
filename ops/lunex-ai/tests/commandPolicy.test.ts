import { describe, expect, it } from 'vitest';
import { checkCommand } from '../src/commandPolicy';

const cmd = (line: string): { program: string; args: string[] } => {
  const [program = '', ...args] = line.split(' ');
  return { program, args };
};

describe('command allowlist -- allowed', () => {
  it.each([
    'git status',
    'git status --porcelain -z',
    'git diff --stat HEAD',
    'git diff --cached --unified=0',
    'git log --oneline -5',
    'git show HEAD',
    'git rev-parse --abbrev-ref HEAD',
    'git branch',
    'git branch ai/new-topic',
    'git checkout -b ai/fix-exit-path',
    'git checkout ai/develop',
    'git switch -c ai/refactor',
    'git add -A',
    'git add src/exits/swapTx.ts',
    'git commit -m message',
    'git merge --ff-only ai/fix-exit-path',
    'git stash list',
    'npm run typecheck',
    'npm run lint',
    'npm run test',
    'npm run test -- tests/exits/swapTx.test.ts',
    'npm run build',
    'npm run ai:test',
    'npx vitest run tests/exits/swapTx.test.ts',
    'npx tsc --noEmit',
    'npx tsc --noEmit -p tsconfig.json',
    'npx eslint src',
    'npx prisma generate',
  ])('%s', (line) => {
    expect(checkCommand(cmd(line))).toMatchObject({ allowed: true });
  });

  it('reports path arguments so the runner can scope-check them', () => {
    expect(checkCommand(cmd('git add src/a.ts tests/b.test.ts'))).toEqual({ allowed: true, pathArgs: ['src/a.ts', 'tests/b.test.ts'] });
    expect(checkCommand(cmd('npx vitest run tests/x.test.ts'))).toEqual({ allowed: true, pathArgs: ['tests/x.test.ts'] });
    expect(checkCommand(cmd('npm run test -- ../other/x.test.ts'))).toEqual({ allowed: true, pathArgs: ['../other/x.test.ts'] });
  });
});

describe('command allowlist -- refused', () => {
  it.each([
    // remotes, history rewriting, destruction
    'git push origin main',
    'git push --force',
    'git pull',
    'git fetch',
    'git reset --hard HEAD~1',
    'git clean -fdx',
    'git rebase main',
    'git filter-branch --all',
    'git remote add evil https://example.com/x.git',
    'git config user.email x@y',
    'git tag v1',
    'git stash',
    'git gc --prune=now',
    // config / directory injection
    'git -c core.hooksPath=/tmp status',
    'git -C /opt/lunex/production status',
    'git --git-dir=/opt/lunex/production/.git log',
    'git diff --output=/tmp/leak.txt',
    'git diff --ext-diff',
    // branches
    'git branch -D ai/old',
    'git branch feature/not-ai',
    'git checkout -b feature/not-ai',
    'git checkout -f main',
    'git checkout -- src/a.ts',
    'git checkout .',
    'git merge main',
    // commits
    'git commit --amend -m x',
    'git commit --no-verify -m x',
    'git commit -n -m x',
    'git commit --author=someone -m x',
    'git commit',
    'git add -f .env',
    'git add',
    // npm / npx
    'npm install',
    'npm ci',
    'npm start',
    'npm run dev',
    'npm run prisma:deploy',
    'npm run prisma:migrate',
    'npm run test:e2e',
    'npm run build -- --watch',
    'npm run test -- --watch',
    'npm exec something',
    'npx vitest',
    'npx vitest run --watch',
    'npx -y cowsay hi',
    'npx ts-node src/index.ts',
    'npx prisma migrate deploy',
    'npx eslint --fix src',
    'npx tsc --outDir /tmp/x',
    // anything else
    'node dist/validate-live.js rpc --i-understand-this-is-live-validation',
    'node dist/index.js',
    'bash -c ls',
    'sh -c whoami',
    'curl https://example.com',
    'rm -rf /',
    'systemctl restart lunex-bot',
  ])('%s', (line) => {
    const decision = checkCommand(cmd(line));
    expect(decision.allowed).toBe(false);
  });

  it('refuses newlines in any argument except a git commit -m message, and NUL everywhere', () => {
    expect(checkCommand({ program: 'git', args: ['commit', '-m', 'Title\n\nBody line'] }).allowed).toBe(true);
    expect(checkCommand({ program: 'git', args: ['commit', '-m', 'Title\0'] }).allowed).toBe(false);
    expect(checkCommand({ program: 'git', args: ['add', 'src/a.ts\nsrc/b.ts'] }).allowed).toBe(false);
    expect(checkCommand({ program: 'git', args: ['log', '--grep', 'a\nb'] }).allowed).toBe(false);
    expect(checkCommand({ program: 'npm', args: ['run', 'test', '--', 'a\nb'] }).allowed).toBe(false);
    expect(checkCommand({ program: 'git', args: ['add', 'src/a.ts\0'] }).allowed).toBe(false);
  });

  it('gives a reason for every refusal', () => {
    const decision = checkCommand(cmd('git push origin main'));
    expect(decision.allowed).toBe(false);
    if (!decision.allowed) expect(decision.reason).toMatch(/not allowed/);
  });
});
