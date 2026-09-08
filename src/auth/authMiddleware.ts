import type { NextFunction, Request, Response } from 'express';
import { verifyAccessToken } from './jwt';

declare module 'express-serve-static-core' {
  interface Request {
    /** Set by `authMiddleware` once a request's JWT has verified -- the username it was issued to. */
    authUsername?: string;
  }
}

/**
 * Express middleware: every route it wraps requires a valid, unexpired JWT
 * in `Authorization: Bearer <token>`. 401 on missing/malformed header,
 * invalid signature, or expiry -- never a different status code, so a
 * client can't distinguish "wrong token" from "no token" (nothing to be
 * gained by leaking that distinction).
 */
export function authMiddleware(req: Request, res: Response, next: NextFunction): void {
  const header = req.headers.authorization;
  if (!header || !header.startsWith('Bearer ')) {
    res.status(401).json({ error: 'missing or malformed Authorization header' });
    return;
  }
  const token = header.slice('Bearer '.length).trim();
  const result = verifyAccessToken(token);
  if (!result.ok) {
    res.status(401).json({ error: result.reason });
    return;
  }
  req.authUsername = result.payload.sub;
  next();
}
