import { describe, expect, it } from 'vitest';
import { sanitizeDisplayText } from '../../src/discovery/sanitize';

describe('sanitizeDisplayText', () => {
  it('leaves ordinary text untouched', () => {
    expect(sanitizeDisplayText('Foo Token 2')).toBe('Foo Token 2');
  });

  it('strips Markdown/MarkdownV2/HTML special characters', () => {
    const out = sanitizeDisplayText('*bold* _italic_ [link](url) <script>alert(1)</script>');
    expect(out).not.toMatch(/[*_[\]()<>]/);
  });

  it('strips control characters', () => {
    const withControlChar = 'foo' + String.fromCharCode(7) + 'bar';
    const out = sanitizeDisplayText(withControlChar);
    expect(out).toBe('foobar');
  });

  it('trims edge whitespace', () => {
    const out = sanitizeDisplayText('  foo  ');
    expect(out).toBe('foo');
  });

  it('truncates to maxLength', () => {
    const out = sanitizeDisplayText('a'.repeat(100), 10);
    expect(out.length).toBeLessThanOrEqual(10);
  });
});
