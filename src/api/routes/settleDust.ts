import { Router } from 'express';
import { z } from 'zod';
import { config } from '../../config';
import type { AppDeps } from '../../composition/types';
import { DUST_CONFIRMATION, settleResidualDust } from '../../exits/dustSettlement';
import type { DustRejectReason, DustSettlementResult } from '../../exits/dustSettlement';

/**
 * `POST /positions/:id/settle-dust` -- the OPERATOR action that finalizes a
 * CLOSING position whose TOKEN residual is worth less than the gas needed to
 * sell it. It sends no transaction and touches no allowance; see
 * `exits/dustSettlement.ts` for the policy and the accounting.
 *
 * Same authorization model as the existing manual settlement route: an
 * authenticated admin JWT AND an explicit operator-identity check. The body
 * must name the close lifecycle and carry an explicit confirmation string, so
 * abandoning value can never be a one-click accident or a stray retry.
 *
 * No amount is ever accepted as input: the residual comes from the
 * remove-liquidity receipt and its value from a fresh read-only quote.
 */
const bodySchema = z
  .object({
    closeIdempotencyKey: z.string().min(1),
    confirm: z.literal(DUST_CONFIRMATION),
  })
  .strict();

/** Conditions that may resolve on their own -- the operator can simply try again later. */
const RETRYABLE: ReadonlySet<DustRejectReason> = new Set(['EXIT_TX_IN_FLIGHT', 'QUOTE_UNAVAILABLE', 'QUOTE_STALE', 'BALANCE_UNVERIFIABLE', 'CLOSE_LOST_RACE']);

function toJson(r: DustSettlementResult): Record<string, unknown> {
  if (r.outcome === 'REJECTED') return { outcome: 'DUST_SETTLEMENT_REJECTED', reason: r.reason, detail: r.detail };
  if (r.outcome === 'ALREADY_SETTLED') {
    const s = r.settlement;
    return {
      outcome: r.outcome,
      positionId: r.positionId,
      tokenAddress: s.tokenAddress,
      tokenDecimals: s.tokenDecimals,
      residualTokenRaw: s.residualTokenRaw.toString(),
      quotedUsdgRaw: s.quotedUsdgRaw.toString(),
      thresholdUsdgRaw: s.thresholdUsdgRaw.toString(),
      quotedAt: s.quotedAt,
      settledAt: s.settledAt,
      actor: s.actor,
    };
  }
  return {
    outcome: r.outcome,
    positionId: r.positionId,
    tokenAddress: r.tokenAddress,
    tokenDecimals: r.tokenDecimals,
    // What was abandoned, what it was worth, and what the bot actually received --
    // three separate numbers, never merged.
    residualTokenAbandonedRaw: r.residualTokenRaw.toString(),
    abandonedValueUsdgRaw: r.quotedUsdgRaw.toString(),
    thresholdUsdgRaw: r.thresholdUsdgRaw.toString(),
    realizedUsdgRaw: r.realizedUsdgRaw === null ? null : r.realizedUsdgRaw.toString(),
    quotedAt: r.quotedAt,
    closedAt: r.closedAt,
    note: 'TOKEN residual abandoned as dust -- no swap was performed and no proceeds were received for it',
  };
}

export function createSettleDustRouter(deps: AppDeps): Router {
  const router = Router();

  router.post('/:id/settle-dust', async (req, res) => {
    if (req.authUsername !== config.auth.adminUsername) {
      res.status(403).json({ error: 'not authorized for operator actions' });
      return;
    }
    const parsed = bodySchema.safeParse(req.body);
    if (!parsed.success) {
      res.status(400).json({
        error: `body must be exactly { closeIdempotencyKey, confirm: "${DUST_CONFIRMATION}" } -- the residual and its value are read from the receipt and a fresh quote, never accepted as input`,
      });
      return;
    }
    const requestId = typeof req.headers['x-request-id'] === 'string' ? req.headers['x-request-id'] : null;
    const result = await settleResidualDust(
      {
        positions: deps.positions,
        txAttempts: deps.txAttempts,
        swapExecutor: deps.swapExecutor,
        readTokenBalance: deps.readTokenBalanceForExit,
        walletAddress: deps.walletAddress,
        auditLog: (event, data) => { deps.logger.info(event, data); },
      },
      {
        positionId: req.params.id,
        closeIdempotencyKey: parsed.data.closeIdempotencyKey,
        confirm: parsed.data.confirm,
        actor: req.authUsername,
        requestId,
      },
    );

    const status = result.outcome === 'REJECTED' ? (RETRYABLE.has(result.reason) ? 409 : 422) : 200;
    res.status(status).json(toJson(result));
  });

  return router;
}
