import { createHash } from 'node:crypto';
import * as nodeFs from 'node:fs';
import type { EntryType } from './gate';

/**
 * Authoritative description of a sealed release (L-1 / L-2).
 *
 * prepare-release.sh writes `.lunex-release/release-manifest.v2` AFTER sealing
 * the release (root-owned, no group/other write) and prints its sha256. The
 * operator passes that sha256 to the deploy tool as `--expected-manifest-sha256`,
 * so the manifest is anchored outside the release directory it describes.
 *
 * Every check re-walks the release with lstat (symlinks are recorded, never
 * followed), renders the canonical manifest from what is on disk, and requires
 * it to equal the anchored manifest byte for byte: a changed, added, removed or
 * re-pointed entry anywhere in the release fails. The same walk enforces the
 * seal on every entry.
 *
 * Canonical line, one per entry, sorted by raw bytes (LC_ALL=C sort):
 *   <path>\t<type f|d|l>\t<octal mode>\t<sha256 for f | link target for l | - for d>
 * The first line is the header. Must match prepare-release.sh exactly.
 */

export const MANIFEST_HEADER = 'lunex-release-manifest-v2';
export const MANIFEST_RELATIVE_PATH = '.lunex-release/release-manifest.v2';
/** Top-level release entries that are build bookkeeping, never part of the deployed tree. */
export const MANIFEST_EXCLUDED_TOP = new Set(['.lunex-release', '.home']);

export interface ManifestFs {
  lstatSync(path: string): { isFile(): boolean; isDirectory(): boolean; isSymbolicLink(): boolean; mode: number; uid: number; gid: number; size: number };
  readdirSync(path: string): string[];
  readFileSync(path: string): Buffer;
  readlinkSync(path: string): string;
}

const defaultFs: ManifestFs = {
  lstatSync: (p) => nodeFs.lstatSync(p),
  readdirSync: (p) => nodeFs.readdirSync(p),
  readFileSync: (p) => nodeFs.readFileSync(p),
  readlinkSync: (p) => nodeFs.readlinkSync(p),
};

export interface WalkedEntry {
  path: string;
  type: EntryType;
  mode: number;
  uid: number;
  gid: number;
  /** sha256 for files, link target for symlinks, '-' for directories. */
  detail: string;
}

export interface SealPolicy {
  /** Required owner/group of every entry; null skips ownership (non-POSIX test hosts only). */
  requiredOwner: { uid: number; gid: number } | null;
}

export const ROOT_SEAL: SealPolicy = { requiredOwner: { uid: 0, gid: 0 } };

function sha256(buf: Buffer): string {
  return createHash('sha256').update(buf).digest('hex');
}

/** lstat walk of the release; never follows a symlink. */
export function walkRelease(root: string, fs: ManifestFs = defaultFs): WalkedEntry[] {
  const out: WalkedEntry[] = [];
  const visit = (rel: string) => {
    const abs = rel === '' ? root : `${root}/${rel}`;
    for (const name of fs.readdirSync(abs)) {
      if (rel === '' && MANIFEST_EXCLUDED_TOP.has(name)) continue;
      const path = rel === '' ? name : `${rel}/${name}`;
      const st = fs.lstatSync(`${root}/${path}`);
      const mode = st.mode & 0o7777;
      if (st.isSymbolicLink()) out.push({ path, type: 'l', mode, uid: st.uid, gid: st.gid, detail: fs.readlinkSync(`${root}/${path}`) });
      else if (st.isDirectory()) {
        out.push({ path, type: 'd', mode, uid: st.uid, gid: st.gid, detail: '-' });
        visit(path);
      } else if (st.isFile()) out.push({ path, type: 'f', mode, uid: st.uid, gid: st.gid, detail: sha256(fs.readFileSync(`${root}/${path}`)) });
      else out.push({ path, type: 'other', mode, uid: st.uid, gid: st.gid, detail: '?' });
    }
  };
  visit('');
  return out;
}

export function renderManifest(entries: readonly WalkedEntry[]): string {
  const lines = entries.map((e) => `${e.path}\t${e.type}\t${e.mode.toString(8)}\t${e.detail}`);
  lines.sort((a, b) => Buffer.compare(Buffer.from(a, 'utf8'), Buffer.from(b, 'utf8')));
  return `${[MANIFEST_HEADER, ...lines].join('\n')}\n`;
}

/** Seal violations of individual entries (and the release root). */
export function sealProblems(entries: readonly WalkedEntry[], root: { mode: number; uid: number; gid: number; isDirectory: boolean; isSymlink: boolean }, policy: SealPolicy): string[] {
  const problems: string[] = [];
  if (!root.isDirectory || root.isSymlink) problems.push('release root is not a real directory');
  if (policy.requiredOwner && (root.uid !== policy.requiredOwner.uid || root.gid !== policy.requiredOwner.gid)) problems.push('release root is not root:root');
  if ((root.mode & 0o022) !== 0) problems.push('release root is group/other-writable');
  for (const e of entries) {
    if (/[\t\n\r]/.test(e.path)) problems.push(`unsupported character in path ${JSON.stringify(e.path)}`);
    if (e.type === 'other') problems.push(`special file ${e.path}`);
    if (policy.requiredOwner && (e.uid !== policy.requiredOwner.uid || e.gid !== policy.requiredOwner.gid)) problems.push(`${e.path} is not root:root`);
    if (e.type !== 'l' && (e.mode & 0o022) !== 0) problems.push(`${e.path} is group/other-writable`);
    if ((e.mode & 0o6000) !== 0) problems.push(`${e.path} has setuid/setgid`);
    if (problems.length > 20) break;
  }
  return problems;
}

export interface ReleaseVerification {
  ok: boolean;
  problems: string[];
  /** Top-level items with their types, taken from the anchored manifest. */
  items: { name: string; type: EntryType }[];
}

/**
 * Verifies a sealed release against its anchored manifest. Fail-closed: any
 * read error is a problem, never a pass.
 */
export function verifyRelease(releaseDir: string, expectedManifestSha256: string, policy: SealPolicy, fs: ManifestFs = defaultFs): ReleaseVerification {
  const problems: string[] = [];
  let items: { name: string; type: EntryType }[] = [];
  try {
    if (!/^[0-9a-f]{64}$/.test(expectedManifestSha256)) return { ok: false, problems: ['expected manifest sha256 is not 64 hex'], items };
    const manifestPath = `${releaseDir}/${MANIFEST_RELATIVE_PATH}`;
    const mst = fs.lstatSync(manifestPath);
    if (!mst.isFile() || mst.isSymbolicLink()) return { ok: false, problems: ['manifest is not a regular file'], items };
    if (policy.requiredOwner && (mst.uid !== policy.requiredOwner.uid || (mst.mode & 0o022) !== 0)) problems.push('manifest is not root-owned read-only');
    const manifest = fs.readFileSync(manifestPath);
    if (sha256(manifest) !== expectedManifestSha256) return { ok: false, problems: ['manifest sha256 does not match --expected-manifest-sha256'], items };
    const text = manifest.toString('utf8');
    const rootSt = fs.lstatSync(releaseDir);
    const entries = walkRelease(releaseDir, fs);
    problems.push(...sealProblems(entries, { mode: rootSt.mode & 0o7777, uid: rootSt.uid, gid: rootSt.gid, isDirectory: rootSt.isDirectory(), isSymlink: rootSt.isSymbolicLink() }, policy));
    if (renderManifest(entries) !== text) problems.push('release content differs from the anchored manifest');
    items = entries.filter((e) => !e.path.includes('/')).map((e) => ({ name: e.path, type: e.type }));
  } catch (err) {
    problems.push(`release unreadable: ${err instanceof Error ? err.message : String(err)}`);
  }
  return { ok: problems.length === 0, problems, items };
}
