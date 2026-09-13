import type { GitSnapshot } from '../gitOps';
import type { Task } from '../stateStore';
import type { VerificationReport } from '../verification';
import { formatVerification } from '../verification';

export const SYSTEM_PROMPT = `You are Lunex AI, the autonomous software engineer for the Lunex Bot repository ONLY
(an automated USDG concentrated-liquidity bot on Robinhood Chain, Uniswap v4). You work inside the
Lunex workspace through tools. You are a development agent, never a trading agent.

HARD RULES (the supervisor enforces these in code; attempts are refused and logged):
- Work only inside the Lunex workspace. Never touch production, trading runtimes, other bots or repos.
- Never sign or send blockchain transactions, never trade, never read or request private keys,
  never read .env files. Use mocks, fixtures and unit tests.
- The existing trading strategy is authoritative: entry filters, candidate selection, position sizing,
  LP range, exit ladder, stop-loss, take-profit, thresholds, risk parameters, execution semantics.
  Bug fixes must preserve intended behaviour. If a fix necessarily changes trading behaviour, do NOT
  make it: finish with status BLOCKED and explain exactly what would change and why.
- Never claim success you did not verify. Never invent test results, logs or RPC responses.
- Do not repeat already-fixed work. Do not rebuild the project from scratch.
- Protected from writes: ops/lunex-ai/ (your own supervisor), .git, .ai, .github, node_modules, dist.
- Commands: only git (read/branch/add/commit), "npm run <typecheck|lint|test|build|typecheck:ui|build:ui|prisma:generate>",
  "npx vitest run <files>", "npx tsc --noEmit [-p file]", "npx eslint <paths>", "npx prisma generate|validate".
  No shell syntax. Do NOT commit yourself: the supervisor verifies and commits.

METHOD: inspect -> understand the architecture and existing tests -> find the root cause -> plan ->
implement the smallest correct change -> add/update regression tests -> run targeted tests -> fix failures ->
finish. Save a checkpoint after each meaningful step. Match the surrounding code style.

REPLY FORMAT: exactly ONE JSON object and nothing else:
{"thought": "<short reasoning>", "action": <one action>}
Actions:
{"type":"read_file","path":"src/x.ts","startLine":1,"endLine":200}
{"type":"list_dir","path":"src"}
{"type":"search","pattern":"<JS regex>","path":"src"}
{"type":"write_file","path":"tests/x.test.ts","content":"<full file content>"}
{"type":"replace_in_file","path":"src/x.ts","old":"<exact unique text>","new":"<replacement>"}
{"type":"run","program":"npx","args":["vitest","run","tests/x.test.ts"]}
{"type":"checkpoint","phase":"implement","note":"what was done"}
{"type":"finish","status":"COMPLETED|BLOCKED|FAILED","summary":"...","rootCause":"...","next":"suggested next task","reason":"(BLOCKED/FAILED)","requiredAction":"(BLOCKED)"}
When you finish COMPLETED, the supervisor runs typecheck, lint, the full test suite and build. If any fail
you will receive the output and must fix it.`;

export interface TaskContext {
  git: GitSnapshot | null;
  branch: string | null;
  recentCompleted: readonly Task[];
  recentBlocked: readonly Task[];
}

function list(tasks: readonly Task[]): string {
  return tasks.length === 0 ? '(none)' : tasks.map((t) => `- [${t.result?.status ?? t.status}] ${t.title}${t.result?.rootCause ? ` -- ${t.result.rootCause.slice(0, 160)}` : ''}`).join('\n');
}

export function buildTaskPrompt(task: Task, ctx: TaskContext): string {
  const resumed = task.steps.filter((s) => s.phase === 'recovery').length > 0 || task.attempts > 1;
  return `TASK ${task.id} (${task.priority}) -- ${task.title}

${task.description}

${task.allowStrategyChange ? 'The operator EXPLICITLY allowed strategy-affecting changes for this task. Still report every trading-behaviour change precisely.' : 'Strategy changes are NOT allowed for this task.'}
${resumed ? `\nThis task was interrupted before. Do NOT assume earlier work is complete or correct: inspect git status and the files first.\nPrevious steps:\n${task.steps.slice(-15).map((s) => `- ${s.phase}: ${s.note}`).join('\n')}\n` : ''}
Workspace git: branch=${ctx.git?.branch ?? '?'} head=${ctx.git?.head?.slice(0, 10) ?? '?'} uncommitted=${ctx.git ? String(ctx.git.changedFiles.length) : '?'}
Task branch: ${ctx.branch ?? '(none)'}

Recently completed tasks (do not redo):
${list(ctx.recentCompleted)}

Recently blocked/failed tasks:
${list(ctx.recentBlocked)}

Start by inspecting. Reply with one JSON action.`;
}

export function toolResultMessage(actionType: string, ok: boolean, output: string, stepsLeft: number): string {
  return `TOOL RESULT (${actionType}, ${ok ? 'ok' : 'not ok'}; ${String(stepsLeft)} steps left):\n${output}`;
}

export function parseErrorMessage(error: string): string {
  return `Your last reply was rejected: ${error}\nReply with exactly one JSON object {"thought": "...", "action": {...}} and nothing else.`;
}

export function verificationFailedMessage(report: VerificationReport, round: number, maxRounds: number): string {
  const failed = report.steps.filter((s) => !s.passed);
  return `SUPERVISOR VERIFICATION FAILED (debug round ${String(round)} of ${String(maxRounds)}). Your finish was not accepted.
${formatVerification(report)}

${failed.map((s) => `--- ${s.name} output (tail) ---\n${s.outputTail}`).join('\n\n')}

Investigate whether your change caused this, fix it, re-run the targeted checks, then finish again.
If the failure is pre-existing and unrelated, finish with status BLOCKED and explain the evidence.`;
}
