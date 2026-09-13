import path from 'node:path';
import { checkCommand } from '../commandPolicy';
import type { CommandRequest } from '../commandPolicy';
import type { AccessMode, Actor, ScopeGuard } from '../scopeGuard';

export interface PathProbe {
  label: string;
  path: string;
  mode: AccessMode;
  actor: Actor;
  expectAllowed: boolean;
}

export interface CommandProbe {
  label: string;
  request: CommandRequest;
  expectAllowed: boolean;
}

export interface ProbeOutcome {
  label: string;
  expected: 'allow' | 'refuse';
  actual: 'allow' | 'refuse';
  pass: boolean;
  reason: string;
}

/**
 * Deployment probes: the deployed guard is asked about real paths on the VPS.
 * Nothing is read or written -- `ScopeGuard.check` only resolves paths.
 */
export function buildPathProbes(workspaceDir: string, aiHomeDir: string): PathProbe[] {
  const ws = (p: string): string => path.join(workspaceDir, p);
  const ai = (p: string): string => path.join(aiHomeDir, p);
  const refuse = (label: string, p: string, mode: AccessMode = 'read', actor: Actor = 'agent'): PathProbe => ({ label, path: p, mode, actor, expectAllowed: false });
  return [
    { label: 'agent reads Lunex source', path: ws('package.json'), mode: 'read', actor: 'agent', expectAllowed: true },
    { label: 'agent writes Lunex source', path: ws('src/__lunex_ai_probe__.ts'), mode: 'write', actor: 'agent', expectAllowed: true },
    { label: 'commands run in the workspace', path: workspaceDir, mode: 'execute', actor: 'supervisor', expectAllowed: true },
    refuse('workspace .env', ws('.env')),
    refuse('agent writes supervisor code', ws('ops/lunex-ai/src/scopeGuard.ts'), 'write'),
    refuse('agent writes .git', ws('.git/config'), 'write'),
    refuse('agent reads supervisor env file', ai('lunex-ai.env')),
    refuse('supervisor reads its env file through the guard', ai('lunex-ai.env'), 'read', 'supervisor'),
    refuse('agent writes deployed supervisor', ai('lunex-ai/dist/main.js'), 'write'),
    refuse('finance-bot', '/opt/finance-bot'),
    refuse('finance-bot .env', '/opt/finance-bot/.env'),
    refuse('guardian', '/opt/guardian'),
    refuse('guardian .env', '/opt/guardian/.env'),
    refuse('Lunex production', '/opt/lunex/production'),
    refuse('Lunex production .env', '/opt/lunex/production/.env'),
    refuse('Lunex trading', '/opt/lunex/trading'),
    refuse('/root', '/root'),
    refuse('root SSH key', '/root/.ssh/id_rsa'),
    refuse('/etc/shadow', '/etc/shadow'),
    refuse('another repository via ..', path.join(workspaceDir, '..', 'other-repo', 'index.js')),
    refuse('run commands in finance-bot', '/opt/finance-bot', 'execute', 'supervisor'),
  ];
}

const req = (line: string): CommandRequest => {
  const [program = '', ...args] = line.split(' ');
  return { program, args };
};

export const COMMAND_PROBES: readonly CommandProbe[] = [
  { label: 'npm run test', request: req('npm run test'), expectAllowed: true },
  { label: 'git status', request: req('git status'), expectAllowed: true },
  { label: 'git checkout -b ai/probe', request: req('git checkout -b ai/probe'), expectAllowed: true },
  ...[
    'git push origin main',
    'git push --force origin ai/develop',
    'git reset --hard HEAD~1',
    'git clean -fdx',
    'git rebase main',
    'git branch -D ai/develop',
    'git remote add origin https://example.invalid/x.git',
    'node dist/validate-live.js rpc --i-understand-this-is-live-validation',
    'npm start',
    'npm install',
    'bash -c id',
    'curl https://example.invalid',
    'systemctl restart finance-bot',
    'cat /opt/finance-bot/.env',
  ].map((line): CommandProbe => ({ label: line, request: req(line), expectAllowed: false })),
];

export function evaluatePathProbes(guard: ScopeGuard, probes: readonly PathProbe[]): ProbeOutcome[] {
  return probes.map((probe) => {
    let actual: 'allow' | 'refuse' = 'allow';
    let reason = '';
    try {
      guard.check(probe.path, probe.mode, probe.actor);
    } catch (err) {
      actual = 'refuse';
      reason = err instanceof Error ? err.message : String(err);
    }
    const expected = probe.expectAllowed ? 'allow' : 'refuse';
    return { label: `${probe.mode}/${probe.actor}: ${probe.label}`, expected, actual, pass: expected === actual, reason };
  });
}

export function evaluateCommandProbes(probes: readonly CommandProbe[]): ProbeOutcome[] {
  return probes.map((probe) => {
    const decision = checkCommand(probe.request);
    const actual = decision.allowed ? 'allow' : 'refuse';
    const expected = probe.expectAllowed ? 'allow' : 'refuse';
    return { label: `command: ${probe.label}`, expected, actual, pass: expected === actual, reason: decision.allowed ? '' : decision.reason };
  });
}

export function formatOutcomes(outcomes: readonly ProbeOutcome[]): string {
  const lines = outcomes.map((o) => `${o.pass ? 'PASS' : 'FAIL'}  expected=${o.expected.padEnd(6)} actual=${o.actual.padEnd(6)} ${o.label}${o.reason ? ` -- ${o.reason}` : ''}`);
  const failed = outcomes.filter((o) => !o.pass).length;
  lines.push(`${String(outcomes.length - failed)}/${String(outcomes.length)} probes as expected`);
  return lines.join('\n');
}
