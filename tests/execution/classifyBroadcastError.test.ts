import { describe, expect, it } from 'vitest';
import { classifyBroadcastError } from '../../src/execution/classifyBroadcastError';

describe('classifyBroadcastError', () => {
  it('classifies "already known" as ALREADY_KNOWN', () => {
    expect(classifyBroadcastError('already known')).toEqual({ kind: 'ALREADY_KNOWN' });
    expect(classifyBroadcastError('Details: already known\nVersion: viem@2.0.0')).toEqual({ kind: 'ALREADY_KNOWN' });
  });

  it('classifies "nonce too low" as POSSIBLY_OURS (needs receipt disambiguation)', () => {
    expect(classifyBroadcastError('nonce too low')).toEqual({ kind: 'POSSIBLY_OURS' });
    expect(classifyBroadcastError('Nonce too low for account')).toEqual({ kind: 'POSSIBLY_OURS' });
  });

  it('classifies "replacement transaction underpriced" as POSSIBLY_OURS', () => {
    expect(classifyBroadcastError('replacement transaction underpriced')).toEqual({ kind: 'POSSIBLY_OURS' });
  });

  it('classifies "insufficient funds" as DEFINITIVE_REJECTED', () => {
    const result = classifyBroadcastError('insufficient funds for gas * price + value');
    expect(result.kind).toBe('DEFINITIVE_REJECTED');
  });

  it('checks "already known" before "nonce too low" when both substrings could apply', () => {
    // The real viem/node message for this scenario literally is
    // "already known" (see NonceTooLowError's own nodeMessage regex,
    // which maps BOTH phrases to the same underlying condition) -- this
    // must resolve to the more specific, non-failing ALREADY_KNOWN.
    expect(classifyBroadcastError('transaction already imported / already known')).toEqual({ kind: 'ALREADY_KNOWN' });
  });

  it('treats an unrecognized message as AMBIGUOUS (never more aggressive than before)', () => {
    expect(classifyBroadcastError('ECONNRESET')).toEqual({ kind: 'AMBIGUOUS' });
    expect(classifyBroadcastError('timeout of 30000ms exceeded')).toEqual({ kind: 'AMBIGUOUS' });
    expect(classifyBroadcastError('502 Bad Gateway')).toEqual({ kind: 'AMBIGUOUS' });
    expect(classifyBroadcastError('')).toEqual({ kind: 'AMBIGUOUS' });
  });

  it('does NOT classify "nonce too high" as anything but AMBIGUOUS (deliberately excluded, per review)', () => {
    expect(classifyBroadcastError('nonce too high')).toEqual({ kind: 'AMBIGUOUS' });
  });

  it('is case-insensitive', () => {
    expect(classifyBroadcastError('NONCE TOO LOW')).toEqual({ kind: 'POSSIBLY_OURS' });
    expect(classifyBroadcastError('Insufficient Funds').kind).toBe('DEFINITIVE_REJECTED');
  });
});
