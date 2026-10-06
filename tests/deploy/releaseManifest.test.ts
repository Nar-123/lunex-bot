import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { createHash } from 'node:crypto';
import * as fs from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { MANIFEST_HEADER, MANIFEST_RELATIVE_PATH, renderManifest, sealProblems, verifyRelease, walkRelease, type ManifestFs, type WalkedEntry } from '../../src/deploy/releaseManifest';

/**
 * Real files on disk. On Windows, lstat reports group/other write bits that a
 * sealed Linux release never has, so the test filesystem strips 0o022 -- the
 * content, type and symlink checks are exercised for real either way.
 */
const testFs: ManifestFs = {
  lstatSync: (p) => {
    const st = fs.lstatSync(p);
    return { isFile: () => st.isFile(), isDirectory: () => st.isDirectory(), isSymbolicLink: () => st.isSymbolicLink(), mode: st.mode & ~0o022, uid: st.uid, gid: st.gid, size: st.size };
  },
  readdirSync: (p) => fs.readdirSync(p),
  readFileSync: (p) => fs.readFileSync(p),
  readlinkSync: (p) => fs.readlinkSync(p),
};
const NO_OWNER = { requiredOwner: null };

/** File symlinks need a privilege on Windows; those two tests run wherever the OS allows them. */
const CAN_FILE_SYMLINK = (() => {
  const d = fs.mkdtempSync(join(tmpdir(), 'lunex-symlink-probe-'));
  try {
    fs.writeFileSync(join(d, 't'), '');
    fs.symlinkSync(join(d, 't'), join(d, 'l'), 'file');
    return true;
  } catch {
    return false;
  } finally {
    fs.rmSync(d, { recursive: true, force: true });
  }
})();

let root: string;
let rel: string;

function seal(): string {
  const text = renderManifest(walkRelease(rel, testFs));
  fs.mkdirSync(join(rel, '.lunex-release'), { recursive: true });
  fs.writeFileSync(join(rel, MANIFEST_RELATIVE_PATH), text);
  return createHash('sha256').update(text).digest('hex');
}

beforeEach(() => {
  root = fs.mkdtempSync(join(tmpdir(), 'lunex-manifest-'));
  rel = join(root, 'release').split('\\').join('/');
  fs.mkdirSync(join(rel, 'dist', 'deploy'), { recursive: true });
  fs.mkdirSync(join(rel, 'node_modules', 'pkg'), { recursive: true });
  fs.mkdirSync(join(rel, 'shared'), { recursive: true });
  fs.writeFileSync(join(rel, 'dist', 'index.js'), 'console.log(1)\n');
  fs.writeFileSync(join(rel, 'dist', 'deploy', 'cli.js'), 'cli\n');
  fs.writeFileSync(join(rel, 'node_modules', 'pkg', 'index.js'), 'pkg\n');
  fs.writeFileSync(join(rel, 'RELEASE_SHA'), 'fb4d3306d32f61f093b41507b5e1a548cdb61863\n');
  fs.writeFileSync(join(rel, 'shared', 'a.txt'), 'a\n');
});

afterEach(() => {
  fs.rmSync(root, { recursive: true, force: true });
});

describe('release manifest v2 (L-1 / L-2)', () => {
  it('an untouched release verifies against its anchored manifest', () => {
    const sha = seal();
    const v = verifyRelease(rel, sha, NO_OWNER, testFs);
    expect(v.problems).toEqual([]);
    expect(v.ok).toBe(true);
    expect(v.items.map((i) => i.name).sort()).toEqual(['RELEASE_SHA', 'dist', 'node_modules', 'shared']);
  });

  it('the manifest covers EVERY file (node_modules too), not only dist', () => {
    seal();
    const text = fs.readFileSync(join(rel, MANIFEST_RELATIVE_PATH), 'utf8');
    expect(text.startsWith(`${MANIFEST_HEADER}\n`)).toBe(true);
    expect(text).toContain('node_modules/pkg/index.js\tf\t');
    expect(text).toContain('RELEASE_SHA\tf\t');
    expect(text).not.toContain('.lunex-release');
  });

  it('only the metadata dir is outside the manifest: a stray build HOME or data/ is recorded, never hidden', () => {
    fs.mkdirSync(join(rel, '.home'));
    fs.writeFileSync(join(rel, '.home', 'npm-cache'), 'x\n');
    fs.mkdirSync(join(rel, 'data'));
    seal();
    const text = fs.readFileSync(join(rel, MANIFEST_RELATIVE_PATH), 'utf8');
    expect(text).toContain('.home/npm-cache\tf\t');
    expect(text).toContain('data\td\t');
  });

  it.each([
    ['a modified file', () => fs.writeFileSync(join(rel, 'dist', 'index.js'), 'tampered\n')],
    ['a modified node_modules file', () => fs.writeFileSync(join(rel, 'node_modules', 'pkg', 'index.js'), 'tampered\n')],
    ['an added file', () => fs.writeFileSync(join(rel, 'dist', 'extra.js'), 'x\n')],
    ['a removed file', () => fs.rmSync(join(rel, 'dist', 'deploy', 'cli.js'))],
    ['a file replaced by a directory', () => {
      fs.rmSync(join(rel, 'shared', 'a.txt'));
      fs.mkdirSync(join(rel, 'shared', 'a.txt'));
    }],
  ])('%s fails verification', (_label, mutate) => {
    const sha = seal();
    mutate();
    const v = verifyRelease(rel, sha, NO_OWNER, testFs);
    expect(v.ok).toBe(false);
    expect(v.problems).toContain('release content differs from the anchored manifest');
  });

  it('a manifest that is not the anchored one is refused before anything else', () => {
    seal();
    expect(verifyRelease(rel, 'f'.repeat(64), NO_OWNER, testFs).problems).toEqual(['manifest sha256 does not match --expected-manifest-sha256']);
  });

  it('a manifest rewritten to match tampered content is still refused (the anchor is outside the release)', () => {
    const sha = seal();
    fs.writeFileSync(join(rel, 'dist', 'index.js'), 'tampered\n');
    seal(); // attacker regenerates the manifest
    expect(verifyRelease(rel, sha, NO_OWNER, testFs).ok).toBe(false);
  });

  it('a missing release is a failure, not an exception', () => {
    const v = verifyRelease(`${rel}-missing`, 'a'.repeat(64), NO_OWNER, testFs);
    expect(v.ok).toBe(false);
    expect(v.problems[0]).toMatch(/release unreadable/);
  });

  describe('symlinks are recorded, never followed', () => {
    it('a directory symlink inside the release is a manifest entry, its target is not walked', () => {
      fs.symlinkSync(join(root, 'outside'), join(rel, 'shared', 'link'), 'junction');
      fs.mkdirSync(join(root, 'outside'));
      fs.writeFileSync(join(root, 'outside', 'secret.txt'), 's\n');
      const entries = walkRelease(rel, testFs);
      expect(entries.find((e) => e.path === 'shared/link')?.type).toBe('l');
      expect(entries.some((e) => e.path.includes('secret.txt'))).toBe(false);
    });

    it('re-pointing a symlink after sealing fails verification (nested symlink swap)', () => {
      fs.mkdirSync(join(root, 'a'));
      fs.mkdirSync(join(root, 'b'));
      fs.symlinkSync(join(root, 'a'), join(rel, 'shared', 'link'), 'junction');
      const sha = seal();
      fs.rmSync(join(rel, 'shared', 'link'), { recursive: false, force: true });
      fs.symlinkSync(join(root, 'b'), join(rel, 'shared', 'link'), 'junction');
      expect(verifyRelease(rel, sha, NO_OWNER, testFs).ok).toBe(false);
    });

    it.runIf(CAN_FILE_SYMLINK)('a manifest file that is itself a symlink is refused', () => {
      const sha = seal();
      const real = join(root, 'manifest-copy');
      fs.copyFileSync(join(rel, MANIFEST_RELATIVE_PATH), real);
      fs.rmSync(join(rel, MANIFEST_RELATIVE_PATH));
      fs.symlinkSync(real, join(rel, MANIFEST_RELATIVE_PATH), 'file');
      expect(verifyRelease(rel, sha, NO_OWNER, testFs).problems).toEqual(['manifest is not a regular file']);
    });

    it.runIf(CAN_FILE_SYMLINK)('a file symlink inside the release is recorded with its target, not hashed through', () => {
      fs.writeFileSync(join(root, 'outside.txt'), 'outside\n');
      fs.symlinkSync(join(root, 'outside.txt'), join(rel, 'shared', 'flink'), 'file');
      const entry = walkRelease(rel, testFs).find((x) => x.path === 'shared/flink');
      expect(entry?.type).toBe('l');
      expect(entry?.detail).toBe(join(root, 'outside.txt'));
    });
  });
});

describe('seal policy (L-2)', () => {
  const rootOk = { mode: 0o755, uid: 0, gid: 0, isDirectory: true, isSymlink: false };
  const e = (over: Partial<WalkedEntry>): WalkedEntry => ({ path: 'dist/index.js', type: 'f', mode: 0o644, uid: 0, gid: 0, detail: 'x', ...over });
  const ROOT = { requiredOwner: { uid: 0, gid: 0 } };

  it('root-owned, no group/other write, no setuid passes', () => {
    expect(sealProblems([e({}), e({ path: 'dist', type: 'd', mode: 0o755 }), e({ path: 'l', type: 'l', mode: 0o777 })], rootOk, ROOT)).toEqual([]);
  });
  it.each([
    ['not root-owned', e({ uid: 1003 })],
    ['not root group', e({ gid: 1003 })],
    ['group-writable', e({ mode: 0o664 })],
    ['other-writable', e({ mode: 0o646 })],
    ['setuid', e({ mode: 0o4755 })],
    ['setgid directory', e({ type: 'd', mode: 0o2755 })],
    ['a special file', e({ type: 'other' })],
    ['a tab in a path', e({ path: 'dist/a\tb' })],
  ])('%s is a seal violation', (_l, entry) => {
    expect(sealProblems([entry], rootOk, ROOT).length).toBeGreaterThan(0);
  });
  it('a release root that is a symlink, not root-owned, or writable is a violation', () => {
    expect(sealProblems([], { ...rootOk, isSymlink: true }, ROOT).length).toBeGreaterThan(0);
    expect(sealProblems([], { ...rootOk, uid: 1003 }, ROOT).length).toBeGreaterThan(0);
    expect(sealProblems([], { ...rootOk, mode: 0o775 }, ROOT).length).toBeGreaterThan(0);
  });
});
