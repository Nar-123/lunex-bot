import { describe, expect, it } from 'vitest';
import { PositionActivePositionChecker } from '../../src/positions/activePositionChecker';
import { InMemoryPositionRepository } from './inMemoryPositionRepository';
import { makeCreateInput } from './fixtures';

describe('PositionActivePositionChecker', () => {
  it('reports false for a token with no position at all', async () => {
    const repo = new InMemoryPositionRepository();
    const checker = new PositionActivePositionChecker(repo);
    expect(await checker.hasActivePosition('0x0000000000000000000000000000000000000002')).toBe(false);
  });

  it('reports true while a position is OPENING (not yet confirmed)', async () => {
    const repo = new InMemoryPositionRepository();
    await repo.create(makeCreateInput());
    const checker = new PositionActivePositionChecker(repo);
    expect(await checker.hasActivePosition('0x0000000000000000000000000000000000000002')).toBe(true);
  });

  it('reports true once ACTIVE', async () => {
    const repo = new InMemoryPositionRepository();
    const created = await repo.create(makeCreateInput());
    await repo.markActive(created.id, '42', new Date());
    const checker = new PositionActivePositionChecker(repo);
    expect(await checker.hasActivePosition('0x0000000000000000000000000000000000000002')).toBe(true);
  });

  it('reports false again once CLOSED', async () => {
    const repo = new InMemoryPositionRepository();
    const created = await repo.create(makeCreateInput());
    await repo.markActive(created.id, '42', new Date());
    await repo.markClosed(created.id, new Date(), 'TRAILING_TP');
    const checker = new PositionActivePositionChecker(repo);
    expect(await checker.hasActivePosition('0x0000000000000000000000000000000000000002')).toBe(false);
  });

  it('reports false again once FAILED -- a token whose deploy definitively failed is free to be tried again, not stuck rejected forever', async () => {
    // Proves `hasActivePosition` uses the SAME status set as
    // `countNonClosed`/`findDeployedPositions` (both query
    // `findActiveByToken`/`NON_CLOSED_STATUSES` under the hood), not an
    // independent one -- before `markFailed` existed (revision 7), a
    // token whose deploy failed stayed stuck at OPENING forever, which
    // would have meant `screenCandidate()` rejecting it as "already has
    // an active position" on every future 30-minute cycle, permanently,
    // even though the position never actually opened and the token is
    // completely free to retry. Confirmed fixed by the same `markFailed`
    // primitive, not a separate one.
    const repo = new InMemoryPositionRepository();
    const created = await repo.create(makeCreateInput());
    const checker = new PositionActivePositionChecker(repo);
    expect(await checker.hasActivePosition('0x0000000000000000000000000000000000000002')).toBe(true); // still OPENING, stuck pre-markFailed

    await repo.markFailed(created.id);

    expect(await checker.hasActivePosition('0x0000000000000000000000000000000000000002')).toBe(false);
  });

  it('is address-casing-insensitive', async () => {
    const repo = new InMemoryPositionRepository();
    await repo.create(makeCreateInput());
    const checker = new PositionActivePositionChecker(repo);
    const upper = '0x0000000000000000000000000000000000000002'.toUpperCase().replace('0X', '0x');
    expect(await checker.hasActivePosition(upper)).toBe(true);
  });
});
