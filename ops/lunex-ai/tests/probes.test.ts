import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { DEFAULT_DENIED_ROOTS } from '../src/config';
import { ScopeGuard } from '../src/scopeGuard';
import { buildPathProbes, COMMAND_PROBES, evaluateCommandProbes, evaluatePathProbes, formatOutcomes } from '../src/tools/probes';

let root: string;
let workspace: string;
let aiHome: string;
let guard: ScopeGuard;

beforeEach(() => {
  root = fs.mkdtempSync(path.join(os.tmpdir(), 'lunex-ai-probes-'));
  workspace = path.join(root, 'workspace', 'lunex');
  aiHome = path.join(root, 'ai');
  fs.mkdirSync(path.join(workspace, 'src'), { recursive: true });
  fs.mkdirSync(path.join(aiHome, 'lunex-ai', 'dist'), { recursive: true });
  fs.writeFileSync(path.join(workspace, 'package.json'), '{}');
  guard = new ScopeGuard({ workspaceDir: workspace, aiHomeDir: aiHome, deniedRoots: DEFAULT_DENIED_ROOTS.map((p) => path.resolve(p)) });
});
afterEach(() => { fs.rmSync(root, { recursive: true, force: true }); });

describe('deployment probes', () => {
  it('every default path probe matches the real scope guard (finance-bot, guardian, production, /root, env files, self-protection)', () => {
    const outcomes = evaluatePathProbes(guard, buildPathProbes(workspace, aiHome));
    expect(outcomes.filter((o) => !o.pass)).toEqual([]);
    const labels = outcomes.map((o) => o.label).join('\n');
    for (const needle of ['finance-bot', 'guardian', 'Lunex production', '/root', 'supervisor env file']) expect(labels).toContain(needle);
  });

  it('every command probe matches the real allowlist', () => {
    const outcomes = evaluateCommandProbes(COMMAND_PROBES);
    expect(outcomes.filter((o) => !o.pass)).toEqual([]);
    expect(outcomes.filter((o) => o.actual === 'refuse').length).toBeGreaterThanOrEqual(12);
  });

  it('a probe whose expectation is violated is reported as FAIL', () => {
    const outcomes = evaluatePathProbes(guard, [{ label: 'shadow must be readable (wrong on purpose)', path: '/etc/shadow', mode: 'read', actor: 'agent', expectAllowed: true }]);
    expect(outcomes[0]).toMatchObject({ pass: false, expected: 'allow', actual: 'refuse' });
    expect(formatOutcomes(outcomes)).toMatch(/^FAIL[\s\S]*0\/1 probes as expected$/);
  });
});
