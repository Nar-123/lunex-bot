import jwt from 'jsonwebtoken';
import { config } from '../config';

export interface AccessTokenPayload {
  sub: string;
}

/** Signs a JWT for `username`, expiring per `config.auth.jwtExpiry` (default "15m"). */
export function signAccessToken(username: string): string {
  const payload: AccessTokenPayload = { sub: username };
  return jwt.sign(payload, config.auth.jwtSecret, { expiresIn: config.auth.jwtExpiry as jwt.SignOptions['expiresIn'] });
}

export type VerifyAccessTokenResult = { ok: true; payload: AccessTokenPayload } | { ok: false; reason: string };

/** Verifies a JWT's signature and expiry. Never throws -- callers (the auth middleware) get a plain result to branch on. */
export function verifyAccessToken(token: string): VerifyAccessTokenResult {
  try {
    const decoded: unknown = jwt.verify(token, config.auth.jwtSecret);
    // jwt.verify returns string | JwtPayload; a string means the token was
    // signed without a JSON payload, which never happens for OUR tokens --
    // but narrowing to `Record<string, unknown>` keeps the check honest
    // without the tautological `typeof !== 'object'` the payload type
    // already implies.
    if (decoded === null || typeof decoded !== 'object' || Array.isArray(decoded)) {
      return { ok: false, reason: 'token payload is malformed' };
    }
    const sub = (decoded as Record<string, unknown>).sub;
    if (typeof sub !== 'string') {
      return { ok: false, reason: 'token payload is malformed' };
    }
    return { ok: true, payload: { sub } };
  } catch (err) {
    if (err instanceof jwt.TokenExpiredError) return { ok: false, reason: 'token expired' };
    if (err instanceof jwt.JsonWebTokenError) return { ok: false, reason: 'token invalid' };
    return { ok: false, reason: err instanceof Error ? err.message : String(err) };
  }
}
