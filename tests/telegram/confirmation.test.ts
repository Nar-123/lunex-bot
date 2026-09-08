import { describe, expect, it, vi, beforeEach, afterEach } from 'vitest';
import { ConfirmationStore } from '../../src/telegram/confirmation';

describe('ConfirmationStore', () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  it('tryConsume does nothing (returns false) when nothing is pending', async () => {
    const store = new ConfirmationStore();
    const consumed = await store.tryConsume(1, 'yes');
    expect(consumed).toBe(false);
  });

  it('replying "yes" within the window triggers onConfirm', async () => {
    const store = new ConfirmationStore();
    const onConfirm = vi.fn(async () => undefined);
    store.arm(1, 'pause', onConfirm);

    const consumed = await store.tryConsume(1, 'yes');

    expect(consumed).toBe(true);
    expect(onConfirm).toHaveBeenCalledTimes(1);
  });

  it('is case-insensitive and tolerates surrounding whitespace', async () => {
    const store = new ConfirmationStore();
    const onConfirm = vi.fn(async () => undefined);
    store.arm(1, 'pause', onConfirm);

    await store.tryConsume(1, '  YES  ');

    expect(onConfirm).toHaveBeenCalledTimes(1);
  });

  it('a non-"yes" reply consumes the pending confirmation WITHOUT triggering onConfirm', async () => {
    const store = new ConfirmationStore();
    const onConfirm = vi.fn(async () => undefined);
    store.arm(1, 'pause', onConfirm);

    const consumed = await store.tryConsume(1, 'no');

    expect(consumed).toBe(true); // the message WAS consumed by the pending confirmation...
    expect(onConfirm).not.toHaveBeenCalled(); // ...but did not trigger the action

    // And it's gone now -- a second "yes" right after does nothing.
    const secondConsumed = await store.tryConsume(1, 'yes');
    expect(secondConsumed).toBe(false);
    expect(onConfirm).not.toHaveBeenCalled();
  });

  it('letting the window expire clears the pending confirmation -- a late "yes" does nothing', async () => {
    const store = new ConfirmationStore();
    const onConfirm = vi.fn(async () => undefined);
    store.arm(1, 'pause', onConfirm);

    vi.advanceTimersByTime(30_001);

    const consumed = await store.tryConsume(1, 'yes');
    expect(consumed).toBe(false);
    expect(onConfirm).not.toHaveBeenCalled();
  });

  it('arming a new confirmation for the same chat replaces (not stacks) the previous one', async () => {
    const store = new ConfirmationStore();
    const firstOnConfirm = vi.fn(async () => undefined);
    const secondOnConfirm = vi.fn(async () => undefined);
    store.arm(1, 'pause', firstOnConfirm);
    store.arm(1, 'resume', secondOnConfirm);

    await store.tryConsume(1, 'yes');

    expect(firstOnConfirm).not.toHaveBeenCalled();
    expect(secondOnConfirm).toHaveBeenCalledTimes(1);
  });

  it('different chats have independent pending confirmations', async () => {
    const store = new ConfirmationStore();
    const chat1Confirm = vi.fn(async () => undefined);
    const chat2Confirm = vi.fn(async () => undefined);
    store.arm(1, 'pause', chat1Confirm);
    store.arm(2, 'pause', chat2Confirm);

    await store.tryConsume(1, 'yes');

    expect(chat1Confirm).toHaveBeenCalledTimes(1);
    expect(chat2Confirm).not.toHaveBeenCalled();
  });
});
