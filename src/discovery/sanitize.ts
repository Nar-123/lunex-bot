/**
 * Token name/symbol are attacker-controlled free text -- anyone can mint a
 * token with any name -- and eventually get echoed into Telegram messages
 * and the Web UI. Sanitize at the discovery boundary (once) so nothing
 * downstream needs to remember to do it: strip control characters and
 * every character with special meaning in Markdown, Telegram's
 * MarkdownV2, or HTML, so a malicious name can't break message formatting
 * or inject markup into a rendered report.
 */
const CONTROL_CHARS_CODES: number[] = [];
for (let i = 0x00; i <= 0x1f; i++) {
  if (i !== 0x09 && i !== 0x0a && i !== 0x0d) {
    CONTROL_CHARS_CODES.push(i);
  }
}
CONTROL_CHARS_CODES.push(0x7f);
const CONTROL_CHARS_SET = new Set(CONTROL_CHARS_CODES);

const MARKUP_SPECIAL_SET = new Set(
  ['*', '_', '`', '[', ']', '(', ')', '~', '>', '#', '+', '-', '=', '|', '{', '}', '.', '!', '\\', '<', '&', '"', "'"],
);

export function sanitizeDisplayText(input: string, maxLength = 64): string {
  let out = '';
  for (const ch of input) {
    const code = ch.codePointAt(0) ?? 0;
    if (CONTROL_CHARS_SET.has(code)) continue;
    if (MARKUP_SPECIAL_SET.has(ch)) continue;
    out += ch;
  }
  return out.slice(0, maxLength).trim();
}
