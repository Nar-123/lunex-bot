export type FinishStatus = 'COMPLETED' | 'BLOCKED' | 'FAILED';

export type AgentAction =
  | { type: 'read_file'; path: string; startLine?: number; endLine?: number }
  | { type: 'list_dir'; path: string }
  | { type: 'search'; pattern: string; path?: string }
  | { type: 'write_file'; path: string; content: string }
  | { type: 'replace_in_file'; path: string; old: string; new: string }
  | { type: 'run'; program: string; args: string[] }
  | { type: 'checkpoint'; phase: string; note: string }
  | {
      type: 'finish';
      status: FinishStatus;
      summary: string;
      rootCause: string;
      next: string;
      reason?: string;
      requiredAction?: string;
    };

export interface ParsedReply {
  thought: string;
  action: AgentAction;
}

export class ActionParseError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'ActionParseError';
  }
}

type Json = Record<string, unknown>;

function str(obj: Json, key: string, required = true): string | undefined {
  const value = obj[key];
  if (typeof value === 'string') return value;
  if (value === undefined && !required) return undefined;
  throw new ActionParseError(`action.${key} must be a string`);
}

function optInt(obj: Json, key: string): number | undefined {
  const value = obj[key];
  if (value === undefined || value === null) return undefined;
  if (typeof value === 'number' && Number.isInteger(value) && value > 0) return value;
  throw new ActionParseError(`action.${key} must be a positive integer`);
}

/** Pulls the single JSON object out of a reply that may be wrapped in prose or a ```json fence. */
export function extractJsonObject(text: string): string {
  const fenced = /```(?:json)?\s*([\s\S]*?)```/i.exec(text);
  const candidate = fenced?.[1] ?? text;
  const start = candidate.indexOf('{');
  const end = candidate.lastIndexOf('}');
  if (start < 0 || end <= start) throw new ActionParseError('reply contains no JSON object');
  return candidate.slice(start, end + 1);
}

/**
 * Strict validation of the model's reply. Anything malformed is rejected
 * with a precise message that is fed back to the model -- a guessed
 * interpretation of an ambiguous action is never executed.
 */
export function parseAgentReply(text: string): ParsedReply {
  let parsed: unknown;
  try {
    parsed = JSON.parse(extractJsonObject(text));
  } catch (err) {
    if (err instanceof ActionParseError) throw err;
    throw new ActionParseError(`reply is not valid JSON: ${err instanceof Error ? err.message : String(err)}`);
  }
  if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) throw new ActionParseError('reply must be a JSON object');
  const root = parsed as Json;
  const thought = typeof root.thought === 'string' ? root.thought : '';
  const actionRaw = root.action;
  if (typeof actionRaw !== 'object' || actionRaw === null || Array.isArray(actionRaw)) throw new ActionParseError('reply.action must be an object');
  const a = actionRaw as Json;

  switch (a.type) {
    case 'read_file': {
      const startLine = optInt(a, 'startLine');
      const endLine = optInt(a, 'endLine');
      return { thought, action: { type: 'read_file', path: str(a, 'path') as string, ...(startLine ? { startLine } : {}), ...(endLine ? { endLine } : {}) } };
    }
    case 'list_dir':
      return { thought, action: { type: 'list_dir', path: str(a, 'path') as string } };
    case 'search': {
      const p = str(a, 'path', false);
      return { thought, action: { type: 'search', pattern: str(a, 'pattern') as string, ...(p !== undefined ? { path: p } : {}) } };
    }
    case 'write_file':
      return { thought, action: { type: 'write_file', path: str(a, 'path') as string, content: str(a, 'content') as string } };
    case 'replace_in_file':
      return { thought, action: { type: 'replace_in_file', path: str(a, 'path') as string, old: str(a, 'old') as string, new: str(a, 'new') as string } };
    case 'run': {
      const program = str(a, 'program') as string;
      if (!Array.isArray(a.args) || !a.args.every((x): x is string => typeof x === 'string')) throw new ActionParseError('action.args must be an array of strings');
      return { thought, action: { type: 'run', program, args: a.args } };
    }
    case 'checkpoint':
      return { thought, action: { type: 'checkpoint', phase: str(a, 'phase') as string, note: str(a, 'note') as string } };
    case 'finish': {
      const status = a.status;
      if (status !== 'COMPLETED' && status !== 'BLOCKED' && status !== 'FAILED') throw new ActionParseError('action.status must be COMPLETED, BLOCKED or FAILED');
      const reason = str(a, 'reason', false);
      const requiredAction = str(a, 'requiredAction', false);
      return {
        thought,
        action: {
          type: 'finish',
          status,
          summary: str(a, 'summary') as string,
          rootCause: str(a, 'rootCause', false) ?? '',
          next: str(a, 'next', false) ?? '',
          ...(reason !== undefined ? { reason } : {}),
          ...(requiredAction !== undefined ? { requiredAction } : {}),
        },
      };
    }
    default:
      throw new ActionParseError(`unknown action.type ${JSON.stringify(a.type)}`);
  }
}
