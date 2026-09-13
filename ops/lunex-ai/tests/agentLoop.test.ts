import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { runAgentLoop } from '../src/agent/agentLoop';
import type { AgentLoopDeps, ControlSignal } from '../src/agent/agentLoop';
import { AgentTools } from '../src/agent/tools';
import type { CommandRunner } from '../src/commandRunner';
import type { ChatMessage, LlmClient } from '../src/llm/tokenRouterClient';
import { ScopeGuard } from '../src/scopeGuard';
import { createMasker } from '../src/secretMask';
import { createTask } from '../src/taskQueue';
import type { VerificationReport } from '../src/verification';
import { silentLogger } from './helpers';

let root: string;
let workspace: string;

beforeEach(() => {
  root = fs.mkdtempSync(path.join(os.tmpdir(), 'lunex-ai-agent-'));
  workspace = path.join(root, 'lunex');
  fs.mkdirSync(path.join(workspace, 'src'), { recursive: true });
  fs.mkdirSync(path.join(workspace, 'ops', 'lunex-ai', 'src'), { recursive: true });
  fs.writeFileSync(path.join(workspace, 'src', 'a.ts'), 'export const value = 1;\n');
});
afterEach(() => { fs.rmSync(root, { recursive: true, force: true }); });

const PASS: VerificationReport = { passed: true, steps: [{ name: 'test', passed: true, exitCode: 0, timedOut: false, durationMs: 1, outputTail: '', summary: 'Tests 5 passed (5)' }] };
const FAIL: VerificationReport = { passed: false, steps: [{ name: 'test', passed: false, exitCode: 1, timedOut: false, durationMs: 1, outputTail: 'AssertionError: expected 2 to be 1', summary: 'Tests 1 failed' }] };

const action = (a: Record<string, unknown>, thought = 'step'): string => JSON.stringify({ thought, action: a });
const finish = (status = 'COMPLETED'): string => action({ type: 'finish', status, summary: 'done', rootCause: 'value was wrong', next: 'nothing' });

function scriptedLlm(replies: (string | Error)[]): LlmClient & { calls: ChatMessage[][] } {
  const calls: ChatMessage[][] = [];
  return {
    calls,
    complete: vi.fn(async (messages: readonly ChatMessage[]) => {
      calls.push([...messages]);
      const next = replies.shift();
      if (next === undefined) throw new Error('script exhausted');
      if (next instanceof Error) throw next;
      return { content: next, promptTokens: null, completionTokens: null };
    }),
  };
}

function makeDeps(llm: LlmClient, overrides: Partial<AgentLoopDeps> = {}) {
  const guard = new ScopeGuard({ workspaceDir: workspace, aiHomeDir: path.join(root, 'ai'), deniedRoots: [path.join(root, 'production')] });
  const runner = { run: vi.fn(async () => ({ command: 'npx vitest run', exitCode: 0, stdout: 'Tests 5 passed', stderr: '', timedOut: false, durationMs: 5 })) };
  const tools = new AgentTools({ guard, runner: runner as unknown as CommandRunner, mask: createMasker([]), onCheckpoint: vi.fn() });
  const logger = silentLogger();
  const recordStep = vi.fn();
  const deps: AgentLoopDeps = {
    llm,
    tools,
    logger,
    mask: createMasker([]),
    maxSteps: 20,
    maxDebugRounds: 2,
    verify: vi.fn(async () => PASS),
    control: () => 'continue',
    recordStep,
    ...overrides,
  };
  return { deps, runner, logger, recordStep, tools };
}

const task = () => createTask({ title: 'fix value', description: 'value should be 2', priority: 'P2', source: 'telegram-command' }, new Date(), 'T-agent');
const ctx = { git: null, branch: 'ai/fix-value-gent', recentCompleted: [], recentBlocked: [] };

describe('runAgentLoop', () => {
  it('inspect -> implement -> test -> finish, then the SUPERVISOR verifies before COMPLETED is accepted', async () => {
    const llm = scriptedLlm([
      action({ type: 'read_file', path: 'src/a.ts' }),
      action({ type: 'replace_in_file', path: 'src/a.ts', old: 'value = 1', new: 'value = 2' }),
      action({ type: 'run', program: 'npx', args: ['vitest', 'run', 'tests/a.test.ts'] }),
      finish(),
    ]);
    const { deps, runner, recordStep, tools } = makeDeps(llm);

    const outcome = await runAgentLoop(task(), ctx, deps);

    expect(outcome).toMatchObject({ kind: 'finished', status: 'COMPLETED', verification: PASS });
    expect(fs.readFileSync(path.join(workspace, 'src', 'a.ts'), 'utf8')).toBe('export const value = 2;\n');
    expect(runner.run).toHaveBeenCalledWith({ program: 'npx', args: ['vitest', 'run', 'tests/a.test.ts'] });
    expect(deps.verify).toHaveBeenCalledTimes(1);
    expect([...tools.writtenFiles]).toEqual(['src/a.ts']);
    expect(recordStep).toHaveBeenCalledWith('verify', expect.any(String));
    // the model saw the file contents it asked for
    expect(llm.calls[1]?.at(-1)?.content).toMatch(/export const value = 1/);
  });

  it('refused actions are returned to the model and logged; nothing is written outside scope', async () => {
    const llm = scriptedLlm([
      action({ type: 'write_file', path: 'ops/lunex-ai/src/scopeGuard.ts', content: 'export {}' }),
      action({ type: 'read_file', path: '../production/.env' }),
      action({ type: 'read_file', path: '.env' }),
      finish('BLOCKED'),
    ]);
    const { deps, logger } = makeDeps(llm);

    const outcome = await runAgentLoop(task(), ctx, deps);

    expect(outcome).toMatchObject({ kind: 'finished', status: 'BLOCKED', verification: null });
    expect(fs.existsSync(path.join(workspace, 'ops', 'lunex-ai', 'src', 'scopeGuard.ts'))).toBe(false);
    const toolResults = llm.calls.slice(1).map((c) => c.at(-1)?.content ?? '');
    expect(toolResults.filter((c) => c.includes('REFUSED:'))).toHaveLength(3);
    expect(logger.warn).toHaveBeenCalledWith('agent_action_refused', expect.anything());
    expect(deps.verify).not.toHaveBeenCalled(); // BLOCKED is never verified or committed as success
  });

  it('a failed verification is fed back as a debug round; a later passing verification completes', async () => {
    const llm = scriptedLlm([finish(), action({ type: 'replace_in_file', path: 'src/a.ts', old: 'value = 1', new: 'value = 2' }), finish()]);
    const verify = vi.fn<() => Promise<VerificationReport>>().mockResolvedValueOnce(FAIL).mockResolvedValueOnce(PASS);
    const { deps } = makeDeps(llm, { verify });

    const outcome = await runAgentLoop(task(), ctx, deps);

    expect(outcome).toMatchObject({ kind: 'finished', status: 'COMPLETED' });
    expect(verify).toHaveBeenCalledTimes(2);
    expect(llm.calls[1]?.at(-1)?.content).toMatch(/SUPERVISOR VERIFICATION FAILED[\s\S]*AssertionError/);
  });

  it('verification that keeps failing past maxDebugRounds ends as verification_failed, never COMPLETED', async () => {
    const llm = scriptedLlm([finish(), finish(), finish(), finish()]);
    const { deps } = makeDeps(llm, { verify: vi.fn(async () => FAIL), maxDebugRounds: 2 });
    const outcome = await runAgentLoop(task(), ctx, deps);
    expect(outcome.kind).toBe('verification_failed');
  });

  it('malformed replies are corrected by feedback; too many in a row is an llm_error', async () => {
    const recovering = scriptedLlm(['sure, I will read the file', action({ type: 'finish', status: 'BLOCKED', summary: 'x' })]);
    const { deps } = makeDeps(recovering);
    await expect(runAgentLoop(task(), ctx, deps)).resolves.toMatchObject({ kind: 'finished', status: 'BLOCKED' });
    expect(recovering.calls[1]?.at(-1)?.content).toMatch(/rejected/);

    const broken = scriptedLlm(['nope', '{"action": 5}', '{"action": {"type": "rm_rf"}}', 'still no']);
    const { deps: deps2 } = makeDeps(broken);
    await expect(runAgentLoop(task(), ctx, deps2)).resolves.toMatchObject({ kind: 'llm_error' });
  });

  it.each(['pause', 'stop'] as const)('control signal %s interrupts before the next model call', async (signal) => {
    const llm = scriptedLlm([action({ type: 'list_dir', path: 'src' }), finish()]);
    let calls = 0;
    const control = (): ControlSignal => (calls++ === 0 ? 'continue' : signal);
    const { deps } = makeDeps(llm, { control });
    const outcome = await runAgentLoop(task(), ctx, deps);
    expect(outcome).toEqual({ kind: 'interrupted', by: signal });
    expect(llm.complete).toHaveBeenCalledTimes(1);
  });

  it('stops at the step budget', async () => {
    const llm = scriptedLlm(Array.from({ length: 5 }, () => action({ type: 'list_dir', path: 'src' })));
    const { deps } = makeDeps(llm, { maxSteps: 3 });
    await expect(runAgentLoop(task(), ctx, deps)).resolves.toEqual({ kind: 'step_budget_exhausted' });
  });

  it('a gateway failure becomes a masked llm_error', async () => {
    const llm = scriptedLlm([new Error('HTTP 401 key=sk-abcdefghijklmnopqrstuvwxyz')]);
    const { deps } = makeDeps(llm);
    const outcome = await runAgentLoop(task(), ctx, deps);
    expect(outcome.kind).toBe('llm_error');
    if (outcome.kind === 'llm_error') expect(outcome.message).not.toContain('sk-abcdefghijklmnopqrstuvwxyz');
  });
});
