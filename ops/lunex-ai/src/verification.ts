import type { CommandRequest } from './commandPolicy';
import type { CommandRunner } from './commandRunner';

export interface VerificationStep {
  name: string;
  request: CommandRequest;
}

/** The Lunex gate. Run by the SUPERVISOR, never self-reported by the model. */
export const LUNEX_VERIFICATION_STEPS: readonly VerificationStep[] = [
  { name: 'typecheck', request: { program: 'npm', args: ['run', 'typecheck'] } },
  { name: 'lint', request: { program: 'npm', args: ['run', 'lint'] } },
  { name: 'test', request: { program: 'npm', args: ['run', 'test'] } },
  { name: 'build', request: { program: 'npm', args: ['run', 'build'] } },
];

export interface StepOutcome {
  name: string;
  passed: boolean;
  exitCode: number | null;
  timedOut: boolean;
  durationMs: number;
  /** Masked tail of the output -- what the agent sees when debugging a failure. */
  outputTail: string;
  /** One-line summary, e.g. "818 passed" for tests. */
  summary: string;
}

export interface VerificationReport {
  passed: boolean;
  steps: StepOutcome[];
}

function tailLines(text: string, lines: number): string {
  return text.split('\n').slice(-lines).join('\n');
}

/** Extracts vitest's "Tests  N passed | M failed" style line, ANSI-stripped. */
export function summarizeOutput(stepName: string, stdout: string, stderr: string): string {
  const clean = `${stdout}\n${stderr}`.replace(/\x1b\[[0-9;]*m/g, '');
  if (stepName.includes('test')) {
    const testsLine = clean.split('\n').reverse().find((l) => /^\s*Tests\s+/.test(l));
    if (testsLine) return testsLine.trim().replace(/\s+/g, ' ');
  }
  const errorCount = (clean.match(/error TS\d+/g) ?? []).length;
  return errorCount > 0 ? `${String(errorCount)} TypeScript error(s)` : '';
}

export async function runVerification(
  runner: CommandRunner,
  steps: readonly VerificationStep[] = LUNEX_VERIFICATION_STEPS,
  options: { stopOnFailure?: boolean } = {},
): Promise<VerificationReport> {
  const outcomes: StepOutcome[] = [];
  for (const step of steps) {
    let outcome: StepOutcome;
    try {
      const result = await runner.run(step.request);
      outcome = {
        name: step.name,
        passed: result.exitCode === 0 && !result.timedOut,
        exitCode: result.exitCode,
        timedOut: result.timedOut,
        durationMs: result.durationMs,
        outputTail: tailLines(`${result.stdout}\n${result.stderr}`.trim(), 80),
        summary: summarizeOutput(step.name, result.stdout, result.stderr),
      };
    } catch (err) {
      outcome = {
        name: step.name,
        passed: false,
        exitCode: null,
        timedOut: false,
        durationMs: 0,
        outputTail: err instanceof Error ? err.message : String(err),
        summary: 'could not run',
      };
    }
    outcomes.push(outcome);
    if (!outcome.passed && options.stopOnFailure) break;
  }
  return { passed: outcomes.length === steps.length && outcomes.every((o) => o.passed), steps: outcomes };
}

export function formatStep(o: StepOutcome): string {
  const status = o.passed ? 'PASS' : o.timedOut ? 'TIMEOUT' : `FAIL (exit ${String(o.exitCode)})`;
  return `${o.name}: ${status}${o.summary ? ` -- ${o.summary}` : ''}`;
}

export function formatVerification(report: VerificationReport): string {
  return report.steps.map(formatStep).join('\n');
}
