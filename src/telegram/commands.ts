import { formatUnits } from 'viem';
import type { Context } from 'telegraf';
import { config } from '../config';
import type { TelegramApiClient } from './apiClient';
import type { ConfirmationStore } from './confirmation';

const GENERIC_ERROR_REPLY = 'Gagal mengambil data, coba lagi sebentar.';

/** Wraps every command handler: any `apiClient` failure (network error, API down, timeout, non-2xx) becomes this one polite message -- NEVER a raw error/stack sent to the chat. */
async function safely(ctx: Context, fn: () => Promise<string>): Promise<void> {
  let reply: string;
  try {
    reply = await fn();
  } catch {
    reply = GENERIC_ERROR_REPLY;
  }
  await ctx.reply(reply);
}

interface StatusResponse {
  paused: boolean;
  capital: { freeUsdgBalance: string; totalDeployedUsdg: string; activePositionsCount: number; exposurePct: number };
  positions: { active: number; opening: number; closing: number };
}

export async function handleStatus(apiClient: TelegramApiClient, ctx: Context): Promise<void> {
  await safely(ctx, async () => {
    const s = await apiClient.get<StatusResponse>('/status');
    return (
      `Status: ${s.paused ? 'PAUSED' : 'RUNNING'}\n` +
      `Posisi: ${s.positions.active} active, ${s.positions.opening} opening, ${s.positions.closing} closing\n` +
      `Free USDG: ${usdgFromRaw(s.capital.freeUsdgBalance)}\n` +
      `Deployed USDG: ${usdgFromRaw(s.capital.totalDeployedUsdg)}\n` +
      `Exposure: ${s.capital.exposurePct.toFixed(1)}%`
    );
  });
}

interface ActivePosition {
  id: string;
  tokenSymbol: string;
  entryUsdgRaw: string;
  metrics: { ok: true; pnlPct: number; yieldPct: number; inRange: boolean } | { ok: false; reason: string };
}
interface PositionsResponse {
  positions: ActivePosition[];
}

export async function handlePositions(apiClient: TelegramApiClient, ctx: Context): Promise<void> {
  await safely(ctx, async () => {
    const r = await apiClient.get<PositionsResponse>('/positions');
    if (r.positions.length === 0) return 'Tidak ada posisi aktif.';
    return r.positions
      .map((p) => {
        if (!p.metrics.ok) return `${p.tokenSymbol}: metrics error (${p.metrics.reason})`;
        return `${p.tokenSymbol}: PNL ${(p.metrics.pnlPct * 100).toFixed(2)}%, yield ${(p.metrics.yieldPct * 100).toFixed(2)}%, ${p.metrics.inRange ? 'in range' : 'OUT OF RANGE'}`;
      })
      .join('\n');
  });
}

interface ClosedPosition {
  tokenSymbol: string;
  entryUsdgRaw: string;
  closedAt: string | null;
  closeReason: string | null;
  realizedPnlAvailable: boolean;
  realizedPnlUsdgRaw?: string;
}
interface ClosedPositionsResponse {
  positions: ClosedPosition[];
}

/**
 * The ONE formatter for every user-facing USDG amount in this module --
 * display only, never arithmetic, and it never touches a stored value.
 *
 * Every USDG field the API sends is a raw `bigint.toString()` (see
 * `api/routes/status.ts`, `positions.ts` and `stuck.ts`, which all serialise
 * a bigint), so each one has to be scaled before a human reads it.
 *
 * Reporting bug fix: this divided by 10^18 while USDG on this chain has
 * `config.quoteAsset.DECIMALS` (6) decimals -- the value every other module
 * scales by, and the value `assertQuoteAssetDecimalsMatchOnChain` verifies
 * against the token contract at startup. A realized PnL of 3.50 USDG
 * (3_500_000 raw) therefore rendered as `0`: with integer division by 10^18,
 * EVERY realistic PnL at this project's position sizes displayed as zero, and
 * a loss as `-0`. The decimals are read from config rather than hardcoded so
 * this cannot drift from the token again.
 *
 * `formatUnits` (viem, already this project's tool for the same job in
 * `validate-live-rpc.ts`) keeps the fractional part and handles negatives,
 * which a truncating whole-number division could not.
 */
function usdgFromRaw(raw: string): string {
  try {
    return formatUnits(BigInt(raw), config.quoteAsset.DECIMALS);
  } catch {
    return raw;
  }
}

/**
 * Same formatting, for a field the API may send as null -- and, since these
 * responses are typed but never runtime-validated, possibly absent entirely.
 * Preserves the original `?? '?'` behaviour: an unknown amount reads as `?`,
 * never as `undefined` and never as a misleading `0`.
 */
function usdgOrUnknown(raw: string | null | undefined): string {
  return raw === null || raw === undefined ? '?' : usdgFromRaw(raw);
}

export async function handleReport(apiClient: TelegramApiClient, ctx: Context): Promise<void> {
  await safely(ctx, async () => {
    const r = await apiClient.get<ClosedPositionsResponse>('/positions?status=closed');
    if (r.positions.length === 0) return 'Belum ada posisi yang closed.';
    const lines = r.positions
      .slice(0, 20)
      .map((p) => {
        const pnl =
          p.realizedPnlAvailable && p.realizedPnlUsdgRaw !== undefined
            ? `, realized PnL ${usdgFromRaw(p.realizedPnlUsdgRaw)} USDG`
            : ', realized PnL n/a';
        return `${p.tokenSymbol}: closed (${p.closeReason ?? 'unknown'}) at ${p.closedAt ?? '?'}, entry ${usdgFromRaw(p.entryUsdgRaw)} USDG${pnl}`;
      });
    const measured = r.positions.some((p) => p.realizedPnlAvailable);
    const header = measured
      ? 'Realized PnL = exit proceeds (receipt terkonfirmasi) - entry; "n/a" = tidak terukur.'
      : 'PNL/fee realized belum tersedia -- lihat catatan Module 11.';
    return [header, ...lines].join('\n');
  });
}

interface StuckResponse {
  stuckTransactionAttempts: Array<{ idempotencyKey: string; status: string; attemptCount: number }>;
  stuckSwapRetryPositionIds: string[];
  closingPositions?: Array<{
    positionId: string;
    tokenSymbol: string;
    phase: string;
    operatorActionRequired: boolean;
    closingAgeMs: number | null;
    tokenResidualRaw: string | null;
    usdgRecoveredRaw: string | null;
    lastCheckedAt: string | null;
  }>;
}

export async function handleStuck(apiClient: TelegramApiClient, ctx: Context): Promise<void> {
  await safely(ctx, async () => {
    const r = await apiClient.get<StuckResponse>('/positions/stuck');
    // Unroutable TOKEN leg: CLOSING positions that are not simply moving
    // along (blocked, failing, ambiguous, or flagged for the operator).
    const QUIET = new Set(['REMOVE_NOT_STARTED', 'REMOVE_IN_PROGRESS', 'SWAP_PENDING', 'READY_TO_FINALIZE']);
    const closing = (r.closingPositions ?? []).filter((c) => c.operatorActionRequired || !QUIET.has(c.phase));
    if (r.stuckTransactionAttempts.length === 0 && r.stuckSwapRetryPositionIds.length === 0 && closing.length === 0) {
      return 'Tidak ada yang stuck.';
    }
    const lines: string[] = [];
    for (const c of closing) {
      const age = c.closingAgeMs === null ? '?' : `${Math.floor(c.closingAgeMs / 60_000)}m`;
      lines.push(
        `${c.operatorActionRequired ? 'PERLU TINDAKAN OPERATOR' : 'CLOSING'}: ${c.tokenSymbol} (${c.positionId}) -- ${c.phase}, umur ${age}, ` +
          `TOKEN tersisa ${c.tokenResidualRaw ?? '?'} (raw), USDG kembali ${usdgOrUnknown(c.usdgRecoveredRaw)}, cek terakhir ${c.lastCheckedAt ?? '-'}`,
      );
    }
    for (const a of r.stuckTransactionAttempts) lines.push(`Attempt stuck: ${a.idempotencyKey} (${a.status}, ${a.attemptCount}x)`);
    for (const id of r.stuckSwapRetryPositionIds) lines.push(`Swap retry stuck: position ${id}`);
    return lines.join('\n');
  });
}

interface CooldownsResponse {
  cooldowns: Array<{ tokenAddress: string; remainingMs: number }>;
}

export async function handleCooldowns(apiClient: TelegramApiClient, ctx: Context): Promise<void> {
  await safely(ctx, async () => {
    const r = await apiClient.get<CooldownsResponse>('/cooldowns');
    if (r.cooldowns.length === 0) return 'Tidak ada token dalam cooldown.';
    return r.cooldowns.map((c) => `${c.tokenAddress}: ${Math.ceil(c.remainingMs / 60_000)} menit lagi`).join('\n');
  });
}

const LOGS_DEFAULT_LIMIT = 100;

interface LogsResponse {
  lines: Array<{ ts?: string; level?: string; event?: string }>;
}

/**
 * `n` is passed straight through as `?limit=n` -- the API itself already
 * clamps to its own [default 100, max 1000] range (Module 10); this
 * command does NOT duplicate that business rule, it only rejects `n`
 * before ever calling the API if it isn't a plausible positive integer at
 * all (so `/logs abc` gets an immediate, clear reply instead of silently
 * sending a garbage query param).
 */
export async function handleLogs(apiClient: TelegramApiClient, ctx: Context, arg: string | undefined): Promise<void> {
  let limit = LOGS_DEFAULT_LIMIT;
  if (arg !== undefined) {
    const parsed = Number(arg);
    if (!Number.isInteger(parsed) || parsed <= 0) {
      await ctx.reply(`"${arg}" bukan angka positif yang valid. Contoh: /logs 50`);
      return;
    }
    limit = parsed;
  }

  await safely(ctx, async () => {
    const r = await apiClient.get<LogsResponse>(`/logs?limit=${limit}`);
    if (r.lines.length === 0) return 'Belum ada log.';
    return r.lines.map((l) => `[${l.ts ?? '?'}] ${l.level ?? '?'} ${l.event ?? '?'}`).join('\n');
  });
}

/** `/pause` and `/resume` -- Decision 2: arms a confirmation instead of calling the API immediately. */
function askPauseResumeConfirmation(action: 'pause' | 'resume', apiClient: TelegramApiClient, confirmations: ConfirmationStore, ctx: Context): Promise<void> {
  const chatId = ctx.chat?.id;
  if (chatId === undefined) return Promise.resolve();

  confirmations.arm(chatId, action, async () => {
    await safely(ctx, async () => {
      const r = await apiClient.post<{ paused: boolean }>(`/control/${action}`);
      return r.paused ? 'Bot di-pause.' : 'Bot di-resume.';
    });
  });

  return ctx.reply(`Yakin mau ${action} bot? Balas "yes" dalam 30 detik untuk konfirmasi.`).then(() => undefined);
}

export function handlePause(apiClient: TelegramApiClient, confirmations: ConfirmationStore, ctx: Context): Promise<void> {
  return askPauseResumeConfirmation('pause', apiClient, confirmations, ctx);
}

export function handleResume(apiClient: TelegramApiClient, confirmations: ConfirmationStore, ctx: Context): Promise<void> {
  return askPauseResumeConfirmation('resume', apiClient, confirmations, ctx);
}
