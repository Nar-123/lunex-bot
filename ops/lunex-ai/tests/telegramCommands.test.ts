import { describe, expect, it, vi } from 'vitest';
import type { Task } from '../src/stateStore';
import type { SupervisorControl } from '../src/supervisor/supervisor';
import { handleMessage, HELP_TEXT, parseTaskArgs } from '../src/telegram/commands';
import type { CommandHandlerDeps } from '../src/telegram/commands';
import { classifyMessage, detectStrategyPermission, inferPriority } from '../src/telegram/naturalLanguage';
import { createTask } from '../src/taskQueue';
import { silentLogger } from './helpers';

const ADMIN = 111;
const STRANGER = 999;

function fakeControl(): { [K in keyof SupervisorControl]: ReturnType<typeof vi.fn> } {
  const task = (text: string): Task => createTask({ title: text, description: text, priority: 'P2', source: 'telegram-command' }, new Date(), 'T-20260913-120000-abcd');
  return {
    status: vi.fn(async () => 'STATUS'),
    progress: vi.fn(() => 'PROGRESS'),
    queueList: vi.fn(() => 'QUEUE'),
    addTask: vi.fn((text: string, _source: string, opts?: { priority?: Task['priority']; allowStrategyChange?: boolean }) => ({ ...task(text), priority: opts?.priority ?? 'P2', allowStrategyChange: opts?.allowStrategyChange ?? false })),
    continueWork: vi.fn(() => 'CONTINUE'),
    pause: vi.fn(() => 'PAUSED'),
    resume: vi.fn(() => 'RESUMED'),
    stop: vi.fn(() => 'STOPPING'),
    clearQueue: vi.fn(() => 'CLEARED'),
    runTests: vi.fn(async () => 'TESTS PASS'),
    runBuild: vi.fn(async () => 'BUILD PASS'),
    diff: vi.fn(async () => 'DIFF'),
    gitInfo: vi.fn(async () => 'GIT'),
    log: vi.fn(() => 'LOG'),
    audit: vi.fn((scope: string) => task(`audit ${scope}`)),
    approve: vi.fn(async () => 'APPROVED'),
    restart: vi.fn(() => 'RESTARTING'),
  };
}

function setup(overrides: Partial<CommandHandlerDeps> = {}) {
  const control = fakeControl();
  const logger = silentLogger();
  const send = vi.fn(async () => undefined);
  const deps: CommandHandlerDeps = { control: control as unknown as SupervisorControl, adminIds: [ADMIN], logger, replyToUnauthorized: false, send, ...overrides };
  const say = (text: string, fromId: number = ADMIN) => handleMessage({ fromId, chatId: fromId, text }, deps);
  return { control, logger, send, say, deps };
}

describe('Telegram authorization', () => {
  it('ignores a non-admin completely: no reply, no control call, logged', async () => {
    const { control, logger, say } = setup();
    for (const text of ['/status', '/task delete everything', '/approve T-1', '/restart', 'Continue developing Lunex.']) {
      expect(await say(text, STRANGER)).toBeNull();
    }
    for (const fn of Object.values(control)) expect(fn).not.toHaveBeenCalled();
    expect(logger.warn).toHaveBeenCalledWith('telegram_unauthorized', expect.objectContaining({ fromId: STRANGER }));
  });

  it('rejects messages with no sender id', async () => {
    const { control, deps } = setup();
    expect(await handleMessage({ fromId: undefined, chatId: 5, text: '/status' }, deps)).toBeNull();
    expect(control.status).not.toHaveBeenCalled();
  });

  it('can be configured to answer strangers with a bare refusal', async () => {
    const { control, say } = setup({ replyToUnauthorized: true });
    expect(await say('/status', STRANGER)).toBe('Unauthorized.');
    expect(control.status).not.toHaveBeenCalled();
  });
});

describe('Telegram commands (admin)', () => {
  it.each([
    ['/status', 'status', 'STATUS'],
    ['/status@LunexAiBot', 'status', 'STATUS'],
    ['/progress', 'progress', 'PROGRESS'],
    ['/queue', 'queueList', 'QUEUE'],
    ['/continue', 'continueWork', 'CONTINUE'],
    ['/pause', 'pause', 'PAUSED'],
    ['/resume', 'resume', 'RESUMED'],
    ['/stop', 'stop', 'STOPPING'],
    ['/clear', 'clearQueue', 'CLEARED'],
    ['/diff', 'diff', 'DIFF'],
    ['/git', 'gitInfo', 'GIT'],
    ['/restart', 'restart', 'RESTARTING'],
  ] as const)('%s -> control.%s', async (text, method, reply) => {
    const { control, say } = setup();
    expect(await say(text)).toBe(reply);
    expect(control[method]).toHaveBeenCalledTimes(1);
  });

  it('/start and /help return the help text', async () => {
    const { say } = setup();
    expect(await say('/start')).toBe(HELP_TEXT);
    expect(await say('/help')).toBe(HELP_TEXT);
  });

  it('/task queues with explicit priority and explicit strategy permission', async () => {
    const { control, say } = setup();
    const reply = await say('/task P1 --allow-strategy tighten the trailing TP drawdown');
    expect(control.addTask).toHaveBeenCalledWith('tighten the trailing TP drawdown', 'telegram-command', { priority: 'P1', allowStrategyChange: true });
    expect(reply).toMatch(/EXPLICITLY ALLOWED/);
  });

  it('/task without a priority infers it, and strategy changes default to not allowed', async () => {
    const { control, say } = setup();
    await say('/task Fix the failing swap verification tests');
    expect(control.addTask).toHaveBeenCalledWith('Fix the failing swap verification tests', 'telegram-command', { priority: 'P1', allowStrategyChange: false });
  });

  it('/task with no description shows usage', async () => {
    const { control, say } = setup();
    expect(await say('/task')).toMatch(/^Usage/);
    expect(control.addTask).not.toHaveBeenCalled();
  });

  it('/log passes the requested line count; /audit passes its scope', async () => {
    const { control, say } = setup();
    await say('/log 7');
    expect(control.log).toHaveBeenCalledWith(7);
    await say('/audit the execution engine');
    expect(control.audit).toHaveBeenCalledWith('the execution engine');
  });

  it('/approve validates the task id before calling control', async () => {
    const { control, say } = setup();
    expect(await say('/approve ; rm -rf /')).toMatch(/^Usage/);
    expect(control.approve).not.toHaveBeenCalled();
    expect(await say('/approve T-20260913-120000-abcd')).toBe('APPROVED');
  });

  it('/test and /build acknowledge immediately and deliver the result afterwards', async () => {
    const { control, send, say } = setup();
    expect(await say('/test')).toMatch(/started/);
    expect(await say('/build')).toMatch(/started/);
    await vi.waitFor(() => { expect(send).toHaveBeenCalledTimes(2); });
    expect(send).toHaveBeenCalledWith(ADMIN, 'TESTS PASS');
    expect(send).toHaveBeenCalledWith(ADMIN, 'BUILD PASS');
    expect(control.runTests).toHaveBeenCalledTimes(1);
  });

  it('unknown commands get a pointer to /help; handler errors are reported, not thrown', async () => {
    const { control, say } = setup();
    expect(await say('/deploy production')).toMatch(/Unknown command/);
    control.status.mockRejectedValueOnce(new Error('git unavailable'));
    expect(await say('/status')).toBe('Error: git unavailable');
  });
});

describe('Telegram natural language', () => {
  it('turns the operator example into a P1 task with strategy changes NOT allowed', async () => {
    const { control, say } = setup();
    const text = 'Periksa semua failure path pada exit transaction dan perbaiki tanpa mengubah strategi.';
    const reply = await say(text);
    expect(control.addTask).toHaveBeenCalledWith(text, 'telegram-natural', { priority: 'P1', allowStrategyChange: false });
    expect(reply).toMatch(/Understood -- queued/);
  });

  it.each([
    ['Apa yang sedang kamu kerjakan?', 'status'],
    ['What are you doing?', 'status'],
    ['Continue developing Lunex.', 'continueWork'],
    ['Lanjutkan pengembangan Lunex.', 'continueWork'],
    ['Continue from the last checkpoint.', 'continueWork'],
    ['pause', 'pause'],
    ['hentikan', 'stop'],
  ] as const)('"%s" -> control.%s', async (text, method) => {
    const { control, say } = setup();
    await say(text);
    expect(control[method]).toHaveBeenCalledTimes(1);
    expect(control.addTask).not.toHaveBeenCalled();
  });

  it('longer messages that merely mention "status" are tasks, not status queries', () => {
    expect(classifyMessage('Audit the position status transitions in positionRepository and add tests').kind).toBe('task');
  });
});

describe('naturalLanguage helpers', () => {
  it.each([
    ['Audit secret handling in the API auth module', 'P0'],
    ['Fix the exit swap retry logic', 'P1'],
    ['Improve RPC reliability on reconnect', 'P2'],
    ['Refactor the filter tests', 'P3'],
    ['Update README documentation', 'P4'],
    ['Something vague', 'P2'],
  ] as const)('inferPriority("%s") = %s', (text, priority) => {
    expect(inferPriority(text)).toBe(priority);
  });

  it.each([
    ['Perbaiki bug exit tanpa mengubah strategi', false],
    ["Fix it but don't change the strategy", false],
    ['Review the exit strategy code', false],
    ['Boleh ubah strategi exit: naikkan stop loss ke -8%', true],
    ['I allow a strategy change for the trailing TP', true],
    ['--allow-strategy widen OOR grace', true],
  ] as const)('detectStrategyPermission("%s") = %s', (text, expected) => {
    expect(detectStrategyPermission(text)).toBe(expected);
  });

  it('parseTaskArgs accepts flags in either order', () => {
    expect(parseTaskArgs('--allow-strategy P0 fix leak')).toEqual({ text: 'fix leak', priority: 'P0', allowStrategyChange: true });
  });
});
