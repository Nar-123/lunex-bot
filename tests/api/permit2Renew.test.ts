import { describe, expect, it, vi, beforeEach, afterEach } from 'vitest';
import request from 'supertest';
import type { Address } from 'viem';
import { buildTestApp, authHeader } from './testApp';
import { signAccessToken } from '../../src/auth/jwt';
import { config } from '../../src/config';
import { PERMIT2_RENEWAL_CONFIRMATION, UINT160_MAX } from '../../src/positions/permit2Renewal';
import * as renewalTx from '../../src/positions/permit2RenewalTx';
import * as action from '../../src/positions/permit2RenewalAction';

/**
 * Authorization and confirmation for `GET|POST /control/permit2/renew`.
 *
 * The route sits behind the admin JWT middleware AND an operator-identity
 * check. The AI supervisor's router is mounted in FRONT of that middleware with
 * its own loopback+token gate, so the AI's credential is not a JWT and can
 * never satisfy this route -- proven below by presenting it.
 */

const PERMIT2 = config.uniswap.v4.permit2 as Address;
const POSITION_MANAGER = config.uniswap.v4.positionManager as Address;
const USDG = config.quoteAsset.ADDRESS as Address;
const WALLET = '0x65299018ABAaa6bD89aabF689dbEf21Be99ef1Ea' as Address;
const NOW = 1_789_900_000;
const DAY = 86_400;

/** Stubs the live reads so no chain is touched; the grant is 1 day from expiry -> renewal eligible. */
function stubChain(expiration = NOW + DAY) {
  vi.spyOn(renewalTx, 'runPermit2RenewalPreflight').mockImplementation(async (lifetimeSeconds) => {
    const { assessPermit2Renewal } = await import('../../src/positions/permit2Renewal');
    return assessPermit2Renewal({
      chainId: config.chain.chainId,
      configuredChainId: config.chain.chainId,
      configuredPermit2: PERMIT2,
      positionManagerPermit2: PERMIT2,
      positionManagerSpender: POSITION_MANAGER,
      configuredToken: USDG,
      executorOwner: WALLET,
      readFor: { owner: WALLET, token: USDG, spender: POSITION_MANAGER },
      grant: { amount: UINT160_MAX, expiration, nonce: 2 },
      chainTimestamp: NOW,
      requestedLifetimeSeconds: lifetimeSeconds,
    });
  });
}

beforeEach(() => stubChain());
afterEach(() => { vi.restoreAllMocks(); });

describe('23. admin-only', () => {
  it('no token -> 401, and nothing is assessed', async () => {
    const { app } = buildTestApp();
    for (const r of [request(app).get('/control/permit2/renew'), request(app).post('/control/permit2/renew').send({ confirm: PERMIT2_RENEWAL_CONFIRMATION })]) {
      expect((await r).status).toBe(401);
    }
  });

  it('a valid JWT for a NON-operator user -> 403', async () => {
    const { app } = buildTestApp();
    const other = `Bearer ${signAccessToken('someone-else')}`;
    expect((await request(app).get('/control/permit2/renew').set('Authorization', other)).status).toBe(403);
    const post = await request(app).post('/control/permit2/renew').set('Authorization', other).send({ confirm: PERMIT2_RENEWAL_CONFIRMATION });
    expect(post.status).toBe(403);
    expect(post.body.error).toMatch(/not authorized for operator actions/);
  });

  it('the operator can read the readiness inspection', async () => {
    const { app } = buildTestApp();
    const res = await request(app).get('/control/permit2/renew').set('Authorization', authHeader());
    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({ outcome: 'INSPECTION', status: 'RENEWAL_NEEDED', renewalEligible: true });
    expect(res.body.note).toMatch(/nothing was sent/);
  });
});

describe('22. the AI supervisor has no path to a renewal', () => {
  it("the AI's own token is not accepted by the renewal route", async () => {
    const { app } = buildTestApp();
    const res = await request(app)
      .post('/control/permit2/renew')
      .set('x-ai-supervisor-token', 'whatever-the-ai-holds')
      .send({ confirm: PERMIT2_RENEWAL_CONFIRMATION });
    expect(res.status).toBe(401); // never even reaches the operator check
  });

  it('the AI control surface exposes only entry-state/pause/resume -- no renewal route', async () => {
    const { app } = buildTestApp();
    for (const p of ['/internal/ai/permit2/renew', '/internal/ai/renew', '/internal/ai/control/permit2/renew']) {
      const res = await request(app).post(p).send({ confirm: PERMIT2_RENEWAL_CONFIRMATION });
      expect([401, 403, 404, 503]).toContain(res.status);
      expect(res.body.outcome).toBeUndefined(); // never a renewal outcome
    }
  });

  it('pausing/resuming entry as the AI cannot trigger a renewal', async () => {
    const renew = vi.spyOn(action, 'renewPermit2Grant');
    const { app, deps } = buildTestApp();
    await deps.settings.aiPauseEntry('rid-1');
    await deps.settings.aiResumeEntry('rid-2');
    await request(app).get('/status').set('Authorization', authHeader());
    expect(renew).not.toHaveBeenCalled();
  });
});

describe('24. explicit confirmation required', () => {
  it.each([
    ['missing', {}],
    ['wrong string', { confirm: 'yes' }],
    ['lowercase', { confirm: 'renew_permit2_grant' }],
    ['near miss', { confirm: 'RENEW_PERMIT2' }],
    ['extra field', { confirm: PERMIT2_RENEWAL_CONFIRMATION, spender: '0xdeadbeef' }],
  ])('%s -> 422, and no renewal is attempted', async (_label, body) => {
    const renew = vi.spyOn(action, 'renewPermit2Grant');
    const { app } = buildTestApp();
    const res = await request(app).post('/control/permit2/renew').set('Authorization', authHeader()).send(body);
    expect(res.status).toBe(422);
    expect(renew).not.toHaveBeenCalled();
  });

  it('a spender supplied in the body is rejected outright -- it can never influence the transaction', async () => {
    const { app } = buildTestApp();
    const res = await request(app)
      .post('/control/permit2/renew')
      .set('Authorization', authHeader())
      .send({ confirm: PERMIT2_RENEWAL_CONFIRMATION, spender: '0x0000000000000000000000000000000000000bad' });
    expect(res.status).toBe(422);
  });

  it('a lifetime beyond the configured maximum is refused by the policy, not silently clamped', async () => {
    const { app } = buildTestApp();
    const res = await request(app)
      .post('/control/permit2/renew')
      .set('Authorization', authHeader())
      .send({ confirm: PERMIT2_RENEWAL_CONFIRMATION, lifetimeSeconds: config.rules.execution.PERMIT2_RENEWAL.MAX_LIFETIME_SECONDS + 1 });
    expect(res.status).toBe(422);
    expect(res.body).toMatchObject({ outcome: 'PERMIT2_RENEWAL_REJECTED', reason: 'PREFLIGHT_BLOCKED' });
    expect(res.body.detail).toMatch(/exceeds the configured maximum/);
  });
});

describe('the inspection reports renewal readiness without sending anything', () => {
  it('a valid grant reports VALID_CURRENT with no transaction', async () => {
    stubChain(NOW + 60 * DAY);
    const { app } = buildTestApp();
    const res = await request(app).get('/control/permit2/renew').set('Authorization', authHeader());
    expect(res.body).toMatchObject({ status: 'VALID_CURRENT', renewalEligible: false, renewalRecommended: false, wouldSend: null, idempotencyKey: null });
  });

  it('an eligible grant reports the exact transaction that WOULD be sent', async () => {
    const { app } = buildTestApp();
    const res = await request(app).get('/control/permit2/renew').set('Authorization', authHeader());
    expect(res.body.wouldSend).toMatchObject({
      to: PERMIT2,
      from: WALLET,
      chainId: config.chain.chainId,
      value: '0',
      decoded: { function: 'approve(address token,address spender,uint160 amount,uint48 expiration)', token: USDG, spender: POSITION_MANAGER, amount: UINT160_MAX.toString() },
    });
    expect(res.body.wouldSend.data).toMatch(/^0x87517c45/);
    expect(res.body.currentNonce).toBe(2);
    expect(res.body.secondsUntilExpiry).toBe(DAY);
  });

  it('POST on an already-valid grant is 409 and sends nothing', async () => {
    stubChain(NOW + 60 * DAY);
    const { app } = buildTestApp();
    const res = await request(app).post('/control/permit2/renew').set('Authorization', authHeader()).send({ confirm: PERMIT2_RENEWAL_CONFIRMATION });
    expect(res.status).toBe(409);
    expect(res.body).toMatchObject({ outcome: 'PERMIT2_RENEWAL_REJECTED', reason: 'RENEWAL_NOT_NEEDED' });
  });

  it('an unreadable chain is 503, never an assumed-valid or assumed-needed answer', async () => {
    vi.spyOn(renewalTx, 'runPermit2RenewalPreflight').mockRejectedValue(new Error('rpc down'));
    const { app } = buildTestApp();
    expect((await request(app).get('/control/permit2/renew').set('Authorization', authHeader())).status).toBe(503);
  });
});
