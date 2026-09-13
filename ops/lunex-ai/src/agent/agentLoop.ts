import type { LlmClient, ChatMessage } from '../llm/tokenRouterClient';
import type { Logger } from '../logger';
import type { Masker } from '../secretMask';
import type { Task } from '../stateStore';
import type { VerificationReport } from '../verification';
import { ActionParseError, parseAgentReply } from './actionParser';
import type { FinishStatus } from './actionParser';
import { buildTaskPrompt, parseErrorMessage, SYSTEM_PROMPT, toolResultMessage, verificationFailedMessage } from './prompts';
import type { TaskContext } from './prompts';
import type { AgentTools } from './tools';

export type ControlSignal = 'continue' | 'pause' | 'stop';

export interface AgentLoopDeps {
  llm: LlmClient;
  tools: AgentTools;
  logger: Logger;
  mask: Masker;
  maxSteps: number;
  maxDebugRounds: number;
  /** Supervisor-run gate (typecheck, lint, tests, build). The model's own claim is never trusted. */
  verify: () => Promise<VerificationReport>;
  /** Polled between steps -- the only points where the loop can be paused or stopped safely. */
  control: () => ControlSignal;
  recordStep: (phase: string, note: string) => void;
}

export type AgentOutcome =
  | {
      kind: 'finished';
      status: FinishStatus;
      summary: string;
      rootCause: string;
      next: string;
      reason?: string;
      requiredAction?: string;
      /** Present (and passed) only for COMPLETED. */
      verification: VerificationReport | null;
    }
  | { kind: 'verification_failed'; verification: VerificationReport; summary: string; rootCause: string }
  | { kind: 'step_budget_exhausted' }
  | { kind: 'interrupted'; by: 'pause' | 'stop' }
  | { kind: 'llm_error'; message: string };

const MAX_CONSECUTIVE_PARSE_ERRORS = 4;
/** Recent exchanges kept verbatim; older ones are dropped (system prompt + task brief always stay). */
const HISTORY_WINDOW = 40;

function windowed(messages: ChatMessage[]): ChatMessage[] {
  if (messages.length <= HISTORY_WINDOW + 2) return messages;
  const head = messages.slice(0, 2);
  const recent = messages.slice(-HISTORY_WINDOW);
  return [...head, { role: 'user', content: '[older steps omitted for context length -- rely on checkpoints, git status and files]' }, ...recent];
}

/**
 * inspect -> plan -> implement -> test -> (debug) -> verify, driven by the
 * model one JSON action at a time. The loop never commits and never marks a
 * task COMPLETED on the model's word: a COMPLETED finish triggers the
 * supervisor's own verification, and a failure is fed back for up to
 * `maxDebugRounds` rounds before the task is reported FAILED.
 */
export async function runAgentLoop(task: Task, context: TaskContext, deps: AgentLoopDeps): Promise<AgentOutcome> {
  const messages: ChatMessage[] = [
    { role: 'system', content: SYSTEM_PROMPT },
    { role: 'user', content: deps.mask(buildTaskPrompt(task, context)) },
  ];
  let parseErrors = 0;
  let debugRounds = 0;

  for (let step = 0; step < deps.maxSteps; step++) {
    const signal = deps.control();
    if (signal !== 'continue') return { kind: 'interrupted', by: signal };

    let reply: string;
    try {
      reply = (await deps.llm.complete(windowed(messages))).content;
    } catch (err) {
      return { kind: 'llm_error', message: deps.mask(err instanceof Error ? err.message : String(err)) };
    }
    messages.push({ role: 'assistant', content: reply });

    let parsed;
    try {
      parsed = parseAgentReply(reply);
      parseErrors = 0;
    } catch (err) {
      const message = err instanceof ActionParseError ? err.message : String(err);
      parseErrors++;
      deps.logger.warn('agent_reply_rejected', { taskId: task.id, message, consecutive: parseErrors });
      if (parseErrors >= MAX_CONSECUTIVE_PARSE_ERRORS) {
        return { kind: 'llm_error', message: `model produced ${String(parseErrors)} consecutive invalid replies: ${message}` };
      }
      messages.push({ role: 'user', content: parseErrorMessage(message) });
      continue;
    }

    const { action } = parsed;
    const stepsLeft = deps.maxSteps - step - 1;

    if (action.type !== 'finish') {
      const result = await deps.tools.execute(action);
      const detail = action.type === 'run' ? `${action.program} ${action.args.join(' ')}` : 'path' in action ? action.path : action.type === 'checkpoint' ? action.note : '';
      deps.recordStep(action.type, deps.mask(`${result.ok ? 'ok' : 'not ok'}: ${detail}`.slice(0, 300)));
      if (result.output.startsWith('REFUSED:')) deps.logger.warn('agent_action_refused', { taskId: task.id, action: action.type, detail: result.output.slice(0, 300) });
      messages.push({ role: 'user', content: toolResultMessage(action.type, result.ok, result.output, stepsLeft) });
      continue;
    }

    deps.recordStep('finish', `${action.status}: ${action.summary}`.slice(0, 300));
    if (action.status !== 'COMPLETED') {
      return {
        kind: 'finished',
        status: action.status,
        summary: action.summary,
        rootCause: action.rootCause,
        next: action.next,
        ...(action.reason !== undefined ? { reason: action.reason } : {}),
        ...(action.requiredAction !== undefined ? { requiredAction: action.requiredAction } : {}),
        verification: null,
      };
    }

    deps.recordStep('verify', 'supervisor verification: typecheck, lint, test, build');
    const verification = await deps.verify();
    if (verification.passed) {
      return { kind: 'finished', status: 'COMPLETED', summary: action.summary, rootCause: action.rootCause, next: action.next, verification };
    }
    debugRounds++;
    deps.recordStep('debug', `verification failed (round ${String(debugRounds)})`);
    if (debugRounds > deps.maxDebugRounds) {
      return { kind: 'verification_failed', verification, summary: action.summary, rootCause: action.rootCause };
    }
    messages.push({ role: 'user', content: verificationFailedMessage(verification, debugRounds, deps.maxDebugRounds) });
  }
  return { kind: 'step_budget_exhausted' };
}
