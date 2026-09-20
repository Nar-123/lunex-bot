import { Router } from 'express';
import { z } from 'zod';
import { config } from '../../config';
import type { AppDeps } from '../../composition/types';
import { PERMIT2_RENEWAL_CONFIRMATION } from '../../positions/permit2Renewal';
import { assessmentToJson, inspectPermit2Renewal, renewPermit2Grant } from '../../positions/permit2RenewalAction';

/**
 * Operator-only Permit2 renewal.
 *
 *   GET  /control/permit2/renew   -- read-only readiness: current grant, time
 *                                    remaining, eligibility, and (when a
 *                                    renewal is needed) the exact transaction
 *                                    that WOULD be sent. Sends nothing.
 *   POST /control/permit2/renew   -- performs the renewal. Requires the exact
 *                                    confirmation string.
 *
 * Authorization is the same model as the existing operator actions
 * (`settle-dust`, `settle-token`): this router is mounted BEHIND the admin JWT
 * middleware, and additionally requires the authenticated user to be the
 * configured operator. The AI supervisor router is mounted in front of that
 * middleware and has its own loopback+token gate, so it can never reach this
 * route: it holds no admin JWT, and its own credential is not accepted here.
 *
 * Nothing on this route is scheduled, retried in the background, or triggered
 * by Telegram. A renewal happens only when a human sends this POST.
 */

const bodySchema = z
  .object({
    confirm: z.literal(PERMIT2_RENEWAL_CONFIRMATION),
    /** Optional: an explicit lifetime. Bounded by PERMIT2_RENEWAL.MAX_LIFETIME_SECONDS. */
    lifetimeSeconds: z.number().int().positive().optional(),
  })
  .strict();

const querySchema = z.object({ lifetimeSeconds: z.coerce.number().int().positive().optional() }).strict();

export function createPermit2RenewRouter(deps: AppDeps): Router {
  const router = Router();

  const requireOperator = (username: string | undefined): boolean => username === config.auth.adminUsername;

  router.get('/permit2/renew', async (req, res) => {
    if (!requireOperator(req.authUsername)) {
      res.status(403).json({ error: 'not authorized for operator actions' });
      return;
    }
    const parsed = querySchema.safeParse(req.query);
    if (!parsed.success) {
      res.status(422).json({ error: 'invalid query', detail: parsed.error.issues.map((i) => i.message).join('; ') });
      return;
    }
    try {
      const assessment = await inspectPermit2Renewal(parsed.data.lifetimeSeconds);
      res.status(200).json({ outcome: 'INSPECTION', ...assessmentToJson(assessment), note: 'read-only -- nothing was sent, signed or scheduled' });
    } catch (err) {
      res.status(503).json({ error: 'permit2 renewal state could not be read', detail: err instanceof Error ? err.message : String(err) });
    }
  });

  router.post('/permit2/renew', async (req, res) => {
    if (!requireOperator(req.authUsername)) {
      res.status(403).json({ error: 'not authorized for operator actions' });
      return;
    }
    const parsed = bodySchema.safeParse(req.body);
    if (!parsed.success) {
      res.status(422).json({
        error: 'invalid request',
        detail: parsed.error.issues.map((i) => i.message).join('; '),
        hint: `renewal requires {"confirm":"${PERMIT2_RENEWAL_CONFIRMATION}"}`,
      });
      return;
    }

    try {
      const result = await renewPermit2Grant(
        {
          confirm: parsed.data.confirm,
          lifetimeSeconds: parsed.data.lifetimeSeconds,
          actor: req.authUsername ?? 'unknown',
          // Same convention as the other operator routes: a caller-supplied
          // correlation id, never anything derived from a secret.
          requestId: typeof req.headers['x-request-id'] === 'string' ? req.headers['x-request-id'] : 'unknown',
        },
        { txAttempts: deps.txAttempts, log: (event, data) => { deps.logger.info(event, data); } },
      );

      if (result.outcome === 'REJECTED') {
        const status = result.reason === 'RENEWAL_NOT_NEEDED' ? 409 : result.reason === 'PREFLIGHT_UNAVAILABLE' ? 503 : 422;
        // The assessment is spread FIRST: its own human-readable `reason` must
        // not clobber the machine-readable rejection reason a client switches on.
        res.status(status).json({
          outcome: 'PERMIT2_RENEWAL_REJECTED',
          ...(result.assessment ? assessmentToJson(result.assessment) : {}),
          reason: result.reason,
          detail: result.detail,
        });
        return;
      }
      if (result.outcome === 'FAILED') {
        res.status(502).json({
          outcome: 'PERMIT2_RENEWAL_FAILED',
          ...assessmentToJson(result.assessment),
          reason: result.reason,
          resumable: result.resumable,
          idempotencyKey: result.idempotencyKey,
        });
        return;
      }
      res.status(200).json({
        outcome: 'PERMIT2_RENEWED',
        idempotencyKey: result.idempotencyKey,
        verified: { amount: result.verified.amount, expiration: result.verified.expiration, expirationIso: new Date(result.verified.expiration * 1000).toISOString(), nonce: result.verified.nonce },
        ...assessmentToJson(result.assessment),
      });
    } catch (err) {
      res.status(500).json({ error: 'permit2 renewal failed', detail: err instanceof Error ? err.message : String(err) });
    }
  });

  return router;
}
