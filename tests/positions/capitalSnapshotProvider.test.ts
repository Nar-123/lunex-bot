import { describe, expect, it } from 'vitest';
import type { Address } from 'viem';
import { PositionCapitalSnapshotProvider } from '../../src/positions/capitalSnapshotProvider';
import { decideCapitalAllocation } from '../../src/capital/decideCapitalAllocation';
import type { CapitalRules } from '../../src/capital/types';
import { config } from '../../src/config';
import { InMemoryPositionRepository } from './inMemoryPositionRepository';
import { makeCreateInput } from './fixtures';

const WALLET = '0x9999999999999999999999999999999999999999' as Address;
const USDG = (n: number): bigint => BigInt(n) * 10n ** 18n;
const RULES: CapitalRules = config.rules.capital;

describe('PositionCapitalSnapshotProvider', () => {
  it('reports the on-chain free balance directly when there are no positions', async () => {
    const repo = new InMemoryPositionRepository();
    const provider = new PositionCapitalSnapshotProvider(repo, WALLET, async () => USDG(1000));

    const snapshot = await provider.getSnapshot();

    expect(snapshot.freeUsdgBalance).toBe(USDG(1000));
    expect(snapshot.activePositionsCount).toBe(0);
    expect(snapshot.totalDeployedUsdg).toBe(0n);
  });

  it('sums entryUsdgRaw across OPENING, ACTIVE, and CLOSING positions for totalDeployedUsdg', async () => {
    const repo = new InMemoryPositionRepository();
    const a = await repo.create(makeCreateInput({ tokenAddress: '0x0000000000000000000000000000000000000002', entryUsdgRaw: USDG(350) }));
    await repo.markActive(a.id, '1', new Date());
    const b = await repo.create(makeCreateInput({ tokenAddress: '0x0000000000000000000000000000000000000003', entryUsdgRaw: USDG(500) }));
    await repo.markActive(b.id, '2', new Date());
    // CLOSING: its LP hasn't actually been removed yet for most of the
    // exit flow, so its capital is still fully at risk -- MUST be summed.
    const c = await repo.create(makeCreateInput({ tokenAddress: '0x0000000000000000000000000000000000000004', entryUsdgRaw: USDG(200) }));
    await repo.markActive(c.id, '3', new Date());
    await repo.markClosing(c.id, 'exit:1');
    // OPENING: its USDG is still sitting in the wallet, unspent, until the
    // mint transaction mines -- included in totalDeployedUsdg (treated as
    // committed for the 90% cap), but ALSO subtracted from freeUsdgBalance
    // as a reservation, so it's never double-counted as "free" too.
    await repo.create(makeCreateInput({ tokenAddress: '0x0000000000000000000000000000000000000005', entryUsdgRaw: USDG(999) }));

    const provider = new PositionCapitalSnapshotProvider(repo, WALLET, async () => USDG(2000));
    const snapshot = await provider.getSnapshot();

    expect(snapshot.totalDeployedUsdg).toBe(USDG(2049)); // 350 + 500 + 200 + 999
    expect(snapshot.freeUsdgBalance).toBe(USDG(1001)); // 2000 on-chain - 999 reserved for the OPENING position
  });

  describe('invariant: no capital is counted as neither free nor deployed during the CLOSING window', () => {
    it('reproduces the exact gap scenario from review and confirms it is now rejected correctly', async () => {
      // 1 ACTIVE (300) + 1 CLOSING (300) + 100 free.
      // TRUE total portfolio = 700; true at-risk = 600 (closing capital
      // is still fully locked); true 90% cap = 630; true room for a new
      // position = 30. A naive 35%-of-free-balance new position (35) would
      // push true exposure to 635 -- OVER the true cap -- and must be
      // rejected. The pre-fix code (ACTIVE-only totalDeployedUsdg) saw
      // totalPortfolio=400/cap=360/projected=335 and WRONGLY approved it.
      const repo = new InMemoryPositionRepository();
      const active = await repo.create(makeCreateInput({ tokenAddress: '0x0000000000000000000000000000000000000002', entryUsdgRaw: USDG(300) }));
      await repo.markActive(active.id, '1', new Date());
      const closing = await repo.create(makeCreateInput({ tokenAddress: '0x0000000000000000000000000000000000000003', entryUsdgRaw: USDG(300) }));
      await repo.markActive(closing.id, '2', new Date());
      await repo.markClosing(closing.id, 'exit:1');

      const provider = new PositionCapitalSnapshotProvider(repo, WALLET, async () => USDG(100));
      const snapshot = await provider.getSnapshot();

      // The snapshot itself must reflect the TRUE numbers, not the buggy ones.
      expect(snapshot.freeUsdgBalance).toBe(USDG(100));
      expect(snapshot.totalDeployedUsdg).toBe(USDG(600)); // 300 + 300, not just 300
      expect(snapshot.activePositionsCount).toBe(2);

      const decision = decideCapitalAllocation(snapshot, RULES);
      // 35% of 100 free = 35; projected deployed = 600 + 35 = 635;
      // 90% of true portfolio (700) = 630 -- 635 > 630, must reject.
      expect(decision.ok).toBe(false);
    });

    it('the same scenario correctly ALLOWS a new deployment once true exposure has enough room', async () => {
      // Same shape, but the closing position is smaller (100, not 300):
      // TRUE total portfolio = 500 (100 active... wait keep active=300,
      // closing=100, free=100) = 500; true at-risk = 400; true cap = 450;
      // room = 50. New position = 35% of 100 free = 35 <= 50 -> allowed.
      const repo = new InMemoryPositionRepository();
      const active = await repo.create(makeCreateInput({ tokenAddress: '0x0000000000000000000000000000000000000002', entryUsdgRaw: USDG(300) }));
      await repo.markActive(active.id, '1', new Date());
      const closing = await repo.create(makeCreateInput({ tokenAddress: '0x0000000000000000000000000000000000000003', entryUsdgRaw: USDG(100) }));
      await repo.markActive(closing.id, '2', new Date());
      await repo.markClosing(closing.id, 'exit:1');

      const provider = new PositionCapitalSnapshotProvider(repo, WALLET, async () => USDG(100));
      const snapshot = await provider.getSnapshot();
      const decision = decideCapitalAllocation(snapshot, RULES);

      expect(decision.ok).toBe(true);
    });

    it('once the position is fully CLOSED (capital genuinely returned to the wallet), it drops out of totalDeployedUsdg and the free balance reflects it instead', async () => {
      const repo = new InMemoryPositionRepository();
      const closed = await repo.create(makeCreateInput({ tokenAddress: '0x0000000000000000000000000000000000000002', entryUsdgRaw: USDG(300) }));
      await repo.markActive(closed.id, '1', new Date());
      await repo.markClosing(closed.id, 'exit:1');
      await repo.markClosed(closed.id, new Date(), 'TRAILING_TP');

      // The wallet balance read now reflects the returned capital (this
      // provider never computes it -- it's a direct on-chain read, faked
      // here as if the exit swap already landed).
      const provider = new PositionCapitalSnapshotProvider(repo, WALLET, async () => USDG(400));
      const snapshot = await provider.getSnapshot();

      expect(snapshot.totalDeployedUsdg).toBe(0n); // no longer double-counted
      expect(snapshot.freeUsdgBalance).toBe(USDG(400)); // the capital is now here instead
      expect(snapshot.activePositionsCount).toBe(0);
    });
  });

  describe('invariant: sequential OPENING deployments before anything confirms never collectively overcommit the wallet', () => {
    it('reproduces the exact gap scenario from review: three OPENING attempts, none yet mined, must never sum past the real wallet balance', async () => {
      const repo = new InMemoryPositionRepository();
      const onChainBalance = USDG(1000);
      const readBalance = async (): Promise<bigint> => onChainBalance;

      const provider = new PositionCapitalSnapshotProvider(repo, WALLET, readBalance);

      // Deploy A: sized against the real, still-untouched wallet.
      const snapA = await provider.getSnapshot();
      const decisionA = decideCapitalAllocation(snapA, RULES);
      expect(decisionA.ok).toBe(true);
      if (!decisionA.ok) throw new Error('unreachable');
      await repo.create(makeCreateInput({ tokenAddress: '0x0000000000000000000000000000000000000002', entryUsdgRaw: decisionA.positionSizeUsdgRaw }));
      // NOTE: A's transaction is NOT mined -- onChainBalance stays 1000 throughout this test.

      // Deploy B, while A is still OPENING/unconfirmed.
      const snapB = await provider.getSnapshot();
      const decisionB = decideCapitalAllocation(snapB, RULES);
      expect(decisionB.ok).toBe(true);
      if (!decisionB.ok) throw new Error('unreachable');
      await repo.create(makeCreateInput({ tokenAddress: '0x0000000000000000000000000000000000000003', entryUsdgRaw: decisionB.positionSizeUsdgRaw }));

      // Deploy C, while A and B are BOTH still OPENING/unconfirmed.
      const snapC = await provider.getSnapshot();
      const decisionC = decideCapitalAllocation(snapC, RULES);
      expect(decisionC.ok).toBe(true);
      if (!decisionC.ok) throw new Error('unreachable');

      const totalCommitted = decisionA.positionSizeUsdgRaw + decisionB.positionSizeUsdgRaw + decisionC.positionSizeUsdgRaw;
      // The whole point: even though NONE of A/B/C ever mined (the wallet
      // balance never moved), the bot must never authorize committing
      // more than the wallet actually holds. The pre-fix formulas sized
      // each of A/B/C at 35% of a STATIC, un-decremented 1000 (350 each),
      // reaching 1050 -- more than the real 1000 balance.
      expect(totalCommitted).toBeLessThanOrEqual(onChainBalance);

      // Also confirm the snapshot itself stayed internally consistent
      // (freeUsdgBalance + totalDeployedUsdg == the true, unchanged total)
      // at every step -- not just that the final sum happens to fit.
      expect(snapA.freeUsdgBalance + snapA.totalDeployedUsdg).toBe(onChainBalance);
      expect(snapB.freeUsdgBalance + snapB.totalDeployedUsdg).toBe(onChainBalance);
      expect(snapC.freeUsdgBalance + snapC.totalDeployedUsdg).toBe(onChainBalance);
    });

    it('the free-balance/deployed split stays consistent with the true on-chain balance across repeated OPENING attempts, regardless of which cap eventually stops them', async () => {
      // Deliberately does NOT assert which specific cap (MAX_ACTIVE_POSITIONS
      // vs. the shrinking free balance) is what stops further deployment --
      // both are real, independent safety mechanisms. What this proves is
      // narrower and more important: the accounting invariant
      // (freeUsdgBalance + totalDeployedUsdg == true total) holds at every
      // step no matter how many OPENING positions pile up unconfirmed.
      const repo = new InMemoryPositionRepository();
      const onChainBalance = USDG(100);
      const provider = new PositionCapitalSnapshotProvider(repo, WALLET, async () => onChainBalance);

      for (let i = 0; i < 5; i++) {
        const snap = await provider.getSnapshot();
        expect(snap.freeUsdgBalance + snap.totalDeployedUsdg).toBe(onChainBalance);
        const decision = decideCapitalAllocation(snap, RULES);
        if (!decision.ok) break;
        await repo.create(
          makeCreateInput({
            tokenAddress: `0x${(100 + i).toString(16).padStart(40, '0')}` as `0x${string}`,
            entryUsdgRaw: decision.positionSizeUsdgRaw,
          }),
        );
      }

      const finalSnapshot = await provider.getSnapshot();
      expect(finalSnapshot.freeUsdgBalance + finalSnapshot.totalDeployedUsdg).toBe(onChainBalance);
      expect(finalSnapshot.totalDeployedUsdg).toBeLessThanOrEqual(onChainBalance);
    });
  });

  describe('invariant: a DEFINITIVELY FAILED deploy must not permanently strand its capital as reserved+deployed', () => {
    it('reproduces the exact gap from review: an unresolved failed OPENING position wrongly REJECTS a deployment the true balance has ample room for, and markFailed fixes it', async () => {
      // Wallet genuinely holds 1000 USDG, completely free except for one
      // real ACTIVE position (100). A second, unrelated deploy attempt
      // (B, sized at 850 in some earlier cycle) fails DEFINITIVELY --
      // pre-broadcast, at broadcast, or reverted, doesn't matter which --
      // its USDG never left the wallet, so onChainBalance stays 1000.
      const repo = new InMemoryPositionRepository();
      const onChainBalance = USDG(1000);
      const provider = new PositionCapitalSnapshotProvider(repo, WALLET, async () => onChainBalance);

      const a = await repo.create(makeCreateInput({ tokenAddress: '0x0000000000000000000000000000000000000002', entryUsdgRaw: USDG(100) }));
      await repo.markActive(a.id, '1', new Date());
      const b = await repo.create(makeCreateInput({ tokenAddress: '0x0000000000000000000000000000000000000003', entryUsdgRaw: USDG(850) }));
      // B's deploy transaction fails definitively here. Before `markFailed`
      // existed, NOTHING could ever move B out of OPENING -- it stays
      // OPENING forever, not just for a brief mining-delay window.

      const stuckSnapshot = await provider.getSnapshot();
      // Buggy-looking numbers: B's 850 is reserved out of free AND summed
      // into deployed, even though it was never actually spent.
      expect(stuckSnapshot.freeUsdgBalance).toBe(USDG(150)); // 1000 - 850, wrong: should be 1000
      expect(stuckSnapshot.totalDeployedUsdg).toBe(USDG(950)); // 100 + 850, wrong: should be 100
      // It does NOT disappear from both sums (the opposite failure mode) --
      // it's stuck double-committed, which is exactly why the accounting
      // identity below still balances even though every individual number
      // is wrong relative to the TRUE state:
      expect(stuckSnapshot.freeUsdgBalance + stuckSnapshot.totalDeployedUsdg).toBe(USDG(1100));

      const stuckDecision = decideCapitalAllocation(stuckSnapshot, RULES);
      // TRUE state: free=1000, deployed=100, portfolio=1100, cap=990,
      // true correct size=350, true projected=450 <= 990 -> SHOULD approve.
      // But the stuck-OPENING phantom reservation makes it compute
      // size=35%*150=52.5, projected=950+52.5=1002.5 > 990 (the cap) --
      // a deployment that should be approved is wrongly REJECTED, and
      // will stay wrongly rejected FOREVER (not just during a mining
      // window), since nothing before `markFailed` existed to clear it.
      expect(stuckDecision.ok).toBe(false);

      // The fix: mark B's row FAILED once its transaction's definitive
      // failure is known (this is `executeCriticalTransaction` returning
      // `{ ok: false, resumable: false }` -- the caller's job to react to,
      // once the deploy orchestrator exists; the repository primitive is
      // what this revision adds).
      await repo.markFailed(b.id);

      const fixedSnapshot = await provider.getSnapshot();
      expect(fixedSnapshot.freeUsdgBalance).toBe(USDG(1000)); // matches true free exactly
      expect(fixedSnapshot.totalDeployedUsdg).toBe(USDG(100)); // matches true deployed exactly
      expect(fixedSnapshot.activePositionsCount).toBe(1); // B no longer occupies a slot

      const fixedDecision = decideCapitalAllocation(fixedSnapshot, RULES);
      expect(fixedDecision.ok).toBe(true);
      if (!fixedDecision.ok) throw new Error('unreachable');
      expect(fixedDecision.positionSizeUsdgRaw).toBe(USDG(350)); // 35% of the true 1000 free
    });

    it('three small stuck-FAILED positions can permanently exhaust MAX_ACTIVE_POSITIONS on their own, independent of capital size -- markFailed on all three restores availability', async () => {
      // No ACTIVE position at all -- wallet has 1000 USDG, entirely free.
      // Three UNRELATED past deploy attempts (10 USDG each -- trivial size)
      // each failed definitively and, absent `markFailed`, are permanently
      // stuck at OPENING.
      const repo = new InMemoryPositionRepository();
      const onChainBalance = USDG(1000);
      const provider = new PositionCapitalSnapshotProvider(repo, WALLET, async () => onChainBalance);

      const stuck = await Promise.all(
        [2, 3, 4].map((n) =>
          repo.create(makeCreateInput({ tokenAddress: `0x000000000000000000000000000000000000000${n}` as `0x${string}`, entryUsdgRaw: USDG(10) })),
        ),
      );

      const stuckSnapshot = await provider.getSnapshot();
      expect(stuckSnapshot.activePositionsCount).toBe(3); // hits MAX_ACTIVE_POSITIONS (3)

      const stuckDecision = decideCapitalAllocation(stuckSnapshot, RULES);
      // Total lockout via the COUNT cap alone -- 970 USDG sits completely
      // free on-chain, yet every future deployment is rejected forever,
      // caused by 30 USDG of capital that was never actually spent.
      expect(stuckDecision.ok).toBe(false);
      if (stuckDecision.ok) throw new Error('unreachable');
      expect(stuckDecision.reason).toContain('max active positions reached');

      await Promise.all(stuck.map((p) => repo.markFailed(p.id)));

      const fixedSnapshot = await provider.getSnapshot();
      expect(fixedSnapshot.activePositionsCount).toBe(0);
      expect(fixedSnapshot.freeUsdgBalance).toBe(onChainBalance);
      expect(fixedSnapshot.totalDeployedUsdg).toBe(0n);

      const fixedDecision = decideCapitalAllocation(fixedSnapshot, RULES);
      expect(fixedDecision.ok).toBe(true);
    });
  });

  it('counts OPENING/ACTIVE/CLOSING toward activePositionsCount (the MAX_ACTIVE_POSITIONS cap), not just confirmed ACTIVE', async () => {
    const repo = new InMemoryPositionRepository();
    const opening = await repo.create(makeCreateInput({ tokenAddress: '0x0000000000000000000000000000000000000002' }));
    const active = await repo.create(makeCreateInput({ tokenAddress: '0x0000000000000000000000000000000000000003' }));
    await repo.markActive(active.id, '1', new Date());
    const closing = await repo.create(makeCreateInput({ tokenAddress: '0x0000000000000000000000000000000000000004' }));
    await repo.markActive(closing.id, '2', new Date());
    await repo.markClosing(closing.id, 'exit:1');
    const closed = await repo.create(makeCreateInput({ tokenAddress: '0x0000000000000000000000000000000000000005' }));
    await repo.markActive(closed.id, '3', new Date());
    await repo.markClosed(closed.id, new Date(), 'TRAILING_TP');

    const provider = new PositionCapitalSnapshotProvider(repo, WALLET, async () => USDG(100));
    const snapshot = await provider.getSnapshot();

    expect(snapshot.activePositionsCount).toBe(3); // opening + active + closing, not closed
    void opening;
  });
});
