import type { Task } from '../stateStore';

/**
 * The per-task Telegram report, in the operator's fixed format.
 * "Production: NOT TOUCHED" is a statement the code makes true (no deploy
 * path exists in the supervisor), not a claim copied from the model.
 */
export function formatTaskReport(task: Task): string {
  const r = task.result;
  if (!r) return `LUNEX AI\n\nTask:\n${task.title} (${task.id})\n\nStatus:\n${task.status.toUpperCase()}`;
  const changes = r.changes.length > 0 ? r.changes.slice(0, 25).map((c) => `- ${c}`).join('\n') + (r.changes.length > 25 ? `\n- ...and ${String(r.changes.length - 25)} more` : '') : '(none)';
  const lines = [
    'LUNEX AI',
    '',
    'Task:',
    `${task.title} (${task.id}, ${task.priority})`,
    '',
    'Status:',
    r.status,
    '',
    'Root cause:',
    r.rootCause || '(not reported)',
    '',
    'Changes:',
    changes,
    '',
    'Tests:',
    r.tests,
    '',
    'Build:',
    r.build,
    '',
    'Git:',
    r.git,
    '',
    'Production:',
    'NOT TOUCHED',
    '',
    'Next:',
    r.next || '(none)',
  ];
  if (r.status !== 'COMPLETED') {
    lines.push('', r.status, '', 'Reason:', r.reason ?? '(not reported)', '', 'Required action:', r.requiredAction ?? '(none)');
  }
  return lines.join('\n');
}
