import { Router } from 'express';
import { z } from 'zod';
import { config } from '../config';
import { verifyPassword } from './passwordCheck';
import { signAccessToken } from './jwt';
import { createLoginRateLimiter } from './loginRateLimiter';
import type { LoginRateLimiterOptions } from './loginRateLimiter';

const loginBodySchema = z.object({
  username: z.string().min(1),
  password: z.string().min(1),
});

/**
 * `POST /auth/login` -- the only unauthenticated route in `api/`, and the
 * only one rate-limited. No `/auth/refresh` endpoint: only login was
 * requested, so `config.auth.refreshTokenExpiry` stays present-but-unused
 * (same "don't build unrequested scope" discipline as everywhere else in
 * this project).
 *
 * `rateLimiterOptions` lets tests inject a short rate-limit window instead
 * of the real 15-minute default -- same "explicit override for tests"
 * pattern as `StartAppOptions`.
 */
export function createAuthRouter(rateLimiterOptions: LoginRateLimiterOptions = {}): Router {
  const router = Router();

  router.post('/login', createLoginRateLimiter(rateLimiterOptions), async (req, res) => {
    const parsed = loginBodySchema.safeParse(req.body);
    if (!parsed.success) {
      res.status(400).json({ error: 'username and password are required' });
      return;
    }
    const { username, password } = parsed.data;

    if (username !== config.auth.adminUsername) {
      res.status(401).json({ error: 'invalid username or password' });
      return;
    }
    const passwordOk = await verifyPassword(password, config.auth.adminPasswordHash);
    if (!passwordOk) {
      res.status(401).json({ error: 'invalid username or password' });
      return;
    }

    const token = signAccessToken(username);
    res.status(200).json({ token, expiresIn: config.auth.jwtExpiry });
  });

  return router;
}
