import { Router } from 'express';
import { z } from 'zod';
import { config } from '../../config';
import type { AppDeps } from '../../composition/types';
import { createViemSettlementChainReader, settleResidualTokenViaReceipt } from '../../exits/manualTokenSettlement';
import type { ManualSettlementChainReader, ManualSettlementResult, SettlementRejectReason } from '../../exits/manualTokenSettlement';

/**
 * Manual TOKEN settlement via receipt -- `POST /positions/:id/settle-token`.
 * Mounted AFTER `authMiddleware` (a valid JWT is required) and additionally
 * restricted to the one operator identity the auth system issues tokens
 * for (`config.auth.adminUsername`). Verification + finalization only: no
 * signing, no broadcasting, no key material.
 *
 * The body is STRICT: exactly `{ txHash, closeIdempotencyKey }`. Any other
 * field -- e.g. an amount, or a "force"/"assume settled" flag -- is a 400:
 * amounts are only ever read from the transaction's own receipt, and there
 * is no path that closes without that proof.
 */
const bodySchema = z
  .object({
    txHash: z.string().regex(/^0x[0-9a-fA-F]{64}$/),
    closeIdempotencyKey: z.string().min(1),
  })
  .strict();

const RETRYABLE: ReadonlySet<SettlementRejectReason> = new Set(['POSITION_BUSY', 'TX_PENDING', 'EXIT_TX_IN_FLIGHT', 'CHAIN_READ_FAILED']);

function toJson(r: ManualSettlementResult) {
  if (r.outcome === 'REJECTED') return { outcome: 'SETTLEMENT_REJECTED', reason: r.reason, detail: r.detail };
  return {
    outcome: r.outcome,
    positionId: r.positionId,
    txHash: r.txHash,
    tokenDisposedRaw: r.tokenDisposedRaw.toString(),
    usdgProceedsRaw: r.usdgProceedsRaw.toString(),
    realizedUsdgRaw: r.realizedUsdgRaw === null ? null : r.realizedUsdgRaw.toString(),
    closedAt: r.closedAt,
  };
}

export function createSettleTokenRouter(deps: AppDeps): Router {
  const router = Router();
  let realChain: ManualSettlementChainReader | null = null;

  router.post('/:id/settle-token', async (req, res) => {
    if (req.authUsername !== config.auth.adminUsername) {
      res.status(403).json({ error: 'not authorized for operator actions' });
      return;
    }
    const parsed = bodySchema.safeParse(req.body);
    if (!parsed.success) {
      res.status(400).json({ error: 'body must be exactly { txHash, closeIdempotencyKey } -- amounts are read from the receipt, never accepted as input' });
      return;
    }
    const chain = deps.settlementChain ?? (realChain ??= createViemSettlementChainReader());
    const result = await settleResidualTokenViaReceipt(
      {
        positions: deps.positions,
        txAttempts: deps.txAttempts,
        exitStates: deps.exitStates,
        chain,
        walletAddress: deps.walletAddress,
        log: (event, data) => { deps.logger.info(event, { ...data, operator: req.authUsername }); },
      },
      { positionId: req.params.id, txHash: parsed.data.txHash, closeIdempotencyKey: parsed.data.closeIdempotencyKey },
    );
    const status = result.outcome !== 'REJECTED' ? 200 : result.reason === 'POSITION_NOT_FOUND' ? 404 : RETRYABLE.has(result.reason) ? 409 : 422;
    res.status(status).json(toJson(result));
  });

  return router;
}
