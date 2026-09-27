#!/usr/bin/env bash
# Lunex staged deployment of D3 -> D2 -> D1, replayed on top of C in the
# operator-approved order (the original D-commits were stacked D1<-D2<-D3, so
# deploying them as authored would ship all three at once).
# One stage per call; every stage fails closed. Usage: deployD.sh <D3|D2|D1> <stage>
set -euo pipefail

PROD=/opt/lunex/production/lunex-bot
DB=$PROD/data/lunex.db
URL="file:$DB"
SVC=lunex-bot
CLEAN_PATH=/usr/local/bin:/usr/bin:/bin
LABEL="${1:?label (D3|D2|D1) required}"
STAGE="${2:?stage required}"
POINTER=/opt/lunex/backups/deploy-$LABEL.env
CR=$(printf '\r')

case "$LABEL" in
  D3) EXPECTED_SHA=e578a36bcc450542ee5a11b2a5275292bdb25010; PREV_SHA=f2fcd9a8a132d932c6ef923e73eafaacc236f979
      MARKERS="dist/exits/executeExit.js dist/exits/swapLegBackoff.js"; MK_SYM=isDeterministicBlockReason; MK_FILE=dist/exits/executeExit.js
      MIGRATES=no; MIGRATION=; AI_EXPECTED=0 ;;
  D2) EXPECTED_SHA=99632bad0236127838e4d7d8ec8b8e19a840d46c; PREV_SHA=e578a36bcc450542ee5a11b2a5275292bdb25010
      MARKERS="dist/positions/permit2Preflight.js"; MK_SYM=expectedOwner; MK_FILE=dist/positions/permit2Preflight.js
      MIGRATES=no; MIGRATION=; AI_EXPECTED=0 ;;
  D1) EXPECTED_SHA=e33021563c7ae0e739612d7ec5f57ce5337e8603; PREV_SHA=99632bad0236127838e4d7d8ec8b8e19a840d46c
      MARKERS="dist/api/routes/aiControl.js"; MK_SYM=createAiControlRouter; MK_FILE=dist/api/routes/aiControl.js
      MIGRATES=yes; MIGRATION=20260921000000_add_ai_entry_control; AI_EXPECTED=1 ;;
  D4) EXPECTED_SHA=5cdfcd883b4edddf9549eff8c89c28f7ff5a1207; PREV_SHA=e33021563c7ae0e739612d7ec5f57ce5337e8603
      MARKERS="dist/exits/staleExitAttemptCleanup.js"; MK_SYM=classifyStaleExitAttempt; MK_FILE=dist/exits/staleExitAttemptCleanup.js
      MIGRATES=no; MIGRATION=; AI_EXPECTED=1 ;;
  D5) EXPECTED_SHA=c56d6dee3f9b1b6ca50f4cc93359f6f4fa93569e; PREV_SHA=5cdfcd883b4edddf9549eff8c89c28f7ff5a1207
      MARKERS="dist/positions/permit2Renewal.js dist/positions/permit2RenewalTx.js dist/positions/permit2RenewalAction.js dist/api/routes/permit2Renew.js"
      MK_SYM=assessPermit2Renewal; MK_FILE=dist/positions/permit2Renewal.js
      MIGRATES=no; MIGRATION=; AI_EXPECTED=1 ;;
  D6) EXPECTED_SHA=0525c41c6ba9d34ed2d7e4fbab3b5b4bfaafd847; PREV_SHA=c56d6dee3f9b1b6ca50f4cc93359f6f4fa93569e
      MARKERS="dist/exits/permit2TokenGrant.js dist/exits/permit2GrantTx.js dist/swap/universalRouterCalldata.js"
      MK_SYM=assessTokenGrant; MK_FILE=dist/exits/permit2TokenGrant.js
      MIGRATES=no; MIGRATION=; AI_EXPECTED=1 ;;
  D8) EXPECTED_SHA=cba244eaeaa4e4dce0f74d98aa5d276001dd3a14; PREV_SHA=0525c41c6ba9d34ed2d7e4fbab3b5b4bfaafd847
      MARKERS="dist/exits/exitApprovalSpender.js dist/exits/permit2TokenGrant.js dist/swap/universalRouterCalldata.js dist/exits/executeExit.js"
      MK_SYM=classifyExitApprovalSpender; MK_FILE=dist/exits/exitApprovalSpender.js
      MIGRATES=no; MIGRATION=; AI_EXPECTED=1 ;;
  D9) EXPECTED_SHA=6e8e0b191fdc8921b42d48fd25f54b91a023364e; PREV_SHA=0525c41c6ba9d34ed2d7e4fbab3b5b4bfaafd847
      MARKERS="dist/blockchain/rpcTransport.js dist/exits/exitApprovalSpender.js dist/exits/permit2TokenGrant.js dist/swap/universalRouterCalldata.js dist/exits/executeExit.js"
      MK_SYM=buildRpcTransport; MK_FILE=dist/blockchain/rpcTransport.js
      MIGRATES=no; MIGRATION=; AI_EXPECTED=1 ;;
  D10) EXPECTED_SHA=98a0190163c3416dd1e8f0618eeca413c93f48f9; PREV_SHA=6e8e0b191fdc8921b42d48fd25f54b91a023364e
      MARKERS="dist/execution/nonceAllocation.js dist/discovery/childEnv.js dist/blockchain/rpcTransport.js dist/exits/exitApprovalSpender.js dist/exits/executeExit.js"
      MK_SYM=allocateNonce; MK_FILE=dist/execution/nonceAllocation.js
      MIGRATES=no; MIGRATION=; AI_EXPECTED=1 ;;
  D11) EXPECTED_SHA=1780220e5a9c9f80e0246cb513df6a3c5c45ccf9; PREV_SHA=98a0190163c3416dd1e8f0618eeca413c93f48f9
      MARKERS="dist/execution/nonceAllocation.js dist/discovery/childEnv.js dist/swap/validateSwapQuote.js dist/execution/transactionAttemptRepository.js"
      MK_SYM=reserveNonce; MK_FILE=dist/execution/transactionAttemptRepository.js
      MIGRATES=yes; MIGRATION=20260927000000_add_executor_scoped_nonce_reservation; AI_EXPECTED=1 ;;
  *) echo "ABORT: unknown label $LABEL" >&2; exit 1 ;;
esac

die() { echo "ABORT: $*" >&2; exit 1; }
load() { [ -f "$POINTER" ] || die "no deploy session for $LABEL"; . "$POINTER"; }
q() { sqlite3 -readonly -batch "$1" "$2"; }
svc_state() { systemctl is-active "$SVC" 2>/dev/null || true; }
svc_inactive() { local s; s=$(svc_state); [ "$s" != active ] && [ "$s" != activating ]; }
holders() { for p in /proc/[0-9]*; do ls -l "$p/fd" 2>/dev/null | grep -q -- "-> $DB\( \|$\)" && echo "${p#/proc/}"; done; true; }
excl_args() { if [ "$1" = ops ]; then echo "--exclude=/lunex-bot/"; fi; }
items() { (tar -tf "$M/src.tar" | cut -d/ -f1; echo dist; echo node_modules; echo RELEASE_SHA) | grep -v '^$' | sort -u | grep -vxE '\.env|data|logs|\.cache|\.config|\.npm|\.npm-cache|\.home|pax_global_header'; }
prisma_rel() { (cd "$REL" && env -i PATH=$CLEAN_PATH HOME="$REL/.home" DATABASE_URL="$URL" ./node_modules/.bin/prisma "$@"); }

# Operator-stated production state for this deployment: entry paused, no live
# positions at all, two CLOSED, zero deployed capital, and the two known
# build-stage-only exit:swap attempts (nonce/txHash/rawTx all NULL -- never
# signed, cannot broadcast).
state_line() {
  echo "paused=$(q "$DB" 'SELECT paused FROM "BotSettings";')" \
       "opening=$(q "$DB" "SELECT COUNT(*) FROM \"Position\" WHERE status='OPENING';")" \
       "active=$(q "$DB" "SELECT COUNT(*) FROM \"Position\" WHERE status='ACTIVE';")" \
       "closing=$(q "$DB" "SELECT COUNT(*) FROM \"Position\" WHERE status='CLOSING';")" \
       "closed=$(q "$DB" "SELECT COUNT(*) FROM \"Position\" WHERE status='CLOSED';")" \
       "signed=$(q "$DB" "SELECT COUNT(*) FROM \"TransactionAttempt\" WHERE status IN ('SIGNED','SENT','CONFIRMED');")" \
       "unsigned_pending=$(q "$DB" "SELECT COUNT(*) FROM \"TransactionAttempt\" WHERE status='PENDING' AND nonce IS NULL AND txHash IS NULL AND rawTx IS NULL;")" \
       "capital=$(q "$DB" "SELECT IFNULL(SUM(CAST(entryUsdgRaw AS INTEGER)),0) FROM \"Position\" WHERE status IN ('OPENING','ACTIVE','CLOSING');")"
}
# The two build-stage exit:swap rows were non-terminal until D4 fenced them,
# so the expected count is 2 before that deployment and 0 from D5 onwards.
case "$LABEL" in
  D5|D6|D8|D9|D10|D11) EXPECT_UNSIGNED_PENDING=0 ;;
  *)  EXPECT_UNSIGNED_PENDING=2 ;;
esac
guard_state() {
  local s; s=$(state_line); echo "$s"
  [ "$s" = "paused=1 opening=0 active=0 closing=0 closed=2 signed=0 unsigned_pending=$EXPECT_UNSIGNED_PENDING capital=0" ] || die "unexpected production state: $s"
}

case "$LABEL" in
  D6) EXPECT_NONCE=1610 ;;
  D8) EXPECT_NONCE=1618 ;;
  D9) EXPECT_NONCE=1618 ;;   # the OLD executor, unchanged since the forensic freeze   # the OLD executor's current nonce (unchanged since the forensic freeze)
  D10) EXPECT_NONCE=1618 ;;   # the guard measures the OLD wallet (hardcoded above): assert it has NOT moved since the rotation
  D11) EXPECT_NONCE=1618 ;;   # same as D10: the guard measures the OLD wallet (hardcoded above) -- assert it has not moved
  *)  EXPECT_NONCE=1609 ;;
esac

case "$STAGE" in
init)
  [ ! -e "$POINTER" ] || die "a deploy session already exists ($POINTER)"
  TS=$(date -u +%Y%m%dT%H%M%SZ); M=/opt/lunex/backups/deploy-$LABEL-$TS
  mkdir "$M"
  printf 'TS=%s\nM=%s\nBACKUP=%s\nREL=%s\nROLLBACK=%s\n' "$TS" "$M" "$M/production.db" "/opt/lunex/backups/release-$LABEL-$TS" "/opt/lunex/backups/rollback-prod-app-$LABEL-$TS" > "$POINTER"
  cat "$POINTER"
  ;;

record)
  load; guard_state
  { echo "hostname=$(hostname)"; systemctl show "$SVC" -p ActiveState -p MainPID -p NRestarts -p ExecMainStartTimestamp; } | tee "$M/service-pre.txt"
  echo "deployed RELEASE_SHA: $(cat "$PROD/RELEASE_SHA")"
  [ "$(cat "$PROD/RELEASE_SHA")" = "$PREV_SHA" ] || die "deployed SHA is not the expected previous release"
  (cd "$PROD" && find dist -type f -print0 | sort -z | xargs -0 sha256sum) > "$M/dist-sha256-pre.txt"
  echo "prod dist files: $(wc -l < "$M/dist-sha256-pre.txt")  fingerprint: $(sort "$M/dist-sha256-pre.txt" | sha256sum | cut -c1-16)"
  (cd "$PROD/ops/lunex-bot" && find . -type f -print0 | sort -z | xargs -0 sha256sum; find . -printf "%p %m %U:%G\n" | sort) > "$M/ops-lunex-bot-pre.txt"
  echo ".env: $(stat -c '%U:%G mode %a, %s bytes' "$PROD/.env") sha=$(sha256sum "$PROD/.env" | cut -c1-16)"
  q "$DB" "SELECT COUNT(*) FROM _prisma_migrations;" | sed 's/^/migrations applied: /'
  echo "on-chain nonce guard:"
  GUARD_RPC=$(grep '^RPC_FALLBACK_URLS=' "$PROD/.env" | cut -d= -f2- | cut -d, -f1)
  (cd "$PROD" && EXPECT_NONCE=$EXPECT_NONCE GUARD_RPC="$GUARD_RPC" node -e '
    if (process.env.GUARD_RPC) process.env.RPC_URL = process.env.GUARD_RPC; // read-only guard, no .env change
    const { getPublicClient } = require("./dist/blockchain/viemClient");
    const c = getPublicClient(); const W = "0x65299018ABAaa6bD89aabF689dbEf21Be99ef1Ea";
    (async () => {
      const [l, p] = await Promise.all([c.getTransactionCount({address:W, blockTag:"latest"}), c.getTransactionCount({address:W, blockTag:"pending"})]);
      console.log("  nonce latest=" + l + " pending=" + p);
      const e = Number(process.env.EXPECT_NONCE);
      if (l !== e || p !== e) { console.error("nonce is not " + e + "/" + e); process.exit(1); }
    })();' 2>&1 | grep -v 'injected env') || die "nonce guard failed"
  ;;

release)
  load
  [ -f "$M/src.tar" ] && [ -f "$M/src.tar.sha256" ] && [ -f "$M/expected-blob-sha256.txt" ] || die "archive/manifest not uploaded"
  (cd "$M" && sha256sum -c src.tar.sha256) || die "archive hash mismatch"
  CID=$(git get-tar-commit-id < "$M/src.tar"); echo "tar embedded commit id: $CID"
  [ "$CID" = "$EXPECTED_SHA" ] || die "archive commit id mismatch"
  [ ! -e "$REL" ] || die "release dir exists"
  mkdir "$REL"; tar -xf "$M/src.tar" -C "$REL"
  (cd "$REL" && sha256sum -c --quiet "$M/expected-blob-sha256.txt") || die "extracted files differ from audited git blobs"
  NF=$(cd "$REL" && find . -type f | wc -l); NE=$(wc -l < "$M/expected-blob-sha256.txt")
  echo "extracted files: $NF == audited blobs: $NE -> all byte-identical"
  [ "$NF" = "$NE" ] || die "extra/missing files"
  NCR=$( (grep -rlU "$CR" "$REL" || true) | wc -l); echo "files containing CR: $NCR"
  [ "$NCR" = 0 ] || die "CR bytes present"
  AI=$( (grep -rlE "aiEntryPaused|AI_SUPERVISOR_TOKEN_SHA256|createAiControlRouter|add_ai_entry" "$REL/src" "$REL/prisma" 2>/dev/null || true) | wc -l)
  echo "AI-control files in release source: $AI (expected $AI_EXPECTED-style)"
  if [ "$AI_EXPECTED" = 0 ]; then
    [ "$AI" = 0 ] || die "AI control present in a non-AI release -- refusing"
  else
    [ "$AI" -gt 0 ] || die "AI control missing from the AI release"
  fi
  echo "$EXPECTED_SHA" > "$REL/RELEASE_SHA"
  echo "release dir: $REL"
  ;;

install)
  load; cd "$REL"; mkdir -p "$REL/.home"
  timeout 1800 env -i PATH=$CLEAN_PATH HOME="$REL/.home" npm ci --no-audit --no-fund > "$M/npm-ci.log" 2>&1 || { tail -20 "$M/npm-ci.log"; die "npm ci failed"; }
  tail -1 "$M/npm-ci.log"
  OUT=$(env -i PATH=$CLEAN_PATH HOME="$REL/.home" ./node_modules/.bin/prisma -v 2>&1)
  P=$(echo "$OUT" | awk -F': *' '/^prisma /{print $2}' | tr -d ' ')
  C=$(echo "$OUT" | awk -F': *' '/^@prisma\/client /{print $2}' | tr -d ' ')
  echo "prisma=$P @prisma/client=$C node=$(node -v) npm=$(npm -v)"
  [ "$P" = 7.10.0 ] && [ "$C" = 7.10.0 ] || die "Prisma version gate failed"
  echo "VERSION GATE: PASS"
  ;;

validate-bg)
  load; cd "$REL"
  sha256sum "$DB" > "$M/prod-db-before-tests.sha256"
  # Stale-result race fix: a previous validation in this session leaves
  # validate.rc behind, and validate-wait used to accept ANY existing rc --
  # consuming the old verdict while this run was still going (a stale PASS
  # would have waved through an unvalidated build). Each run now mints a token:
  # the old rc is removed, the token is recorded, and the rc is written as
  # "<token> <rc>" so validate-wait can tell whose result it is reading.
  VTOKEN="$(date -u +%Y%m%dT%H%M%S)-$$-$RANDOM"
  rm -f "$M/validate.rc"
  printf '%s\n' "$VTOKEN" > "$M/validate.run"
  nohup bash -c "set -o pipefail; cd '$REL'; E='env -i PATH=$CLEAN_PATH HOME=$REL/.home'; rc=0; for s in test typecheck lint build; do echo \"=== npm run \$s\"; \$E npm run \$s > '$M/validate-'\$s'.log' 2>&1; r=\$?; echo \"\$s rc=\$r\"; [ \$r = 0 ] || { rc=\$r; break; }; done; printf '%s %s\\n' '$VTOKEN' \"\$rc\" > '$M/validate.rc'" > "$M/validate.log" 2>&1 &
  echo "validation started (pid $!, token $VTOKEN)"
  ;;

validate-wait)
  load
  # Wait for THIS run's result, identified by the token validate-bg minted --
  # never merely for a validate.rc to exist (see validate-bg).
  [ -f "$M/validate.run" ] || die "no validation has been started for this session -- run validate-bg first"
  VTOKEN=$(cat "$M/validate.run")
  [ -n "$VTOKEN" ] || die "validate.run is empty -- cannot identify the current validation run"
  rc_token() { [ -f "$M/validate.rc" ] && awk 'NR==1{print $1}' "$M/validate.rc" || true; }
  for i in $(seq 1 170); do [ "$(rc_token)" = "$VTOKEN" ] && break; sleep 5; done
  cat "$M/validate.log"
  [ "$(rc_token)" = "$VTOKEN" ] || { echo "still running (no result yet for token $VTOKEN)"; exit 3; }
  grep -E "Test Files|Tests " "$M/validate-test.log" 2>/dev/null | sed 's/\x1b\[[0-9;]*m//g' | tail -2 || true
  RC=$(awk 'NR==1{print $2}' "$M/validate.rc"); [ "$RC" = 0 ] || die "validation failed (rc=$RC)"
  [ -f "$REL/dist/index.js" ] || die "dist/index.js missing"
  for m in $MARKERS; do [ -f "$REL/$m" ] || die "release build lacks $m"; done
  grep -q "$MK_SYM" "$REL/$MK_FILE" || die "built $MK_FILE lacks $MK_SYM"
  echo "release markers present: $MARKERS ($MK_SYM in $MK_FILE)"
  (cd "$REL" && find dist ui/dist -type f -print0 | sort -z | xargs -0 sha256sum) > "$M/release-build.manifest"
  echo "build manifest files: $(wc -l < "$M/release-build.manifest")"
  if sha256sum -c --quiet "$M/prod-db-before-tests.sha256" 2>/dev/null; then
    echo "production DB: byte-identical after validation"
  else
    echo "production DB: advanced during validation (expected -- the bot is running; the invariant is enforced at promote, service stopped)"
  fi
  echo "VALIDATION: PASS"
  ;;

schema-check)
  load
  OUT=$(prisma_rel migrate status 2>&1 || true)
  echo "$OUT" | grep -E "Datasource|migrations found|up to date|not yet been applied|modified|failed" || true
  if [ "$MIGRATES" = no ]; then
    echo "$OUT" | grep -q "Database schema is up to date" || die "schema not up to date -- this stage does not migrate"
  else
    echo "$OUT" | grep -qE "not yet been applied" || die "expected the new migration to be pending"
  fi
  if echo "$OUT" | grep -qiE 'modified|failed|drift|diverge'; then die "Prisma reports migration history divergence"; fi
  BAD=0
  for d in "$REL"/prisma/migrations/2*/; do
    m=$(basename "$d"); DBC=$(q "$DB" "SELECT checksum FROM _prisma_migrations WHERE migration_name='$m';"); FS=$(sha256sum "$d/migration.sql" | cut -d' ' -f1)
    if [ -z "$DBC" ]; then
      if [ "$MIGRATES" = yes ]; then echo "pending (not yet applied): $m"; else echo "missing in DB: $m"; BAD=1; fi
    elif [ "$DBC" != "$FS" ]; then echo "checksum mismatch: $m"; BAD=1; fi
  done
  [ "$BAD" = 0 ] || die "stored migration checksums differ from release files"
  echo "SCHEMA-CHECK: PASS"
  ;;

stop)
  load; guard_state
  date '+%Y-%m-%d %H:%M:%S' > "$M/stop-time.txt"
  systemctl stop "$SVC"
  svc_inactive || die "$SVC still active after stop"
  sleep 2
  H=$(holders); [ -z "$H" ] || die "process(es) still hold the DB: $H"
  echo "stopped at $(cat "$M/stop-time.txt"); is-active: $(svc_state); DB holders: none"
  for s in finance-bot guardian lunex-ai; do echo "$s: $(systemctl is-active $s 2>&1 || true)"; done
  ;;

backup)
  load; svc_inactive || die "service not stopped"; [ -z "$(holders)" ] || die "DB is held open"
  [ ! -e "$DB-journal" ] && [ ! -e "$DB-wal" ] || die "journal/WAL next to production DB"
  [ ! -e "$BACKUP" ] || die "backup exists"
  sha256sum "$DB" | tee "$M/prod-db-pre.sha256"
  sqlite3 -readonly "$DB" ".backup '$BACKUP'"
  (cd "$M" && sha256sum production.db > production.db.sha256)
  ls -l "$BACKUP"; cat "$M/production.db.sha256"
  R=$(q "$BACKUP" "PRAGMA integrity_check;"); echo "backup integrity_check: $R"
  [ "$R" = ok ] || die "backup integrity"
  sha256sum -c --quiet "$M/prod-db-pre.sha256" || die "production DB changed during backup"
  echo "production DB unchanged by backup: yes"
  ;;

migrate)
  load; svc_inactive || die "service not stopped -- migrate only while stopped"
  [ "$MIGRATES" = yes ] || die "$LABEL has no migration"
  [ -f "$M/production.db.sha256" ] || die "take the backup first"
  echo "--- before:"
  q "$DB" "SELECT COUNT(*) FROM _prisma_migrations;" | sed 's/^/migrations: /'
  echo "BotSettings columns: $(q "$DB" "PRAGMA table_info('BotSettings');" | cut -d'|' -f2 | tr '\n' ' ')"
  echo "positions: $(q "$DB" "SELECT status||'='||COUNT(*) FROM \"Position\" GROUP BY status;" | tr '\n' ' ')"
  prisma_rel migrate deploy 2>&1 | tail -8
  echo "--- after:"
  q "$DB" "SELECT COUNT(*) FROM _prisma_migrations;" | sed 's/^/migrations: /'
  echo "BotSettings columns: $(q "$DB" "PRAGMA table_info('BotSettings');" | cut -d'|' -f2 | tr '\n' ' ')"
  q "$DB" "SELECT migration_name||' | finished='||IFNULL(finished_at,'NULL')||' | rolled_back='||IFNULL(rolled_back_at,'-') FROM _prisma_migrations ORDER BY started_at DESC LIMIT 3;"
  DBC=$(q "$DB" "SELECT checksum FROM _prisma_migrations WHERE migration_name='$MIGRATION';")
  FS=$(sha256sum "$REL/prisma/migrations/$MIGRATION/migration.sql" | cut -d' ' -f1)
  echo "checksum stored=$DBC file=$FS"
  [ "$DBC" = "$FS" ] || die "migration checksum mismatch"
  BAD=0
  for d in "$REL"/prisma/migrations/2*/; do
    m=$(basename "$d"); c=$(q "$DB" "SELECT checksum FROM _prisma_migrations WHERE migration_name='$m';"); f=$(sha256sum "$d/migration.sql" | cut -d' ' -f1)
    [ "$c" = "$f" ] || { echo "MISMATCH $m"; BAD=1; }
  done
  [ "$BAD" = 0 ] || die "a migration checksum diverged"
  echo "all migration checksums match their release files"
  echo "entry flags: $(q "$DB" 'SELECT "paused="||paused||" aiEntryPaused="||aiEntryPaused FROM "BotSettings";')"
  echo "positions after: $(q "$DB" "SELECT status||'='||COUNT(*) FROM \"Position\" GROUP BY status;" | tr '\n' ' ')"
  echo "DustSettlement rows: $(q "$DB" 'SELECT COUNT(*) FROM "DustSettlement";')"
  echo "MIGRATE: PASS"
  ;;

promote-dryrun)
  load; svc_inactive || die "service not stopped"
  IT=$(items); echo "items: $(echo $IT)"
  for f in .env data logs .cache .config .npm .npm-cache; do
    if echo "$IT" | grep -qxF "$f"; then die "item list contains $f"; fi
  done
  echo "forbidden items in list: none"
  for i in $IT; do
    [ -e "$REL/$i" ] || die "release lacks $i"
    if [ -d "$REL/$i" ]; then
      N=$(rsync -ain --delete $(excl_args "$i") "$REL/$i/" "$PROD/$i/" | wc -l)
      DL=$( (rsync -ain --delete $(excl_args "$i") "$REL/$i/" "$PROD/$i/" | grep -c '^\*deleting') || true)
      echo "dry-run $i/ : $N changes ($DL deletions)"
      if [ "$i" = ops ]; then
        LB=$( (rsync -ain --delete $(excl_args ops) "$REL/ops/" "$PROD/ops/" | grep -E '^\S+\s+lunex-bot(/|$)') || true)
        [ -z "$LB" ] || die "ops/lunex-bot would be touched: $LB"
        echo "ops/lunex-bot/: excluded (0 changes, 0 deletions)"
      fi
    else
      echo "dry-run file $i : $(cmp -s "$REL/$i" "$PROD/$i" 2>/dev/null && echo identical || echo replace)"
    fi
  done
  touch "$M/promote-dryrun.ok"
  ;;

promote)
  load; svc_inactive || die "service not stopped"
  [ -f "$M/promote-dryrun.ok" ] || die "promote-dryrun has not passed"
  # validate.rc is "<token> <rc>" (see validate-bg); read the rc FIELD, not the
  # whole file, exactly as validate-wait does.
  [ "$(awk 'NR==1{print $2}' "$M/validate.rc" 2>/dev/null)" = 0 ] && [ -f "$M/release-build.manifest" ] || die "release not validated"
  [ ! -e "$ROLLBACK" ] || die "rollback dir exists"
  IT=$(items); echo "$IT" > "$M/promote-items.txt"
  sha256sum "$PROD/.env" > "$M/env.sha256"
  sha256sum "$DB" > "$M/prod-db-at-promote.sha256"
  mkdir "$ROLLBACK"
  for i in $IT; do [ -e "$PROD/$i" ] && cp -a "$PROD/$i" "$ROLLBACK/"; done
  echo "rollback copy: $ROLLBACK ($(du -sh "$ROLLBACK" | cut -f1))"
  for i in $IT; do
    if [ -d "$REL/$i" ]; then rsync -a --delete $(excl_args "$i") "$REL/$i/" "$PROD/$i/"; else cp -p "$REL/$i" "$PROD/$i"; fi
    if [ "$i" = ops ]; then
      find "$PROD/ops" -path "$PROD/ops/lunex-bot" -prune -o -exec chown lunex-bot:lunex-bot {} +
    else
      chown -R lunex-bot:lunex-bot "$PROD/$i"
    fi
  done
  echo "not replaced (kept): $(cd "$PROD" && ls -A | grep -vxF -f "$M/promote-items.txt" | tr '\n' ' ')"
  sha256sum -c --quiet "$M/env.sha256" || die ".env changed"
  echo ".env unchanged: yes"
  sha256sum -c --quiet "$M/prod-db-at-promote.sha256" || die "DB changed during promotion"
  echo "data/lunex.db unchanged: yes"
  ;;

verify-release)
  load
  (cd "$PROD" && sha256sum -c --quiet "$M/release-build.manifest") || die "production build differs from the validated release build"
  echo "dist + ui/dist: identical to validated release build ($(wc -l < "$M/release-build.manifest") files)"
  echo "RELEASE_SHA: $(cat "$PROD/RELEASE_SHA")"
  [ "$(cat "$PROD/RELEASE_SHA")" = "$EXPECTED_SHA" ] || die "RELEASE_SHA mismatch"
  diff -rq "$REL/src" "$PROD/src" >/dev/null && diff -rq "$REL/prisma" "$PROD/prisma" >/dev/null || die "src/prisma differ from release"
  echo "src/ and prisma/: identical to audited release"
  for m in $MARKERS; do [ -f "$PROD/$m" ] || die "deployed dist lacks $m"; done
  grep -q "$MK_SYM" "$PROD/$MK_FILE" || die "deployed $MK_FILE lacks $MK_SYM"
  echo "deployed markers present: $MARKERS ($MK_SYM in $MK_FILE)"
  AI=$( (grep -rlE "aiEntryPaused|AI_SUPERVISOR_TOKEN_SHA256|createAiControlRouter" "$PROD/dist" 2>/dev/null || true) | wc -l)
  echo "AI-control files in deployed dist: $AI"
  if [ "$AI_EXPECTED" = 0 ]; then
    [ "$AI" = 0 ] || die "AI control reached production early"
  else
    [ "$AI" -gt 0 ] || die "AI control missing from production"
  fi
  (cd "$PROD/ops/lunex-bot" && find . -type f -print0 | sort -z | xargs -0 sha256sum; find . -printf "%p %m %U:%G\n" | sort) > "$M/ops-lunex-bot-post.txt"
  cmp -s "$M/ops-lunex-bot-pre.txt" "$M/ops-lunex-bot-post.txt" && echo "ops/lunex-bot/: byte-identical incl. perms/owner" || die "ops/lunex-bot changed"
  echo "backup cron: $( (crontab -u lunex-bot -l 2>/dev/null | grep -c 'ops/lunex-bot/backup-db.sh') || true) entry; backup-db.sh executable: $([ -x "$PROD/ops/lunex-bot/backup-db.sh" ] && echo yes || echo NO)"
  ;;

start)
  load
  systemctl start "$SVC"; sleep 2
  echo "immediately after start: $(svc_state)"
  [ "$(svc_state)" = active ] || die "not active right after start"
  sleep 60
  systemctl show "$SVC" -p ActiveState -p SubState -p MainPID -p NRestarts -p ExecMainStartTimestamp | tee "$M/service-post.txt"
  [ "$(svc_state)" = active ] || die "service not active after 60s"
  [ "$(systemctl show "$SVC" -p NRestarts --value)" = 0 ] || die "service restarted (crash loop?)"
  P=$(systemctl show "$SVC" -p MainPID --value)
  echo "cwd=$(readlink /proc/$P/cwd) cmd=$(tr '\0' ' ' < /proc/$P/cmdline)"
  ;;

health)
  load
  SINCE=$(cat "$M/stop-time.txt")
  echo "--- startup lines (non-tick):"
  journalctl -u "$SVC" --since "$SINCE" --no-pager -o short-iso | grep -vE '"event":"(monitoring_cycle|exit_cycle|stuck_transaction_attempts)"' | cut -c1-260 | tail -14
  echo "--- error scan:"
  ( (journalctl -u "$SVC" --since "$SINCE" --no-pager -o cat | grep -iE 'prisma|sqlite|schema|migration|unhandled|uncaught|fatal|exception|"level":"error"' | grep -v '"db":"sqlite"' | cut -c1-240 | tail -8) || echo "(no matches)")
  echo "--- signing/broadcast attempts since start (must be 0):"
  echo "  $( (journalctl -u "$SVC" --since "$SINCE" --no-pager -o cat | grep -ciE 'signTransaction|sendRawTransaction') || true)"
  echo "ticks since start: exit=$( (journalctl -u "$SVC" --since "$SINCE" --no-pager -o cat | grep -c '\"event\":\"exit_cycle\"') || true) monitoring=$( (journalctl -u "$SVC" --since "$SINCE" --no-pager -o cat | grep -c '\"event\":\"monitoring_cycle\"') || true) screening=$( (journalctl -u "$SVC" --since "$SINCE" --no-pager -o cat | grep -c '\"event\":\"screening_cycle\"') || true)"
  guard_state
  ;;

*) die "unknown stage $STAGE" ;;
esac
