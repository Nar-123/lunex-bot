import { describe, expect, it, vi } from 'vitest';
import type { Context } from 'telegraf';
import {
  handleStatus,
  handlePositions,
  handleReport,
  handleStuck,
  handleCooldowns,
  handleLogs,
  handlePause,
  handleResume,
} from '../../src/telegram/commands';
import { ConfirmationStore } from '../../src/telegram/confirmation';
import type { TelegramApiClient } from '../../src/telegram/apiClient';

function fakeCtx(chatId = 1): { ctx: Context; reply: ReturnType<typeof vi.fn> } {
  const reply = vi.fn(async () => undefined);
  const ctx = { chat: { id: chatId }, reply } as unknown as Context;
  return { ctx, reply };
}

function fakeApiClient(overrides: Partial<TelegramApiClient> = {}): TelegramApiClient {
  return {
    get: vi.fn(),
    post: vi.fn(),
    patch: vi.fn(),
    ...overrides,
  } as unknown as TelegramApiClient;
}

describe('command handlers -- success replies', () => {
  it('/status formats the status response', async () => {
    const apiClient = fakeApiClient({
      get: vi.fn(async () => ({
        paused: false,
        capital: { freeUsdgBalance: '1000', totalDeployedUsdg: '500', activePositionsCount: 1, exposurePct: 33.3 },
        positions: { active: 1, opening: 0, closing: 0 },
      })) as never,
    });
    const { ctx, reply } = fakeCtx();

    await handleStatus(apiClient, ctx);

    expect(reply).toHaveBeenCalledTimes(1);
    const text = reply.mock.calls[0]?.[0] as string;
    expect(text).toContain('RUNNING');
    expect(text).toContain('1 active');
    expect(text).toContain('33.3%');
  });

  it('/positions lists PNL/yield/range for each active position', async () => {
    const apiClient = fakeApiClient({
      get: vi.fn(async () => ({
        positions: [{ id: 'p1', tokenSymbol: 'MEME', entryUsdgRaw: '100', metrics: { ok: true, pnlPct: 0.05, yieldPct: 0.01, inRange: true } }],
      })) as never,
    });
    const { ctx, reply } = fakeCtx();

    await handlePositions(apiClient, ctx);

    const text = reply.mock.calls[0]?.[0] as string;
    expect(text).toContain('MEME');
    expect(text).toContain('5.00%');
    expect(text).toContain('in range');
  });

  it('/positions reports no active positions plainly', async () => {
    const apiClient = fakeApiClient({ get: vi.fn(async () => ({ positions: [] })) as never });
    const { ctx, reply } = fakeCtx();

    await handlePositions(apiClient, ctx);

    expect(reply.mock.calls[0]?.[0]).toMatch(/tidak ada posisi aktif/i);
  });

  it('/report maps to GET /positions?status=closed and explicitly says PNL/fee is not available', async () => {
    const get = vi.fn(async () => ({
      positions: [{ tokenSymbol: 'MEME', entryUsdgRaw: '350', closedAt: '2026-01-01T00:00:00.000Z', closeReason: 'HARD_STOP_LOSS' }],
    }));
    const apiClient = fakeApiClient({ get: get as never });
    const { ctx, reply } = fakeCtx();

    await handleReport(apiClient, ctx);

    expect(get).toHaveBeenCalledWith('/positions?status=closed');
    const text = reply.mock.calls[0]?.[0] as string;
    expect(text).toMatch(/belum tersedia/i); // the honest "PNL/fee not available" disclosure, Decision 3
    expect(text).toContain('MEME');
    expect(text).toContain('HARD_STOP_LOSS');
  });

  it('/stuck reports both stuck transaction attempts and stuck swap retries', async () => {
    const apiClient = fakeApiClient({
      get: vi.fn(async () => ({
        stuckTransactionAttempts: [{ idempotencyKey: 'deploy:x:1', status: 'SENT', attemptCount: 10 }],
        stuckSwapRetryPositionIds: ['pos-1'],
      })) as never,
    });
    const { ctx, reply } = fakeCtx();

    await handleStuck(apiClient, ctx);

    const text = reply.mock.calls[0]?.[0] as string;
    expect(text).toContain('deploy:x:1');
    expect(text).toContain('pos-1');
  });

  it('/stuck reports nothing stuck plainly', async () => {
    const apiClient = fakeApiClient({ get: vi.fn(async () => ({ stuckTransactionAttempts: [], stuckSwapRetryPositionIds: [] })) as never });
    const { ctx, reply } = fakeCtx();

    await handleStuck(apiClient, ctx);

    expect(reply.mock.calls[0]?.[0]).toMatch(/tidak ada yang stuck/i);
  });

  it('/cooldowns lists tokens with remaining time in minutes', async () => {
    const apiClient = fakeApiClient({
      get: vi.fn(async () => ({ cooldowns: [{ tokenAddress: '0xabc', remainingMs: 120_000 }] })) as never,
    });
    const { ctx, reply } = fakeCtx();

    await handleCooldowns(apiClient, ctx);

    expect(reply.mock.calls[0]?.[0]).toContain('0xabc');
    expect(reply.mock.calls[0]?.[0]).toContain('2 menit');
  });
});

describe('command handlers -- errors never leak raw text', () => {
  it('/status on an apiClient failure replies with the ONE polite fallback message, never the raw error', async () => {
    const apiClient = fakeApiClient({ get: vi.fn(async () => { throw new Error('ECONNREFUSED 127.0.0.1:8443 -- stack trace garbage'); }) as never });
    const { ctx, reply } = fakeCtx();

    await handleStatus(apiClient, ctx);

    const text = reply.mock.calls[0]?.[0] as string;
    expect(text).toBe('Gagal mengambil data, coba lagi sebentar.');
    expect(text).not.toContain('ECONNREFUSED');
    expect(text).not.toContain('stack');
  });

  it('/positions, /report, /stuck, /cooldowns all fall back to the same polite message on failure', async () => {
    const throwing = fakeApiClient({ get: vi.fn(async () => { throw new Error('boom'); }) as never });
    for (const handler of [handlePositions, handleReport, handleStuck, handleCooldowns]) {
      const { ctx, reply } = fakeCtx();
      await handler(throwing, ctx);
      expect(reply.mock.calls[0]?.[0]).toBe('Gagal mengambil data, coba lagi sebentar.');
    }
  });
});

describe('/logs [n]', () => {
  it('with no argument, requests the default limit (100)', async () => {
    const get = vi.fn(async () => ({ lines: [{ ts: 't', level: 'info', event: 'e' }] }));
    const apiClient = fakeApiClient({ get: get as never });
    const { ctx } = fakeCtx();

    await handleLogs(apiClient, ctx, undefined);

    expect(get).toHaveBeenCalledWith('/logs?limit=100');
  });

  it('/logs 50 passes n straight through as ?limit=50 (no local range clamping -- that is the API\'s job)', async () => {
    const get = vi.fn(async () => ({ lines: [] }));
    const apiClient = fakeApiClient({ get: get as never });
    const { ctx } = fakeCtx();

    await handleLogs(apiClient, ctx, '50');

    expect(get).toHaveBeenCalledWith('/logs?limit=50');
  });

  it('/logs 99999 (past the API\'s own max) is still passed straight through -- not locally clamped', async () => {
    const get = vi.fn(async () => ({ lines: [] }));
    const apiClient = fakeApiClient({ get: get as never });
    const { ctx } = fakeCtx();

    await handleLogs(apiClient, ctx, '99999');

    expect(get).toHaveBeenCalledWith('/logs?limit=99999');
  });

  it('/logs abc is rejected BEFORE ever calling the API, with a clear reply', async () => {
    const get = vi.fn();
    const apiClient = fakeApiClient({ get: get as never });
    const { ctx, reply } = fakeCtx();

    await handleLogs(apiClient, ctx, 'abc');

    expect(get).not.toHaveBeenCalled();
    expect(reply.mock.calls[0]?.[0]).toMatch(/bukan angka/i);
  });

  it('/logs -1 is rejected before ever calling the API', async () => {
    const get = vi.fn();
    const apiClient = fakeApiClient({ get: get as never });
    const { ctx } = fakeCtx();

    await handleLogs(apiClient, ctx, '-1');

    expect(get).not.toHaveBeenCalled();
  });

  it('/logs 0 is rejected before ever calling the API', async () => {
    const get = vi.fn();
    const apiClient = fakeApiClient({ get: get as never });
    const { ctx } = fakeCtx();

    await handleLogs(apiClient, ctx, '0');

    expect(get).not.toHaveBeenCalled();
  });

  it('reports "belum ada log" when the API returns an empty list', async () => {
    const apiClient = fakeApiClient({ get: vi.fn(async () => ({ lines: [] })) as never });
    const { ctx, reply } = fakeCtx();

    await handleLogs(apiClient, ctx, undefined);

    expect(reply.mock.calls[0]?.[0]).toMatch(/belum ada log/i);
  });
});

describe('/pause and /resume -- Decision 2 confirmation flow', () => {
  it('/pause asks for confirmation and does NOT call the API yet', async () => {
    const post = vi.fn(async () => ({ paused: true }));
    const apiClient = fakeApiClient({ post: post as never });
    const confirmations = new ConfirmationStore();
    const { ctx, reply } = fakeCtx();

    await handlePause(apiClient, confirmations, ctx);

    expect(post).not.toHaveBeenCalled();
    expect(reply.mock.calls[0]?.[0]).toMatch(/yakin.*pause/i);
  });

  it('replying "yes" within the window actually calls POST /control/pause', async () => {
    const post = vi.fn(async () => ({ paused: true }));
    const apiClient = fakeApiClient({ post: post as never });
    const confirmations = new ConfirmationStore();
    const { ctx: pauseCtx } = fakeCtx(42);
    await handlePause(apiClient, confirmations, pauseCtx);

    const { ctx: yesCtx, reply: yesReply } = fakeCtx(42);
    const consumed = await confirmations.tryConsume(42, 'yes');
    void yesCtx;

    expect(consumed).toBe(true);
    expect(post).toHaveBeenCalledWith('/control/pause');
    void yesReply;
  });

  it('a non-"yes" reply does NOT call the API', async () => {
    const post = vi.fn(async () => ({ paused: true }));
    const apiClient = fakeApiClient({ post: post as never });
    const confirmations = new ConfirmationStore();
    const { ctx } = fakeCtx(7);
    await handlePause(apiClient, confirmations, ctx);

    await confirmations.tryConsume(7, 'nah');

    expect(post).not.toHaveBeenCalled();
  });

  it('/resume asks for confirmation and calls POST /control/resume only after "yes"', async () => {
    const post = vi.fn(async () => ({ paused: false }));
    const apiClient = fakeApiClient({ post: post as never });
    const confirmations = new ConfirmationStore();
    const { ctx, reply } = fakeCtx(3);

    await handleResume(apiClient, confirmations, ctx);
    expect(post).not.toHaveBeenCalled();
    expect(reply.mock.calls[0]?.[0]).toMatch(/yakin.*resume/i);

    await confirmations.tryConsume(3, 'YES');
    expect(post).toHaveBeenCalledWith('/control/resume');
  });
});
