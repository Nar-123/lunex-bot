import { Router } from 'express';
import { readFileSync } from 'node:fs';
import path from 'node:path';

const DEFAULT_LOG_PATH = path.resolve(process.cwd(), 'logs', 'lunex-bot.log');
const DEFAULT_LIMIT = 100;
const MAX_LIMIT = 1000;

/**
 * `GET /logs` -- reads the newline-delimited-JSON file `composition/logger.ts`'s
 * `createConsoleFileLogger` already writes, returns the last `limit` lines
 * parsed as JSON (query param, default 100, max 1000). Deliberately
 * simple (`readFileSync` + split + slice) -- same "boleh sederhana"
 * precedent as the logger itself. Missing file (nothing logged yet, or a
 * fresh deployment) returns an empty array, not a 500. A line that fails
 * to `JSON.parse` (shouldn't happen -- the logger only ever writes
 * `JSON.stringify` output -- but never trust a file read blindly) is
 * skipped rather than crashing the whole response.
 */
export function createLogsRouter(logFilePath: string = DEFAULT_LOG_PATH): Router {
  const router = Router();

  router.get('/', (req, res) => {
    const limitParam = Number(req.query.limit);
    const limit = Number.isInteger(limitParam) && limitParam > 0 ? Math.min(limitParam, MAX_LIMIT) : DEFAULT_LIMIT;

    let content: string;
    try {
      content = readFileSync(logFilePath, 'utf8');
    } catch {
      res.status(200).json({ lines: [] });
      return;
    }

    const lines = content
      .split('\n')
      .filter((l) => l.trim().length > 0)
      .slice(-limit)
      .map((l) => {
        try {
          return JSON.parse(l) as unknown;
        } catch {
          return null;
        }
      })
      .filter((l) => l !== null);

    res.status(200).json({ lines });
  });

  return router;
}
