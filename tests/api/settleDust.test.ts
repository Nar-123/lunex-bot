import { describe, expect, it, vi } from 'vitest';
import request from 'supertest';
import type { Address } from 'viem';
import { buildTestApp, authHeader } from './testApp';
import { signAccessToken } from '../../src/auth/jwt';
import { InMemoryPositionRepository } from '../positions/inMemoryPositionRepository';
import { InMemoryTransactionAttemptRepository } from '../execution/inMemoryTransactionAttemptRepository';
import { makeCreateInput } from '../positions/fixtures';
import { DUST_CONFIRMATION } from '../../src/exits/dustSettlement';
import { config } from '../../src/config';

const TOKEN = '0x0000000000000000000000000000000000000002' as Address;
const RESIDUAL = 14467194911816926n;
const REMOVE_USDG = 20_915_201n;

/** A CLOSING position with a VERIFIED remove-liquidity leg carrying a dust residual. */
async function appWithClosingPosition(quotedUsdgRaw: bigint) {
  const positions = new InMemoryPositionRepository();
  const txAttempts = new InMemoryTransactionAttemptRepository();
  const created = await positions.create(makeCreateInput({ entryUsdgRaw: 20_906_915n, tokenAddress: TOKEN }));
  await positions.markActive(created.id, '1', new Date());
  await positions.markClosing(created.id, `exit:${created.id}:lifecycle-1`);
  const position = (await positions.findById(created.id))!;
  const attempt = await txAttempts.create(`${position.closeIdempotencyKey}:removeLiquidity`, 'exit:removeLiquidity');
  await txAttempts.update(attempt.id, {
    status: 'VERIFIED',
    verifyData: { liquidityZero: true, usdgProceedsRaw: REMOVE_USDG.toString(), tokenProceedsRaw: RESIDUAL.toString() },
  });
  const buildSwapTx = vi.fn(async () => { throw new Error('the dust route must never build a swap'); });
  const { app, deps } = buildTestApp({
    positions,
    txAttempts,
    readTokenBalanceForExit: vi.fn(async () => 10n ** 30n),
    swapExecutor: {
      getQuote: vi.fn(async (_t: Address, amountInRaw: bigint) => ({ amountInRaw, expectedAmountOutRaw: quotedUsdgRaw, minOutputAmountRaw: 0n, priceImpactPct: 0.001, slippageBps: 100, providerQuote: {} })),
      checkApproval: vi.fn(async () => ({ needsApproval: false, spender: null })),
      buildSwapTx,
    } as never,
  });
  return { app, deps, positions, txAttempts, position, buildSwapTx };
}

const body = (key: string) => ({ closeIdempotencyKey: key, confirm: DUST_CONFIRMATION });

describe('POST /positions/:id/settle-dust', () => {
  it('settles a dust residual for an authenticated operator and reports the three numbers separately', async () => {
    const ctx = await appWithClosingPosition(8_712n);
    const res = await request(ctx.app).post(`/positions/${ctx.position.id}/settle-dust`).set('Authorization', authHeader()).set('X-Request-Id', 'op-1').send(body(ctx.position.closeIdempotencyKey!));

    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({
      outcome: 'SETTLED',
      positionId: ctx.position.id,
      residualTokenAbandonedRaw: RESIDUAL.toString(),
      abandonedValueUsdgRaw: '8712',
      thresholdUsdgRaw: config.rules.exits.DUST_SETTLEMENT.MAX_USDG_VALUE_RAW.toString(),
      realizedUsdgRaw: REMOVE_USDG.toString(),
    });
    expect(res.body.note).toMatch(/no swap was performed/);
    expect(JSON.stringify(res.body)).not.toMatch(/txHash/);
    expect((await ctx.positions.findById(ctx.position.id))?.status).toBe('CLOSED');
    expect(ctx.buildSwapTx).not.toHaveBeenCalled();
  });

  it('12. rejects an unauthenticated request (no token at all)', async () => {
    const ctx = await appWithClosingPosition(8_712n);
    const res = await request(ctx.app).post(`/positions/${ctx.position.id}/settle-dust`).send(body(ctx.position.closeIdempotencyKey!));
    expect(res.status).toBe(401);
    expect((await ctx.positions.findById(ctx.position.id))?.status).toBe('CLOSING');
  });

  it('12. rejects a valid NON-operator token', async () => {
    const ctx = await appWithClosingPosition(8_712n);
    const res = await request(ctx.app)
      .post(`/positions/${ctx.position.id}/settle-dust`)
      .set('Authorization', `Bearer ${signAccessToken('someone-else')}`)
      .send(body(ctx.position.closeIdempotencyKey!));
    expect(res.status).toBe(403);
    expect((await ctx.positions.findById(ctx.position.id))?.status).toBe('CLOSING');
  });

  it('requires the explicit confirmation field and rejects extra/missing fields', async () => {
    const ctx = await appWithClosingPosition(8_712n);
    const key = ctx.position.closeIdempotencyKey!;
    for (const payload of [{ closeIdempotencyKey: key }, { closeIdempotencyKey: key, confirm: 'yes' }, { confirm: DUST_CONFIRMATION }, { ...body(key), amountRaw: '1' }]) {
      const res = await request(ctx.app).post(`/positions/${ctx.position.id}/settle-dust`).set('Authorization', authHeader()).send(payload);
      expect(res.status).toBe(400);
    }
    expect((await ctx.positions.findById(ctx.position.id))?.status).toBe('CLOSING');
  });

  it('refuses a residual that is NOT dust (422) and leaves the position CLOSING', async () => {
    const ctx = await appWithClosingPosition(config.rules.exits.DUST_SETTLEMENT.MAX_USDG_VALUE_RAW);
    const res = await request(ctx.app).post(`/positions/${ctx.position.id}/settle-dust`).set('Authorization', authHeader()).send(body(ctx.position.closeIdempotencyKey!));
    expect(res.status).toBe(422);
    expect(res.body).toMatchObject({ outcome: 'DUST_SETTLEMENT_REJECTED', reason: 'NOT_DUST' });
    expect((await ctx.positions.findById(ctx.position.id))?.status).toBe('CLOSING');
  });

  it('a retryable condition (in-flight exit tx) answers 409', async () => {
    const ctx = await appWithClosingPosition(8_712n);
    const swap = await ctx.txAttempts.create(`${ctx.position.closeIdempotencyKey}:swap:0`, 'exit:swap');
    await ctx.txAttempts.update(swap.id, { status: 'SENT' });
    const res = await request(ctx.app).post(`/positions/${ctx.position.id}/settle-dust`).set('Authorization', authHeader()).send(body(ctx.position.closeIdempotencyKey!));
    expect(res.status).toBe(409);
    expect(res.body.reason).toBe('EXIT_TX_IN_FLIGHT');
  });

  it('19. a repeated request is idempotent over HTTP', async () => {
    const ctx = await appWithClosingPosition(8_712n);
    const key = ctx.position.closeIdempotencyKey!;
    const first = await request(ctx.app).post(`/positions/${ctx.position.id}/settle-dust`).set('Authorization', authHeader()).send(body(key));
    const second = await request(ctx.app).post(`/positions/${ctx.position.id}/settle-dust`).set('Authorization', authHeader()).send(body(key));
    expect(first.body.outcome).toBe('SETTLED');
    expect(second.status).toBe(200);
    expect(second.body.outcome).toBe('ALREADY_SETTLED');
    expect(ctx.positions.dustSettlements.size).toBe(1);
  });

  it('11. a lifecycle mismatch is refused', async () => {
    const ctx = await appWithClosingPosition(8_712n);
    const res = await request(ctx.app).post(`/positions/${ctx.position.id}/settle-dust`).set('Authorization', authHeader()).send(body('exit:not-this-lifecycle'));
    expect(res.status).toBe(422);
    expect(res.body.reason).toBe('STALE_CLOSE_LIFECYCLE');
  });
});
