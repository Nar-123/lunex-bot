#!/usr/bin/env bash
# Lunex Bot -- SQLite backup, using SQLite's own online backup API (safe
# against a live writer -- unlike `cp`, which can copy a mid-write file
# and produce a torn/corrupt copy). PROPOSED, not yet run against a real
# deployed database (only tested conceptually in this session -- no
# production data exists to back up yet). Read-only: never touches the
# source database beyond SQLite's own backup mechanism.
#
# Usage:
#   ./backup-db.sh [source_db_path] [backup_dir]
# Defaults match this repo's own DATABASE_URL (file:./data/lunex.db).
set -euo pipefail

SRC_DB="${1:-./data/lunex.db}"
BACKUP_DIR="${2:-./data/backups}"
TIMESTAMP="$(date -u +%Y%m%dT%H%M%SZ)"
DEST_DB="${BACKUP_DIR}/lunex-${TIMESTAMP}.db"

if [ ! -f "${SRC_DB}" ]; then
  echo "ERROR: source database not found: ${SRC_DB}" >&2
  exit 1
fi

command -v sqlite3 >/dev/null 2>&1 || {
  echo "ERROR: sqlite3 CLI not found. Install it first: apt-get install -y sqlite3" >&2
  exit 1
}

mkdir -p "${BACKUP_DIR}"

# `.backup` uses SQLite's page-level online backup API -- safe to run
# while the service is live and writing, produces a fully consistent
# snapshot, never a torn/partial file.
sqlite3 "${SRC_DB}" ".backup '${DEST_DB}'"

# Verify the backup is actually a valid, uncorrupted SQLite database
# before trusting it -- a backup nobody ever verified is not a backup.
INTEGRITY="$(sqlite3 "${DEST_DB}" "PRAGMA integrity_check;")"
if [ "${INTEGRITY}" != "ok" ]; then
  echo "ERROR: backup failed integrity check: ${INTEGRITY}" >&2
  echo "Removing invalid backup file: ${DEST_DB}" >&2
  rm -f "${DEST_DB}"
  exit 1
fi

echo "OK: backup written and verified: ${DEST_DB}"

# Retention: keep the last 30 daily backups, delete older ones. Adjust to
# the operator's real retention policy -- this is a starting default, not
# a spec requirement.
KEEP=30
ls -1t "${BACKUP_DIR}"/lunex-*.db 2>/dev/null | tail -n +$((KEEP + 1)) | while read -r old; do
  echo "Pruning old backup: ${old}"
  rm -f "${old}"
done
