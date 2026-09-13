/**
 * Files where a change can alter Lunex's TRADING behaviour (entry filters,
 * sizing, LP range, exit ladder, thresholds, live settings). The operator's
 * rule: strategy is never changed without an explicit instruction. Enforced
 * in code at commit time: a task whose diff touches any of these, without
 * `allowStrategyChange`, is committed on its own branch only, never
 * fast-forwarded into the integration branch, and reported BLOCKED for
 * explicit approval (`/approve <taskId>`).
 *
 * Paths are workspace-relative with forward slashes; a trailing `/` means
 * "anything under this directory".
 */
export const STRATEGY_SENSITIVE_PATHS: readonly string[] = [
  'src/config/constants.ts',
  'src/config/env.ts',
  'src/exits/resolveExitDecision.ts',
  'src/exits/safetyExit.ts',
  'src/strategies/',
  'src/capital/',
  'src/filters/',
  'src/pools/selectPool.ts',
  'src/pools/priceImpact.ts',
  'src/settings/',
  'src/api/routes/settingsSchema.ts',
  'prisma/migrations/',
];

export function findStrategySensitiveChanges(changedFiles: readonly string[], sensitive: readonly string[] = STRATEGY_SENSITIVE_PATHS): string[] {
  return changedFiles
    .map((f) => f.replace(/\\/g, '/').replace(/^\.\//, ''))
    .filter((f) => sensitive.some((s) => (s.endsWith('/') ? f.startsWith(s) : f === s)));
}

/** Workspace-relative paths the agent is never allowed to leave changed at commit time, even if a write somehow got through. */
export const COMMIT_FORBIDDEN_PATHS: readonly string[] = ['ops/lunex-ai/', '.github/', '.ai/', '.git/'];

export function findForbiddenChanges(changedFiles: readonly string[]): string[] {
  return changedFiles
    .map((f) => f.replace(/\\/g, '/'))
    .filter((f) => COMMIT_FORBIDDEN_PATHS.some((p) => f.startsWith(p)) || /(^|\/)\.env(\.|$)/.test(f) && !f.endsWith('.env.example'));
}
