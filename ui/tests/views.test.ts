import { describe, expect, it } from 'vitest';
import { renderDashboard } from '../src/views/dashboard';
import { renderPositions } from '../src/views/positions';
import { renderStuck } from '../src/views/stuck';
import { renderCooldowns } from '../src/views/cooldowns';
import { renderLogs } from '../src/views/logs';
import { renderHistory } from '../src/views/history';
import { renderSettingsForm } from '../src/views/settings';
import { renderLogin } from '../src/views/login';

describe('renderDashboard', () => {
  it('shows RUNNING/PAUSED and the position/capital counts', () => {
    const html = renderDashboard({
      paused: false,
      capital: { freeUsdgBalance: '1000000000000000000000', totalDeployedUsdg: '500000000000000000000', activePositionsCount: 1, exposurePct: 33.3 },
      positions: { active: 1, opening: 0, closing: 0 },
    });
    expect(html).toContain('RUNNING');
    expect(html).toContain('33.3%');
  });

  it('shows PAUSED when paused', () => {
    const html = renderDashboard({
      paused: true,
      capital: { freeUsdgBalance: '0', totalDeployedUsdg: '0', activePositionsCount: 0, exposurePct: 0 },
      positions: { active: 0, opening: 0, closing: 0 },
    });
    expect(html).toContain('PAUSED');
    expect(html).not.toContain('RUNNING');
  });
});

describe('renderPositions', () => {
  it('reports no active positions plainly', () => {
    expect(renderPositions({ positions: [] })).toMatch(/tidak ada posisi aktif/i);
  });

  it('shows PNL/yield/range for a healthy position', () => {
    const html = renderPositions({
      positions: [
        {
          id: 'p1',
          tokenAddress: '0xabc',
          tokenSymbol: 'MEME',
          entryUsdgRaw: '1000000000000000000000',
          openedAt: null,
          metrics: { ok: true, pnlPct: 0.05, yieldPct: 0.01, inRange: true },
          oor: { outOfRange: false, elapsedMs: 0, remainingMs: 0 },
        },
      ],
    });
    expect(html).toContain('MEME');
    expect(html).toContain('5.00%');
    expect(html).toContain('in range');
  });

  it('escapes a malicious tokenSymbol rather than injecting it raw', () => {
    const html = renderPositions({
      positions: [
        {
          id: 'p1',
          tokenAddress: '0xabc',
          tokenSymbol: '<script>alert(1)</script>',
          entryUsdgRaw: '0',
          openedAt: null,
          metrics: { ok: false, reason: 'x' },
          oor: { outOfRange: false, elapsedMs: 0, remainingMs: 0 },
        },
      ],
    });
    expect(html).not.toContain('<script>alert(1)</script>');
    expect(html).toContain('&lt;script&gt;');
  });
});

describe('renderStuck', () => {
  it('reports nothing stuck plainly, positively (ok class)', () => {
    const html = renderStuck({ stuckTransactionAttempts: [], stuckSwapRetryPositionIds: [] });
    expect(html).toMatch(/tidak ada yang stuck/i);
  });

  it('renders a prominent alert banner when something is stuck', () => {
    const html = renderStuck({
      stuckTransactionAttempts: [{ id: 'a1', idempotencyKey: 'deploy:x:1', purpose: 'deploy', status: 'SENT', attemptCount: 10, firstAttemptedAt: null }],
      stuckSwapRetryPositionIds: [],
    });
    expect(html).toContain('alert-banner');
    expect(html).toContain('deploy:x:1');
  });
});

describe('renderCooldowns', () => {
  it('reports none plainly', () => {
    expect(renderCooldowns({ cooldowns: [] })).toMatch(/tidak ada token/i);
  });

  it('lists tokens with remaining time', () => {
    const html = renderCooldowns({ cooldowns: [{ tokenAddress: '0xabc', remainingMs: 120_000, cooldownEndsAt: Date.now() }] });
    expect(html).toContain('0xabc');
    expect(html).toContain('2m');
  });
});

describe('renderLogs', () => {
  it('reports empty plainly', () => {
    expect(renderLogs({ lines: [] })).toMatch(/belum ada log/i);
  });

  it('renders newest first', () => {
    const html = renderLogs({ lines: [{ ts: '2026-01-01T00:00:00Z', event: 'first' }, { ts: '2026-01-01T00:00:01Z', event: 'second' }] });
    expect(html.indexOf('second')).toBeLessThan(html.indexOf('first'));
  });
});

describe('renderHistory', () => {
  it('reports empty plainly', () => {
    expect(renderHistory({ positions: [] })).toMatch(/belum ada posisi/i);
  });

  it('shows an honest dash and the explicit disclosure when the realized PnL was never measured -- Module 11 behaviour unchanged', () => {
    const html = renderHistory({
      positions: [{ id: 'p1', tokenAddress: '0xabc', tokenSymbol: 'MEME', entryUsdgRaw: '1000000000000000000000', closedAt: '2026-01-01T00:00:00Z', closeReason: 'HARD_STOP_LOSS', realizedPnlAvailable: false }],
    });
    expect(html).toContain('MEME');
    expect(html).toContain('HARD_STOP_LOSS');
    expect(html.toLowerCase()).toContain('belum tersedia'); // explicit disclosure
    // the PnL cell renders the honest dash, never a fabricated number
    expect(html).toContain('<td>-</td>');
    expect(html).not.toContain('realizedPnlUsdgRaw'); // never leaks raw internals
  });

  it('VALIDATION PHASE: renders the MEASURED realized PnL with its sign when the server reports it', () => {
    const loss = renderHistory({
      positions: [{ id: 'p1', tokenAddress: '0xabc', tokenSymbol: 'MEME', entryUsdgRaw: '1000000000000000000000', closedAt: '2026-01-01T00:00:00Z', closeReason: 'HARD_STOP_LOSS', realizedPnlAvailable: true, realizedPnlUsdgRaw: '-900000000000000000000' }],
    });
    expect(loss).toContain('-900.00 USDG');
    expect(loss).toContain('receipt terkonfirmasi');

    const profit = renderHistory({
      positions: [{ id: 'p2', tokenAddress: '0xdef', tokenSymbol: 'PEPE', entryUsdgRaw: '100000000000000000000', closedAt: '2026-01-02T00:00:00Z', closeReason: 'HARD_TP', realizedPnlAvailable: true, realizedPnlUsdgRaw: '25000000000000000000' }],
    });
    expect(profit).toContain('+25.00 USDG');
  });

  it('mixed listing: measured rows show numbers, unmeasured rows show dashes -- never the wrong one for the other', () => {
    const html = renderHistory({
      positions: [
        { id: 'p1', tokenAddress: '0xabc', tokenSymbol: 'MEME', entryUsdgRaw: '1000000000000000000000', closedAt: '2026-01-01T00:00:00Z', closeReason: 'LOW_YIELD', realizedPnlAvailable: false },
        { id: 'p2', tokenAddress: '0xdef', tokenSymbol: 'PEPE', entryUsdgRaw: '100000000000000000000', closedAt: '2026-01-02T00:00:00Z', closeReason: 'HARD_TP', realizedPnlAvailable: true, realizedPnlUsdgRaw: '12340000000000000000' },
      ],
    });
    expect(html).toContain('+12.34 USDG');
    expect(html).toContain('<td>-</td>');
  });
});

describe('renderSettingsForm', () => {
  it('pre-fills all four editable fields with the current values and shows the frozen safetyExitTriggerPct read-only', () => {
    const html = renderSettingsForm({
      paused: false,
      positionSizePct: 35,
      maxActivePositions: 3,
      hardStopLossPct: -6,
      trailingTpTriggerPct: 6,
      safetyExitTriggerPct: -8,
      updatedAt: '2026-01-01T00:00:00Z',
    });
    expect(html).toContain('value="35"');
    expect(html).toContain('value="3"');
    expect(html).toContain('value="-6"'); // TIER 3 default, was -15
    expect(html).toContain('value="6"'); // TIER 3 default, was 5
    expect(html).toContain('Safety Exit'); // displayed for context...
    expect(html).toContain('-8%');
  });

  it('TIER 3: no longer embeds the threshold as a data attribute -- it feeds no client-side validation any more', () => {
    const html = renderSettingsForm({
      paused: false,
      positionSizePct: 35,
      maxActivePositions: 3,
      hardStopLossPct: -6,
      trailingTpTriggerPct: 6,
      safetyExitTriggerPct: -8,
      updatedAt: '2026-01-01T00:00:00Z',
    });
    expect(html).not.toContain('data-pnl-protection-trigger-pct');
    expect(html).not.toContain('data-safety-exit-trigger-pct');
  });
});

describe('renderLogin', () => {
  it('renders without an error message by default', () => {
    const html = renderLogin();
    expect(html).not.toContain('field-error');
  });

  it('renders and escapes a given error message', () => {
    const html = renderLogin('<b>bad</b>');
    expect(html).toContain('field-error');
    expect(html).not.toContain('<b>bad</b>');
    expect(html).toContain('&lt;b&gt;');
  });
});
