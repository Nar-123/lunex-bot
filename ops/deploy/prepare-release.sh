#!/usr/bin/env bash
# Stage, validate and seal ONE release on the target host, as lunex-admin.
#
#   prepare-release.sh <release-sha> <src.tar> <src.tar.sha256> <expected-blob-sha256.txt>
#
# The artifact is built on the operator's machine with
#   git -c core.autocrlf=false archive --format=tar <sha> > src.tar
# (git embeds the commit id in the tar header) plus a sha256 of the tar and a
# per-file blob manifest. Nothing here touches production: it builds into
# /opt/lunex/releases/<sha>, then seals it root-owned and read-only so the build
# that was validated is the build that gets deployed (the deploy tool re-hashes
# it against release-build.manifest before every run).
#
# Privileged steps use only lunex-admin's passwordless sudo whitelist
# (mkdir, chown, chmod); npm runs unprivileged with a scrubbed environment.
# Every step fails closed.
set -euo pipefail

RELEASES=/opt/lunex/releases
CLEAN_PATH=/usr/local/bin:/usr/bin:/bin
SHA="${1:?release sha required}"
TAR="${2:?src.tar required}"
TAR_SHA_FILE="${3:?src.tar.sha256 required}"
BLOBS="${4:?expected-blob-sha256.txt required}"
die() { echo "ABORT: $*" >&2; exit 1; }

[[ "$SHA" =~ ^[0-9a-f]{40}$ ]] || die "release sha must be a full 40-hex commit id"
[ "$(id -un)" = lunex-admin ] || die "run as lunex-admin"
REL="$RELEASES/$SHA"
META="$REL/.lunex-release"
[ ! -e "$REL" ] || die "$REL already exists -- releases are never rebuilt in place"

# 1. Artifact identity: archive hash, embedded commit id, per-file blob hashes.
( cd "$(dirname "$TAR")" && sha256sum -c --status "$TAR_SHA_FILE" ) || die "archive hash mismatch"
CID=$(git get-tar-commit-id < "$TAR")
[ "$CID" = "$SHA" ] || die "archive commit id $CID is not $SHA"
sudo -n /usr/bin/mkdir -p -m 0755 "$RELEASES"
sudo -n /usr/bin/mkdir -m 0755 "$REL"
sudo -n /usr/bin/chown lunex-admin:lunex-admin "$REL"
tar -xf "$TAR" -C "$REL"
( cd "$REL" && sha256sum -c --quiet "$BLOBS" ) || die "extracted files differ from the audited git blobs"
NF=$(cd "$REL" && find . -type f | wc -l); NE=$(wc -l < "$BLOBS")
[ "$NF" = "$NE" ] || die "extracted $NF files, manifest lists $NE"
NCR=$( (grep -rlU $'\r' "$REL" || true) | wc -l)
[ "$NCR" = 0 ] || die "$NCR file(s) contain CR bytes (archive built with autocrlf?)"
[ ! -e "$REL/.env" ] || die "the archive carries a .env"
mkdir "$META"
echo "$CID" > "$META/commit-id"
cp "$TAR_SHA_FILE" "$META/artifact.sha256"

# 2. Install exactly the lockfile, with the pinned Prisma.
mkdir "$REL/.home"
( cd "$REL" && timeout 1800 env -i PATH=$CLEAN_PATH HOME="$REL/.home" npm ci --no-audit --no-fund ) > "$META/npm-ci.log" 2>&1 \
  || { tail -20 "$META/npm-ci.log"; die "npm ci failed"; }
OUT=$(cd "$REL" && env -i PATH=$CLEAN_PATH HOME="$REL/.home" ./node_modules/.bin/prisma -v 2>&1)
P=$(echo "$OUT" | awk -F': *' '/^prisma /{print $2}' | tr -d ' ')
C=$(echo "$OUT" | awk -F': *' '/^@prisma\/client /{print $2}' | tr -d ' ')
[ "$P" = 7.10.0 ] && [ "$C" = 7.10.0 ] || die "Prisma version gate failed (prisma=$P client=$C)"

# 3. Validate: the full suite, types, lint and the production build.
for s in test typecheck lint build; do
  ( cd "$REL" && env -i PATH=$CLEAN_PATH HOME="$REL/.home" npm run "$s" ) > "$META/validate-$s.log" 2>&1 \
    || { tail -30 "$META/validate-$s.log"; die "npm run $s failed"; }
  echo "validate $s: PASS"
done
[ -f "$REL/dist/index.js" ] || die "dist/index.js missing after build"

# 4. Record what was validated, then seal: root-owned, world-readable,
#    writable by nobody but root, no setuid/setgid anywhere.
echo "$SHA" > "$REL/RELEASE_SHA"
BAD=$(cd "$REL" && find . -name $'*\t*' -o -name $'*\n*' -o -name $'*\r*' | head -1)
[ -z "$BAD" ] || die "unsupported character in a release path: $BAD"
sudo -n /usr/bin/chown -R root:root "$REL"
sudo -n /usr/bin/chmod -R go-w,ug-s,a+rX "$REL"

# 5. Authoritative manifest of the SEALED tree (format: src/deploy/releaseManifest.ts):
#    <path>\t<f|d|l>\t<octal mode>\t<sha256 | link target | ->, sorted bytewise.
#    Written outside the release, installed root-owned read-only, and its
#    sha256 is what the operator passes as --expected-manifest-sha256.
TMPM=$(mktemp)
trap 'rm -f "$TMPM"' EXIT
{
  echo "lunex-release-manifest-v2"
  ( cd "$REL" && find . -mindepth 1 \( -path ./.lunex-release -o -path ./.home \) -prune -o -printf '%P\t%y\t%m\t%l\n' ) \
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
MSHA=$(sha256sum < "$META/release-manifest.v2" | cut -c1-64)
echo "SEALED $REL ($(($(wc -l < "$META/release-manifest.v2") - 1)) entries)"
echo "EXPECTED_MANIFEST_SHA256=$MSHA"
