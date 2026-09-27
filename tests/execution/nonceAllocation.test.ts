import { describe, expect, it } from 'vitest';
import { allocateNonce } from '../../src/execution/nonceAllocation';

/**
 * The pure allocation rule, exercised against every way two RPC providers can
 * disagree -- plus the executor key rotation, where storage outlives the
 * identity. `executeCriticalTransaction`'s wiring of this rule (and the
 * resume/restart behaviour) is covered by `nonceRaceAcrossProviders.test.ts`.
 */
describe('allocateNonce -- start at the chain, skip what is already spent', () => {
  it('takes the chain answer when nothing local is in the way', () => {
    expect(allocateNonce({ chainPendingNonce: 7, reserved: [], signedAtOrAbove: [] })).toEqual({
      nonce: 7,
      adjustedBy: null,
      skipped: 0,
    });
  });

  it('(a) provider stale at N while a signed payload already exists for N -- allocates N+1', () => {
    // Provider A accepted our tx at nonce 5; provider B answers the next read
    // and still says pending = 5.
    expect(allocateNonce({ chainPendingNonce: 5, reserved: [], signedAtOrAbove: [5] })).toEqual({
      nonce: 6,
      adjustedBy: 'ALREADY_SIGNED',
      skipped: 1,
    });
  });

  it('(a) a provider lagging behind MANY of our settled transactions still cannot collide', () => {
    // Ten transactions signed at 3..12 while this provider is frozen at 3.
    // No credibility heuristic is involved: each taken value is skipped.
    expect(
      allocateNonce({ chainPendingNonce: 3, reserved: [], signedAtOrAbove: [3, 4, 5, 6, 7, 8, 9, 10, 11, 12] }),
    ).toEqual({ nonce: 13, adjustedBy: 'ALREADY_SIGNED', skipped: 10 });
  });

  it('believes a provider that is AHEAD -- the chain can always move the nonce forward', () => {
    // Nothing of ours is at or above 12, so 12 stands.
    expect(allocateNonce({ chainPendingNonce: 12, reserved: [], signedAtOrAbove: [] })).toEqual({
      nonce: 12,
      adjustedBy: null,
      skipped: 0,
    });
  });

  it('(e) skips a nonce reserved by another unfinished attempt', () => {
    expect(allocateNonce({ chainPendingNonce: 4, reserved: [4], signedAtOrAbove: [] })).toEqual({
      nonce: 5,
      adjustedBy: 'RESERVED_BY_ANOTHER_ATTEMPT',
      skipped: 1,
    });
  });

  it('(e) skips a whole contiguous run of reservations', () => {
    expect(allocateNonce({ chainPendingNonce: 4, reserved: [4, 5, 6], signedAtOrAbove: [] }).nonce).toBe(7);
  });

  it('(e) reservation order does not matter, and duplicates are harmless', () => {
    expect(allocateNonce({ chainPendingNonce: 4, reserved: [6, 4, 5, 4, 6], signedAtOrAbove: [] }).nonce).toBe(7);
  });

  it('skips a value taken by EITHER set, interleaved', () => {
    // 5 signed, 6 reserved, 7 signed -> 8. Both reasons applied; the
    // reservation is reported because it names a specific live attempt.
    expect(allocateNonce({ chainPendingNonce: 5, reserved: [6], signedAtOrAbove: [5, 7] })).toEqual({
      nonce: 8,
      adjustedBy: 'RESERVED_BY_ANOTHER_ATTEMPT',
      skipped: 3,
    });
  });

  it('reclaims a GAP left by an attempt that failed before signing', () => {
    // Nonce 5 was assigned then the attempt died pre-signing: it is in neither
    // set (no payload, terminal), and the chain will sit at 5 forever. A later
    // attempt holds 6. Allocating 7 would leave 5 unfilled and 6/7 unmineable.
    expect(allocateNonce({ chainPendingNonce: 5, reserved: [6], signedAtOrAbove: [6] })).toEqual({
      nonce: 5,
      adjustedBy: null,
      skipped: 0,
    });
  });

  it('ignores taken values BELOW the chain pointer -- they cannot be reclaimed', () => {
    expect(allocateNonce({ chainPendingNonce: 6, reserved: [3, 4], signedAtOrAbove: [] })).toEqual({
      nonce: 6,
      adjustedBy: null,
      skipped: 0,
    });
  });

  it('REGRESSION: an executor key rotation does not poison the nonce', () => {
    // The exact pending production migration: storage carries the OLD wallet's
    // history (signed up to 1609) while the NEW executor is at nonce 0.
    //
    // An earlier revision raised the floor to `highestSignedNonce + 1` and
    // allocated 1610 here -- a far-future nonce on a fresh account, which a
    // node accepts into its mempool and never mines: no broadcast error, no
    // revert, nothing to classify, the entry simply hangs forever. Starting at
    // the chain's answer and skipping only the specific taken values makes the
    // rotation a non-event.
    expect(allocateNonce({ chainPendingNonce: 0, reserved: [], signedAtOrAbove: [1609] })).toEqual({
      nonce: 0,
      adjustedBy: null,
      skipped: 0,
    });
  });

  it('a rotation stays safe when the old history is dense and the new account has moved a little', () => {
    const oldHistory = Array.from({ length: 40 }, (_, i) => 1570 + i);

    expect(allocateNonce({ chainPendingNonce: 3, reserved: [], signedAtOrAbove: oldHistory }).nonce).toBe(3);
    // Reservations on the NEW account are still honoured.
    expect(allocateNonce({ chainPendingNonce: 3, reserved: [3], signedAtOrAbove: oldHistory }).nonce).toBe(4);
  });

  it('handles a fresh wallet at nonce 0', () => {
    expect(allocateNonce({ chainPendingNonce: 0, reserved: [], signedAtOrAbove: [] }).nonce).toBe(0);
    expect(allocateNonce({ chainPendingNonce: 0, reserved: [0], signedAtOrAbove: [] }).nonce).toBe(1);
    expect(allocateNonce({ chainPendingNonce: 0, reserved: [], signedAtOrAbove: [0] }).nonce).toBe(1);
  });

  it('is deterministic -- the same inputs always give the same nonce', () => {
    const input = { chainPendingNonce: 5, reserved: [6, 8], signedAtOrAbove: [5, 7] } as const;
    const first = allocateNonce(input);

    for (let i = 0; i < 20; i++) expect(allocateNonce(input)).toEqual(first);
  });

  it('terminates on a large taken run without scanning unrelated values', () => {
    const run = Array.from({ length: 500 }, (_, i) => 100 + i);

    expect(allocateNonce({ chainPendingNonce: 100, reserved: [], signedAtOrAbove: run }).nonce).toBe(600);
  });

  it('rejects nonsensical inputs instead of signing under one', () => {
    // A garbage nonce must never reach the signer: throwing here lands in the
    // NONCE checkpoint, which is resumable and persists nothing.
    expect(() => allocateNonce({ chainPendingNonce: -1, reserved: [], signedAtOrAbove: [] })).toThrow(
      /non-negative integer/,
    );
    expect(() => allocateNonce({ chainPendingNonce: 1.5, reserved: [], signedAtOrAbove: [] })).toThrow(
      /non-negative integer/,
    );
    expect(() => allocateNonce({ chainPendingNonce: Number.NaN, reserved: [], signedAtOrAbove: [] })).toThrow(
      /non-negative integer/,
    );
    expect(() => allocateNonce({ chainPendingNonce: 3, reserved: [-2], signedAtOrAbove: [] })).toThrow(
      /non-negative integer/,
    );
    expect(() => allocateNonce({ chainPendingNonce: 3, reserved: [], signedAtOrAbove: [-4] })).toThrow(
      /non-negative integer/,
    );
  });
});
