#!/usr/bin/env bash
# Stage, validate and seal ONE release on the target host, as lunex-admin.
#
#   prepare-release.sh <release-sha> </abs/src.tar> </abs/src.tar.sha256> </abs/expected-blob-sha256.txt>
#
# The artifact is built on the operator's machine with
#   git -c core.autocrlf=false archive --format=tar <sha> > src.tar
# (git embeds the commit id in the tar header) plus a sha256 of the tar and a
# per-file blob manifest. Nothing here touches production.
#
# Two stages, so nothing a test run leaves behind can reach a release:
#   A. VALIDATE in a private build workspace (mktemp, outside /opt/lunex/releases):
#      npm ci, Prisma version gate, npm run test / typecheck / lint / build.
#      The integration suite creates <project>/data/*.db and leaves data/ behind;
#      that, and every other test byproduct, stays in the workspace.
#   B. RELEASE: the tree is unpacked again from the pristine archive into
#      /opt/lunex/releases/<sha>, gets its own npm ci + build -- never a test run --
#      and its build output must be byte-identical to the validated build.
# The release tree then has to pass check-release-layout.sh (archive files + dist,
# ui/dist, node_modules, RELEASE_SHA, .lunex-release and nothing else) before AND
# after the seal. The deploy tool re-checks the top level on its own.
#
# Privileged steps use only lunex-admin's passwordless sudo whitelist
# (mkdir, chown, chmod, install); npm runs unprivileged with a scrubbed
# environment and a HOME inside the build workspace. Every step fails closed.
set -euo pipefail

RELEASES=/opt/lunex/releases
CLEAN_PATH=/usr/local/bin:/usr/bin:/bin
SHA="${1:?release sha required}"
TAR="${2:?src.tar required}"
TAR_SHA_FILE="${3:?src.tar.sha256 required}"
BLOBS="${4:?expected-blob-sha256.txt required}"
die() { echo "ABORT: $*" >&2; exit 1; }

HERE=$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)
CHECK="$HERE/check-release-layout.sh"
[ -f "$CHECK" ] || die "check-release-layout.sh missing next to prepare-release.sh"
[[ "$SHA" =~ ^[0-9a-f]{40}$ ]] || die "release sha must be a full 40-hex commit id"
[ "$(id -un)" = lunex-admin ] || die "run as lunex-admin"
for f in "$TAR" "$TAR_SHA_FILE" "$BLOBS"; do [[ "$f" = /* ]] || die "pass absolute paths ($f)"; done
REL="$RELEASES/$SHA"
META="$REL/.lunex-release"
[ ! -e "$REL" ] || die "$REL already exists -- releases are never rebuilt in place"

# 1. Artifact identity: archive hash and embedded commit id.
( cd "$(dirname "$TAR")" && sha256sum -c --status "$TAR_SHA_FILE" ) || die "archive hash mismatch"
CID=$(git get-tar-commit-id < "$TAR")
[ "$CID" = "$SHA" ] || die "archive commit id $CID is not $SHA"

# 2. Private build workspace. Kept on failure for diagnosis, removed on success.
WORK=$(mktemp -d "${TMPDIR:-/tmp}/lunex-build-${SHA:0:12}.XXXXXX")
OK=0
trap 'if [ "$OK" = 1 ]; then rm -rf "$WORK"; else echo "build workspace kept for diagnosis: $WORK" >&2; fi' EXIT
mkdir "$WORK/src" "$WORK/home" "$WORK/logs"

unpack_verified() {
  tar -xf "$TAR" -C "$1"
  ( cd "$1" && sha256sum -c --quiet "$BLOBS" ) || die "extracted files differ from the audited git blobs ($1)"
  [ "$(cd "$1" && find . -type f | wc -l)" = "$(wc -l < "$BLOBS")" ] || die "extracted file count differs from the blob list ($1)"
  [ "$( (grep -rlU $'\r' "$1" || true) | wc -l)" = 0 ] || die "CR bytes in the archive (built with autocrlf?)"
  [ ! -e "$1/.env" ] || die "the archive carries a .env"
}
in_dir() {
  local dir=$1
  shift
  ( cd "$dir" && timeout 1800 env -i PATH=$CLEAN_PATH HOME="$WORK/home" "$@" )
}
prisma_gate() {
  local out p c
  out=$(in_dir "$1" ./node_modules/.bin/prisma -v 2>&1)
  p=$(echo "$out" | awk -F': *' '/^prisma /{print $2}' | tr -d ' ')
  c=$(echo "$out" | awk -F': *' '/^@prisma\/client /{print $2}' | tr -d ' ')
  [ "$p" = 7.10.0 ] && [ "$c" = 7.10.0 ] || die "Prisma version gate failed in $1 (prisma=$p client=$c)"
}
build_hashes() {
  ( cd "$1" && find dist ui/dist -type f -print0 | LC_ALL=C sort -z | xargs -0 sha256sum )
}

# Stage A -- validate in the workspace.
unpack_verified "$WORK/src"
in_dir "$WORK/src" npm ci --no-audit --no-fund > "$WORK/logs/npm-ci-validate.log" 2>&1 \
  || { tail -20 "$WORK/logs/npm-ci-validate.log"; die "npm ci (validation) failed"; }
prisma_gate "$WORK/src"
for s in test typecheck lint build; do
  in_dir "$WORK/src" npm run "$s" > "$WORK/logs/validate-$s.log" 2>&1 \
    || { tail -30 "$WORK/logs/validate-$s.log"; die "npm run $s failed"; }
  echo "validate $s: PASS"
done
[ -f "$WORK/src/dist/index.js" ] || die "dist/index.js missing after the validation build"

# Stage B -- the release tree, from the pristine archive; nothing is ever tested in it.
sudo -n /usr/bin/mkdir -p -m 0755 "$RELEASES"
sudo -n /usr/bin/mkdir -m 0755 "$REL"
sudo -n /usr/bin/chown lunex-admin:lunex-admin "$REL"
unpack_verified "$REL"
in_dir "$REL" npm ci --no-audit --no-fund > "$WORK/logs/npm-ci-release.log" 2>&1 \
  || { tail -20 "$WORK/logs/npm-ci-release.log"; die "npm ci (release) failed"; }
prisma_gate "$REL"
in_dir "$REL" npm run build > "$WORK/logs/release-build.log" 2>&1 \
  || { tail -30 "$WORK/logs/release-build.log"; die "release build failed"; }
[ "$(build_hashes "$WORK/src")" = "$(build_hashes "$REL")" ] || die "the release build differs from the validated build"
echo "release build: byte-identical to the validated build ($(build_hashes "$REL" | wc -l) files)"

# 3. Metadata, then the layout gate before sealing.
mkdir "$META"
echo "$CID" > "$META/commit-id"
cp "$TAR_SHA_FILE" "$META/artifact.sha256"
cp "$WORK"/logs/*.log "$META/"
echo "$SHA" > "$REL/RELEASE_SHA"
bash "$CHECK" "$REL" "$BLOBS" || die "release layout invalid -- not sealing"
BAD=$(cd "$REL" && find . -name $'*\t*' -o -name $'*\n*' -o -name $'*\r*' | head -1)
[ -z "$BAD" ] || die "unsupported character in a release path: $BAD"

# 4. Seal: root-owned, world-readable, writable by nobody but root, no setuid/setgid.
sudo -n /usr/bin/chown -R root:root "$REL"
sudo -n /usr/bin/chmod -R go-w,ug-s,a+rX "$REL"

# 5. Authoritative manifest of the SEALED tree (format: src/deploy/releaseManifest.ts):
#    <path>\t<f|d|l>\t<octal mode>\t<sha256 | link target | ->, sorted bytewise.
#    Written outside the release, installed root-owned read-only; its sha256 is
#    what the operator passes as --expected-manifest-sha256.
TMPM="$WORK/release-manifest.v2"
{
  echo "lunex-release-manifest-v2"
  ( cd "$REL" && find . -mindepth 1 -path ./.lunex-release -prune -o -printf '%P\t%y\t%m\t%l\n' ) \
    | while IFS=$'\t' read -r p y m l; do
        case "$y" in
          f) printf '%s\tf\t%s\t%s\n' "$p" "$m" "$(sha256sum -- "$REL/$p" | cut -c1-64)" ;;
          d) printf '%s\td\t%s\t-\n' "$p" "$m" ;;
          l) printf '%s\tl\t%s\t%s\n' "$p" "$m" "$l" ;;
          *) echo "ABORT: special file in release: $p" >&2; exit 1 ;;
        esac
      done | LC_ALL=C sort
} > "$TMPM"
[ "$(head -1 "$TMPM")" = "lunex-release-manifest-v2" ] && [ "$(wc -l < "$TMPM")" -gt 1 ] || die "manifest generation failed"
sudo -n /usr/bin/install -m 0444 -o root -g root -- "$TMPM" "$META/release-manifest.v2"

# 6. The layout must still be clean after the seal.
bash "$CHECK" "$REL" "$BLOBS" || die "release layout invalid after seal"
MSHA=$(sha256sum < "$META/release-manifest.v2" | cut -c1-64)
OK=1
echo "SEALED $REL ($(($(wc -l < "$META/release-manifest.v2") - 1)) entries)"
echo "EXPECTED_MANIFEST_SHA256=$MSHA"
