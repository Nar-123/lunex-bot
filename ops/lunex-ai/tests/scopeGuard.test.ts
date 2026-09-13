import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { ScopeGuard, ScopeViolation } from '../src/scopeGuard';

let root: string;
let workspace: string;
let aiHome: string;
let production: string;
let trading: string;
let otherRepo: string;
let guard: ScopeGuard;
let symlinkSupported = true;

beforeAll(() => {
  root = fs.mkdtempSync(path.join(os.tmpdir(), 'lunex-ai-scope-'));
  workspace = path.join(root, 'workspace', 'lunex');
  aiHome = path.join(root, 'ai');
  production = path.join(root, 'production');
  trading = path.join(root, 'trading');
  otherRepo = path.join(root, 'workspace', 'other-bot');
  for (const dir of [path.join(workspace, 'src'), path.join(workspace, '.git'), path.join(workspace, 'ops', 'lunex-ai', 'src'), path.join(workspace, '.ai', 'state'), aiHome, production, trading, otherRepo]) {
    fs.mkdirSync(dir, { recursive: true });
  }
  fs.writeFileSync(path.join(workspace, 'src', 'a.ts'), 'export const a = 1;\n');
  fs.writeFileSync(path.join(production, '.env'), 'PRIVATE_KEY=secret\n');
  fs.writeFileSync(path.join(production, 'bot.js'), 'trade();\n');
  fs.writeFileSync(path.join(aiHome, 'notes.txt'), 'hello\n');
  try {
    fs.symlinkSync(production, path.join(workspace, 'prod-link'), process.platform === 'win32' ? 'junction' : 'dir');
  } catch {
    symlinkSupported = false;
  }
  guard = new ScopeGuard({ workspaceDir: workspace, aiHomeDir: aiHome, deniedRoots: [production, trading] });
});

afterAll(() => {
  fs.rmSync(root, { recursive: true, force: true });
});

const refused = (fn: () => unknown): void => {
  expect(fn).toThrow(ScopeViolation);
};

describe('ScopeGuard -- allowed inside the Lunex workspace', () => {
  it('allows reading and writing ordinary workspace files, relative or absolute', () => {
    expect(guard.check('src/a.ts', 'read')).toBe(fs.realpathSync.native(path.join(workspace, 'src', 'a.ts')));
    expect(() => guard.check(path.join(workspace, 'src', 'new-file.ts'), 'write')).not.toThrow();
    expect(() => guard.check('tests/deep/new.test.ts', 'write')).not.toThrow();
  });

  it('allows commands to run with the workspace as cwd', () => {
    expect(() => guard.check('.', 'execute', 'supervisor')).not.toThrow();
  });

  it('lets the agent read the AI home but never write there', () => {
    expect(() => guard.check(path.join(aiHome, 'notes.txt'), 'read')).not.toThrow();
    refused(() => guard.check(path.join(aiHome, 'notes.txt'), 'write'));
  });
});

describe('ScopeGuard -- forbidden locations', () => {
  it('refuses production and trading paths for every mode and actor', () => {
    for (const mode of ['read', 'write', 'execute'] as const) {
      refused(() => guard.check(path.join(production, 'bot.js'), mode, 'supervisor'));
      refused(() => guard.check(path.join(trading, 'x'), mode, 'agent'));
    }
  });

  it('refuses ../ traversal to another repository', () => {
    refused(() => guard.check('../other-bot/index.js', 'read'));
    refused(() => guard.check('src/../../other-bot/index.js', 'write'));
  });

  it('refuses arbitrary absolute paths outside the allowed roots', () => {
    refused(() => guard.check(path.join(root, 'elsewhere.txt'), 'read'));
    refused(() => guard.check(os.homedir(), 'read'));
  });

  it('refuses a symlink/junction inside the workspace that points into production -- existing and not-yet-existing targets', () => {
    if (!symlinkSupported) return;
    refused(() => guard.check('prod-link/bot.js', 'read'));
    refused(() => guard.check('prod-link/new-file.js', 'write'));
  });

  it('refuses commands whose cwd would be outside the workspace', () => {
    refused(() => guard.check(aiHome, 'execute', 'supervisor'));
  });

  it('refuses NUL bytes', () => {
    refused(() => guard.check('src/a.ts\0.png', 'read'));
  });
});

describe('ScopeGuard -- secrets', () => {
  it.each(['.env', '.env.production', 'config/.env.local', 'lunex-ai.env'])('never reads or writes %s', (file) => {
    refused(() => guard.check(file, 'read', 'supervisor'));
    refused(() => guard.check(file, 'write', 'supervisor'));
  });

  it('refuses the AI home env file even for the supervisor', () => {
    refused(() => guard.check(path.join(aiHome, 'lunex-ai.env'), 'read', 'supervisor'));
  });

  it('allows .env.example (placeholders only)', () => {
    expect(() => guard.check('.env.example', 'read')).not.toThrow();
  });

  it.each(['deploy/key.pem', 'id_rsa', 'certs/server.key', 'wallet.keystore'])('refuses key material %s', (file) => {
    refused(() => guard.check(file, 'read'));
  });
});

describe('ScopeGuard -- agent write protections', () => {
  it.each(['ops/lunex-ai/src/scopeGuard.ts', '.git/config', '.ai/state/queue.json', 'node_modules/x/index.js', '.github/workflows/ci.yml', 'dist/index.js'])(
    'the agent may read but never write %s',
    (file) => {
      refused(() => guard.check(file, 'write', 'agent'));
    },
  );

  it('the supervisor itself may write its runtime state', () => {
    expect(() => guard.check('.ai/state/queue.json', 'write', 'supervisor')).not.toThrow();
  });

  it('the workspace root itself is not a writable file target', () => {
    refused(() => guard.check('.', 'write', 'agent'));
  });
});
