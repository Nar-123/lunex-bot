#!/usr/bin/env bash
# Verify that a staged release tree holds ONLY what a release may carry:
#   - the files of the audited git archive (expected-blob-sha256.txt) and their directories,
#   - the build outputs dist/ and ui/dist/, the installed node_modules/,
#   - RELEASE_SHA and the .lunex-release/ metadata directory.
# Anything else fails: a test byproduct (the integration suite leaves data/ behind),
# a stray *.db or *.log, an .env, a cache or tool home, a top-level symlink.
#
#   check-release-layout.sh <release-dir> <expected-blob-sha256.txt>
#
# Read-only; exits 0 when clean, 1 with one "LAYOUT:" line per problem otherwise.
# Called by prepare-release.sh before the seal and again after it. The deploy tool
# applies the same top-level rules on its own (src/deploy/gate.ts) -- defence in depth.
set -euo pipefail

REL="${1:?release dir required}"
BLOBS="${2:?expected-blob-sha256.txt required}"
FAIL=0
problem() {
  echo "LAYOUT: $*" >&2
  FAIL=1
}

[ -d "$REL" ] && [ ! -L "$REL" ] || { echo "LAYOUT: $REL is not a real directory" >&2; exit 1; }
[ -f "$BLOBS" ] || { echo "LAYOUT: blob list $BLOBS missing" >&2; exit 1; }

# Same rule set as forbiddenTopLevelReason() in src/deploy/gate.ts.
forbidden() {
  case "$1" in
    data | logs | .env | .home | .cache | .config | .npm | .npm-cache | .git | .nyc_output | coverage | tmp | .tmp | session | sessions | rollback | backups) return 0 ;;
    .env.example) return 1 ;;
    .env.*) return 0 ;;
  esac
  case "${1,,}" in
    *.db | *.db-journal | *.db-wal | *.db-shm | *.sqlite | *.sqlite-journal | *.sqlite-wal | *.sqlite-shm | *.sqlite3 | *.sqlite3-journal | *.sqlite3-wal | *.sqlite3-shm | *.log) return 0 ;;
  esac
  return 1
}

# What the archive contains: every file, every directory above a file, every top-level name.
declare -A TRACKED=() TRACKED_DIRS=()
declare -A ALLOWED_TOP=([dist]=1 [node_modules]=1 [RELEASE_SHA]=1 [.lunex-release]=1)
while IFS= read -r line; do
  p=${line#*  ./}
  if [ "$p" = "$line" ] || [ -z "$p" ]; then
    problem "malformed blob-list line"
    continue
  fi
  TRACKED["$p"]=1
  ALLOWED_TOP["${p%%/*}"]=1
  d=$(dirname -- "$p")
  while [ "$d" != . ]; do
    TRACKED_DIRS["$d"]=1
    d=$(dirname -- "$d")
  done
done < "$BLOBS"

# 1. Top level: allowed names only, never forbidden, never a symlink or special file.
TOP=0
while IFS= read -r -d '' e; do
  TOP=$((TOP + 1))
  name=${e#"$REL"/}
  if [[ "$name" =~ [[:cntrl:]] ]] || [[ "$name" == -* ]]; then
    problem "malformed top-level name"
    continue
  fi
  if forbidden "$name"; then problem "forbidden top-level entry: $name"; fi
  [ -n "${ALLOWED_TOP[$name]:-}" ] || problem "unexpected top-level entry (not in the archive, not a build output): $name"
  if [ -L "$e" ]; then
    problem "top-level symlink: $name"
  elif [ ! -d "$e" ] && [ ! -f "$e" ]; then
    problem "top-level special file: $name"
  fi
done < <(find "$REL" -mindepth 1 -maxdepth 1 -print0)
[ "$TOP" -gt 0 ] || problem "release tree is empty"

# 2. Below the top level: outside the build outputs, every entry must come from the archive.
while IFS= read -r -d '' e; do
  p=${e#"$REL"/}
  case "$p" in
    RELEASE_SHA) continue ;;
  esac
  if [ -d "$e" ] && [ ! -L "$e" ]; then
    [ -n "${TRACKED_DIRS[$p]:-}" ] || problem "directory not part of the archive: $p"
  else
    [ -n "${TRACKED[$p]:-}" ] || problem "file not part of the archive: $p"
  fi
done < <(find "$REL" -mindepth 1 \( -path "$REL/node_modules" -o -path "$REL/dist" -o -path "$REL/ui/dist" -o -path "$REL/.lunex-release" \) -prune -o -print0)

# 3. Every archived file is present (the release is not missing source either).
for p in "${!TRACKED[@]}"; do
  [ -f "$REL/$p" ] && [ ! -L "$REL/$p" ] || problem "archived file missing from the release: $p"
done

if [ "$FAIL" -ne 0 ]; then
  echo "LAYOUT: INVALID" >&2
  exit 1
fi
echo "layout: clean ($TOP top-level entries, ${#TRACKED[@]} archived files)"
