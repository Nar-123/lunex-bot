/**
 * Decision 2's two-step confirmation for `/pause`/`/resume` -- process-
 * local, in-memory, best-effort UX friction only. NOT a safety guarantee
 * (the real safety already lives in `api/`'s auth and the pause semantics
 * themselves, Module 10) -- this exists purely so a fat-fingered `/pause`
 * in a chat client isn't executed instantly with no chance to back out,
 * since a chat command has no undo-click the way a UI button would.
 */

const CONFIRMATION_WINDOW_MS = 30_000;

interface PendingConfirmation {
  action: string;
  onConfirm: () => void | Promise<void>;
  timeoutHandle: ReturnType<typeof setTimeout>;
}

export class ConfirmationStore {
  private readonly pending = new Map<number, PendingConfirmation>();

  /** Arms a pending confirmation for `chatId`. Replaces any existing pending confirmation for that chat (the newer command wins, the older one is simply dropped). Auto-clears after the window elapses. */
  arm(chatId: number, action: string, onConfirm: () => void | Promise<void>): void {
    const existing = this.pending.get(chatId);
    if (existing) clearTimeout(existing.timeoutHandle);

    const timeoutHandle = setTimeout(() => {
      this.pending.delete(chatId);
    }, CONFIRMATION_WINDOW_MS);
    this.pending.set(chatId, { action, onConfirm, timeoutHandle });
  }

  /**
   * Called for every plain-text message from an authorized chat.
   * Returns `true` if this message consumed a pending confirmation
   * (whether it confirmed or not) -- the caller should not treat the
   * message as anything else once this returns `true`. Only the exact
   * text `yes` (case-insensitive, trimmed) actually triggers `onConfirm`;
   * any other text clears the pending state without acting (an explicit
   * "no," a typo, or a completely unrelated message all have the same
   * effect: the pause/resume does NOT happen).
   */
  async tryConsume(chatId: number, text: string): Promise<boolean> {
    const pending = this.pending.get(chatId);
    if (!pending) return false;

    clearTimeout(pending.timeoutHandle);
    this.pending.delete(chatId);

    if (text.trim().toLowerCase() === 'yes') {
      await pending.onConfirm();
    }
    return true;
  }

  /** Test/shutdown helper -- clears all pending confirmations and their timers. */
  clear(): void {
    for (const p of this.pending.values()) clearTimeout(p.timeoutHandle);
    this.pending.clear();
  }
}
