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
    const decoded = jwt.verify(token, config.auth.jwtSecret);
    if (typeof decoded !== 'object' || decoded === null || typeof (decoded as { sub?: unknown }).sub !== 'string') {
      return { ok: false, reason: 'token payload is malformed' };
    }
    return { ok: true, payload: { sub: (decoded as { sub: string }).sub } };
  } catch (err) {
    if (err instanceof jwt.TokenExpiredError) return { ok: false, reason: 'token expired' };
    if (err instanceof jwt.JsonWebTokenError) return { ok: false, reason: 'token invalid' };
    return { ok: false, reason: err instanceof Error ? err.message : String(err) };
  }
}
