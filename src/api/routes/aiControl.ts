import { Router } from 'express';
import type { NextFunction, Request, Response } from 'express';
import { createHash, randomUUID, timingSafeEqual } from 'node:crypto';
import type { AppDeps } from '../../composition/types';
import type { EntryState, EntryTransition } from '../../settings/types';

/**
 * AI Supervisor entry control -- a deliberately NARROW interface:
 *
 *   GET  /internal/ai/entry-state    read entry state (+ the counts needed to verify an action)
 *   POST /internal/ai/pause-entry    set ONLY the AI entry-pause flag
 *   POST /internal/ai/resume-entry   clear ONLY the AI entry-pause flag
 *
 * Nothing else is reachable with the AI credential: no funds, no signing, no
 * wallet/RPC/Telegram/strategy/risk settings, no position or transaction
 * records, no forced deployment. The AI can never lift the OPERATOR's pause
 * (`BotSettings.paused`): entry requires both flags clear.
 *
 * Authorization (all required, in order):
 *  1. enabled   -- `AI_SUPERVISOR_TOKEN_SHA256` configured, else 503;
 *  2. localhost -- the raw TCP peer (`req.socket.remoteAddress`, NOT `req.ip`,
 *                  which honours `trust proxy`) is loopback, else 403;
 *  3. direct    -- no reverse-proxy headers (the VPS runs Caddy, whose
 *                  proxied PUBLIC traffic also arrives from 127.0.0.1), else 403;
 *  4. token     -- `X-AI-Supervisor-Token` whose SHA-256 equals the configured
 *                  digest (constant-time compare), else 401.
 * The admin password / JWT is neither required nor accepted here, and the AI
 * token is not a JWT, so it cannot open any admin route either.
 *
 * Every mutation is an atomic compare-and-set (SettingsRepository) and emits
 * one audit event: AI_ENTRY_PAUSED | AI_ENTRY_PAUSE_NOOP | AI_ENTRY_RESUMED |
 * AI_ENTRY_RESUME_NOOP. Tokens are never logged.
 */
export const AI_TOKEN_HEADER = 'x-ai-supervisor-token';
const REQUEST_ID_HEADER = 'x-request-id';
const PROXY_HEADERS = ['x-forwarded-for', 'x-forwarded-host', 'x-forwarded-proto', 'x-real-ip', 'forwarded', 'via'];
const LOOPBACK = new Set(['127.0.0.1', '::1', '::ffff:127.0.0.1']);

export interface AiControlOptions {
  /** lowercase hex SHA-256 of the AI token; null/undefined = disabled */
  tokenSha256: string | null | undefined;
  /** Injectable for tests -- defaults to a raw-socket loopback check. */
  isLocalPeer?: (req: Request) => boolean;
}

declare module 'express-serve-static-core' {
  interface Request {
    /** Set by the AI control middleware: the validated or generated correlation id. */
    aiRequestId?: string;
  }
}

function sha256Hex(value: string): Buffer {
  return createHash('sha256').update(value, 'utf8').digest();
}

function publicState(s: EntryState) {
  return {
    entryPaused: s.entryPaused,
    aiEntryPaused: s.aiEntryPaused,
    operatorPaused: s.operatorPaused,
    aiEntryChangedAt: s.aiEntryChangedAt,
    aiEntryRequestId: s.aiEntryRequestId,
  };
}

function flags(s: EntryState) {
  return { entryPaused: s.entryPaused, aiEntryPaused: s.aiEntryPaused, operatorPaused: s.operatorPaused };
}

export function createAiControlRouter(deps: AppDeps, options: AiControlOptions): Router {
  const router = Router();
  const expected = options.tokenSha256 ? Buffer.from(options.tokenSha256, 'hex') : null;
  const isLocalPeer = options.isLocalPeer ?? ((req: Request) => LOOPBACK.has(req.socket.remoteAddress ?? ''));

  const reject = (req: Request, res: Response, status: number, reason: string): void => {
    deps.logger.warn('ai_control_rejected', { path: req.path, method: req.method, status, reason });
    res.status(status).json({ error: reason });
  };

  const authFailure = (req: Request): [number, string] | null => {
    if (!expected || expected.length !== 32) return [503, 'AI supervisor control is disabled'];
    if (!isLocalPeer(req)) return [403, 'AI supervisor control is localhost-only'];
    if (PROXY_HEADERS.some((h) => req.headers[h] !== undefined)) return [403, 'AI supervisor control must not be reached through a proxy'];
    const presented = req.headers[AI_TOKEN_HEADER];
    if (typeof presented !== 'string' || presented.length === 0) return [401, 'missing AI supervisor token'];
    if (!timingSafeEqual(sha256Hex(presented), expected)) return [401, 'invalid AI supervisor token'];
    return null;
  };

  router.use((req: Request, res: Response, next: NextFunction) => {
    const failure = authFailure(req);
    if (failure) {
      reject(req, res, failure[0], failure[1]);
      return;
    }
    const rid = req.headers[REQUEST_ID_HEADER];
    req.aiRequestId = typeof rid === 'string' && /^[A-Za-z0-9._-]{1,64}$/.test(rid) ? rid : randomUUID();
    res.setHeader('X-Request-Id', req.aiRequestId);
    next();
  });

  router.get('/entry-state', async (req, res) => {
    const [entry, active, opening, closing] = await Promise.all([
      deps.settings.getEntryState(),
      deps.positions.findAllActive(),
      deps.positions.findAllOpening(),
      deps.positions.findAllClosing(),
    ]);
    res.status(200).json({ ...publicState(entry), positions: { active: active.length, opening: opening.length, closing: closing.length }, requestId: req.aiRequestId });
  });

  const transition = (action: 'pause-entry' | 'resume-entry', t: EntryTransition, requestId: string) => {
    const event = action === 'pause-entry' ? (t.changed ? 'AI_ENTRY_PAUSED' : 'AI_ENTRY_PAUSE_NOOP') : (t.changed ? 'AI_ENTRY_RESUMED' : 'AI_ENTRY_RESUME_NOOP');
    deps.logger.info(event, {
      timestamp: new Date().toISOString(),
      action,
      actor: 'ai-supervisor',
      previousState: flags(t.previous),
      newState: flags(t.current),
      requestId,
    });
    return {
      action,
      event,
      changed: t.changed,
      previousState: publicState(t.previous),
      newState: publicState(t.current),
      requestId,
      ...(action === 'resume-entry' && t.current.operatorPaused && { note: 'the operator pause is still active -- entry remains paused until the operator resumes' }),
    };
  };

  router.post('/pause-entry', async (req, res) => {
    const requestId = req.aiRequestId ?? randomUUID();
    res.status(200).json(transition('pause-entry', await deps.settings.aiPauseEntry(requestId), requestId));
  });

  router.post('/resume-entry', async (req, res) => {
    const requestId = req.aiRequestId ?? randomUUID();
    res.status(200).json(transition('resume-entry', await deps.settings.aiResumeEntry(requestId), requestId));
  });

  return router;
}
