import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';
import {
  assertValidEvmAddress,
  assertValidChainSlug,
  assertValidInterval,
  assertValidLimit,
  resolveWindowsCliEntry,
} from '../../src/discovery/cliExec';

describe('assertValidEvmAddress', () => {
  it('accepts a well-formed address', () => {
    expect(assertValidEvmAddress('0x' + '11'.repeat(20))).toBe('0x' + '11'.repeat(20));
  });

  it('rejects a value crafted to look like a CLI flag', () => {
    expect(() => assertValidEvmAddress('--config=/etc/passwd')).toThrow();
  });

  it('rejects a too-short or malformed address', () => {
    expect(() => assertValidEvmAddress('0x1234')).toThrow();
    expect(() => assertValidEvmAddress('not-an-address')).toThrow();
  });
});

describe('assertValidChainSlug', () => {
  it('accepts a simple lowercase slug', () => {
    expect(assertValidChainSlug('robinhood')).toBe('robinhood');
  });

  it('rejects anything with spaces, flags, or shell-special characters', () => {
    expect(() => assertValidChainSlug('robinhood; rm -rf /')).toThrow();
    expect(() => assertValidChainSlug('--flag')).toThrow();
    expect(() => assertValidChainSlug('Robinhood')).toThrow(); // must be lowercase per the allowlist
  });
});

describe('assertValidInterval', () => {
  it('accepts the official gmgn-cli --interval values', () => {
    expect(assertValidInterval('6h')).toBe('6h');
    expect(assertValidInterval('1m')).toBe('1m');
    expect(assertValidInterval('24h')).toBe('24h');
  });

  it('rejects anything outside the NdH/NdM/NdD shape', () => {
    expect(() => assertValidInterval('--min-gas-fee')).toThrow();
    expect(() => assertValidInterval('6 hours')).toThrow();
  });
});

describe('assertValidLimit', () => {
  it('accepts an integer within range', () => {
    expect(assertValidLimit(10)).toBe(10);
  });

  it('rejects non-integers and out-of-range values', () => {
    expect(() => assertValidLimit(0)).toThrow();
    expect(() => assertValidLimit(1000)).toThrow();
    expect(() => assertValidLimit(1.5)).toThrow();
  });
});

// Synthetic npm-global layout for resolver tests -- never touches the
// machine's real install: <root>/node_modules/gmgn-cli/{package.json, dist/index.js}
const resolverRoot = mkdtempSync(join(tmpdir(), 'gmgn-resolver-'));
afterAll(() => {
  rmSync(resolverRoot, { recursive: true, force: true });
});

describe('resolveWindowsCliEntry', () => {
  it('resolves a bare gmgn-cli name to node + the real JS entry from the npm layout', () => {
    const pkgDir = join(resolverRoot, 'node_modules', 'gmgn-cli');
    mkdirSync(join(pkgDir, 'dist'), { recursive: true });
    writeFileSync(
      join(pkgDir, 'package.json'),
      JSON.stringify({ name: 'gmgn-cli', bin: { 'gmgn-cli': './dist/index.js' } }),
    );
    writeFileSync(join(pkgDir, 'dist', 'index.js'), '#!/usr/bin/env node\n');

    const resolved = resolveWindowsCliEntry('gmgn-cli', [resolverRoot]);
    expect(resolved.command).toBe(process.execPath);
    expect(resolved.args).toHaveLength(1);
    expect(resolved.args[0]).toBe(join(pkgDir, 'dist', 'index.js'));
  });

  it('leaves an explicit operator-provided GMGN_CLI_PATH untouched', () => {
    const explicit = join('C:', 'tools', 'gmgn-cli');
    expect(resolveWindowsCliEntry(explicit, [resolverRoot])).toEqual({ command: explicit, args: [] });
  });

  it('falls back to the raw command (never throws) when the package cannot be resolved', () => {
    expect(resolveWindowsCliEntry('gmgn-cli', [join(resolverRoot, 'does-not-exist')])).toEqual({
      command: 'gmgn-cli',
      args: [],
    });
  });

  it('rejects a malicious bin field that escapes the package directory', () => {
    const evilRoot = join(resolverRoot, 'evil-root');
    const pkgDir = join(evilRoot, 'node_modules', 'gmgn-cli');
    mkdirSync(pkgDir, { recursive: true });
    // Target exists OUTSIDE the package dir: <evilRoot>/outside.js
    writeFileSync(join(evilRoot, 'outside.js'), '');
    writeFileSync(
      join(pkgDir, 'package.json'),
      JSON.stringify({ name: 'gmgn-cli', bin: { 'gmgn-cli': '../../outside.js' } }),
    );

    expect(resolveWindowsCliEntry('gmgn-cli', [evilRoot])).toEqual({ command: 'gmgn-cli', args: [] });
  });
});
