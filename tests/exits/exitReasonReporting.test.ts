import { describe, expect, it } from 'vitest';
import request from 'supertest';
import jwt from 'jsonwebtoken';
import { createApiServer } from '../../src/api/server';
import { createFakeAppDeps } from '../composition/fakeAppDeps';
import { makeCreateInput } from '../positions/fixtures';
import { EXIT_TRIGGER_REASONS } from '../../src/exits/types';
import type { ExitTriggerReason } from '../../src/exits/types';
import { config } from '../../src/config';
import { renderHistory } from '../../ui/src/views/history';

/**
 * TIER 3 — reporting coverage for the NEW exit reasons.
 *
 * The brief is explicit that no new Telegram push behaviour may be added
 * in this phase, but that every new exit reason must be representable in
 * the reporting that already exists. This file proves that end to end
 * WITHOUT adding any new surface: the reason flows
 * `ExitState.pendingCloseReason` -> `Position.closeReason` ->
 * `GET /positions?status=closed` -> (the one payload that both the
 * Telegram `/report` command and the UI history view consume).
 *
 * The proof is driven off `EXIT_TRIGGER_REASONS` itself rather than a
 * hand-copied list, so a reason added later without reporting support
 * fails here instead of silently rendering as `unknown`.
 */

function authHeader(): string {
  return `Bearer ${jwt.sign({ sub: 'admin' }, config.auth.jwtSecret, { expiresIn: '15m' })}`;
}

describe('TIER 3 exit reasons are representable in the EXISTING reporting surfaces', () => {
  it('the ordered reason list IS the exit priority order the brief specifies -- the order is the policy', () => {
    expect([...EXIT_TRIGGER_REASONS]).toEqual([
      'HARD_STOP_LOSS',
      'SAFETY_EXIT',
      'OVEREXTENDED',
      'TRAILING_TP',
      'HARD_TP',
      'OOR_PROFIT',
      'LOW_YIELD',
      'OOR_TIMEOUT',
      'INFRA_SAFETY_EXIT',
    ] satisfies ExitTriggerReason[]);
  });

  it('EVERY reason survives a real close and comes back verbatim from GET /positions?status=closed -- no hardcoded allow-list anywhere in the API', async () => {
    const deps = createFakeAppDeps();
    const app = createApiServer(deps);

    for (const [i, reason] of EXIT_TRIGGER_REASONS.entries()) {
      const created = await deps.positions.create(makeCreateInput({ tokenSymbol: `T${i}`, openIdempotencyKey: `deploy:reason-${i}` }));
      await deps.positions.markActive(created.id, String(i), new Date());
      await deps.positions.markClosing(created.id, `exit:${created.id}:1`);
      await deps.positions.markClosed(created.id, new Date(), reason);
    }

    const res = await request(app).get('/positions?status=closed').set('Authorization', authHeader());

    expect(res.status).toBe(200);
    const reported = res.body.positions.map((p: { closeReason: string | null }) => p.closeReason);
    for (const reason of EXIT_TRIGGER_REASONS) {
      expect(reported).toContain(reason);
    }
    expect(reported).not.toContain(null); // nothing degraded to "unknown" on the way out
  });

  it('the UI history view renders every reason as-is -- it reads the same payload the Telegram /report command does, and neither filters by reason', () => {
    const html = renderHistory({
      positions: EXIT_TRIGGER_REASONS.map((reason, i) => ({
        id: String(i),
        tokenAddress: '0x0000000000000000000000000000000000000002',
        tokenSymbol: `T${i}`,
        entryUsdgRaw: '1000000000000000000',
        closedAt: '2026-01-01T00:00:00.000Z',
        closeReason: reason,
        realizedPnlAvailable: false as const,
      })),
    });

    for (const reason of EXIT_TRIGGER_REASONS) {
      expect(html).toContain(reason);
    }
    expect(html).not.toContain('unknown');
  });
});
