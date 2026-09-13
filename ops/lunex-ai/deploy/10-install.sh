#!/usr/bin/env bash
# Lunex AI supervisor -- installer (idempotent). Run as root on the VPS.
#
# Touches ONLY: user/group lunex-ai, /opt/lunex/workspace, /opt/lunex/ai,
# /etc/systemd/system/lunex-ai.service and one log file in /var/log.
# Never touches /opt/finance-bot, /opt/guardian, /opt/lunex/production,
# /opt/lunex/trading or any other service. Never overwrites the contents of an
# existing environment file, never discards uncommitted work, never pushes,
# force-updates or rebases. Never prints secrets.
#
# Usage:
#   sudo bash 10-install.sh --bundle /path/lunex.bundle --commit <40-hex sha>
#   sudo bash 10-install.sh --git-url <url> --commit <40-hex sha>
# Options:
#   --skip-gates   skip the Lunex + supervisor verification gates (NOT recommended)
set -euo pipefail
umask 027
export LC_ALL=C.UTF-8

readonly SVC_USER=lunex-ai
readonly SUPERVISOR_BRANCH=ai/lunex-ai-supervisor
readonly INTEGRATION_BRANCH=ai/develop
readonly LUNEX_ROOT=/opt/lunex
readonly WORKSPACE_PARENT=$LUNEX_ROOT/workspace
readonly WORKSPACE=$WORKSPACE_PARENT/lunex
readonly AI_HOME=$LUNEX_ROOT/ai
readonly APP_DIR=$AI_HOME/lunex-ai
readonly SVC_HOME=$AI_HOME/home
readonly ENV_FILE=$AI_HOME/lunex-ai.env
readonly UNIT_DST=/etc/systemd/system/lunex-ai.service

BUNDLE=""
GIT_URL=""
EXPECT_COMMIT=""
SKIP_GATES=0

if [[ $EUID -ne 0 ]]; then
  echo "[install] ERROR: run as root: sudo bash $0 ..." >&2
  exit 1
fi

LOG_FILE=/var/log/lunex-ai-install-$(date -u +%Y%m%dT%H%M%SZ).log
readonly LOG_FILE
touch "$LOG_FILE"
chmod 0640 "$LOG_FILE"

log() { printf '[install %s] %s\n' "$(date -u +%H:%M:%S)" "$*" | tee -a "$LOG_FILE"; }
die() { printf '[install] ERROR: %s\n' "$*" | tee -a "$LOG_FILE" >&2; exit 1; }

while [[ $# -gt 0 ]]; do
  case "$1" in
    --bundle) BUNDLE=${2:-}; shift 2 ;;
    --git-url) GIT_URL=${2:-}; shift 2 ;;
    --commit) EXPECT_COMMIT=${2:-}; shift 2 ;;
    --skip-gates) SKIP_GATES=1; shift ;;
    -h|--help) sed -n '2,16p' "$0"; exit 0 ;;
    *) die "unknown argument: $1" ;;
  esac
done

# ---- 1. preflight ---------------------------------------------------------------
log "step 1/9 preflight"
if [[ -n "$BUNDLE" && -n "$GIT_URL" ]] || [[ -z "$BUNDLE" && -z "$GIT_URL" ]]; then
  die "give exactly one of --bundle or --git-url"
fi
[[ "$EXPECT_COMMIT" =~ ^[0-9a-f]{40}$ ]] || die "--commit <full 40-hex sha> is required (reproducible deployment)"
[[ -z "$BUNDLE" || -r "$BUNDLE" ]] || die "bundle not readable: $BUNDLE"
if [[ -r /etc/os-release ]]; then
  . /etc/os-release
  [[ "${ID:-}" == ubuntu ]] || log "WARNING: not Ubuntu (${PRETTY_NAME:-unknown}); continuing"
fi
for t in git systemctl systemd-analyze runuser install useradd node npm; do
  command -v "$t" >/dev/null 2>&1 || die "required tool missing: $t"
done
NODE_BIN=$(readlink -f "$(command -v node)")
case "$NODE_BIN" in
  /root/*|/home/*) die "node resolves to $NODE_BIN -- the sandboxed service cannot see /root or /home. Install a system-wide Node.js >= 20 first." ;;
esac
NODE_MAJOR=$("$NODE_BIN" -p 'process.versions.node.split(".")[0]')
(( NODE_MAJOR >= 20 )) || die "Node.js >= 20 required, found $("$NODE_BIN" -v)"
SAFE_PATH="$(dirname "$NODE_BIN"):/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin"
log "node=$NODE_BIN ($("$NODE_BIN" -v))  log=$LOG_FILE"

# Runs a command as the service user with a clean environment: nothing from
# root's environment (which may hold other projects' secrets) is inherited.
as_svc() {
  runuser -u "$SVC_USER" -- env -i PATH="$SAFE_PATH" HOME="$SVC_HOME" npm_config_cache="$SVC_HOME/.npm" LANG=C.UTF-8 CI=1 "$@"
}
in_ws() {
  as_svc bash -c 'cd "$1" && shift && "$@"' _ "$WORKSPACE" "$@"
}

# ---- 2. service user -------------------------------------------------------------
log "step 2/9 service user $SVC_USER"
if id "$SVC_USER" >/dev/null 2>&1; then
  log "user exists"
else
  useradd --system --user-group --home-dir "$SVC_HOME" --no-create-home --shell /usr/sbin/nologin --comment "Lunex AI development supervisor" "$SVC_USER"
  log "created system user $SVC_USER (no login shell, no sudo)"
fi
[[ "$(id -nG "$SVC_USER")" == "$SVC_USER" ]] || die "$SVC_USER is in extra groups ($(id -nG "$SVC_USER")) -- it must not share groups with other projects"

# ---- 3. directories --------------------------------------------------------------
log "step 3/9 directories"
ensure_dir() { # path mode owner group
  if [[ -e "$1" && ! -d "$1" ]]; then die "$1 exists and is not a directory"; fi
  install -d -m "$2" -o "$3" -g "$4" "$1"
}
if [[ ! -d "$LUNEX_ROOT" ]]; then
  install -d -m 0755 -o root -g root "$LUNEX_ROOT"
  log "created $LUNEX_ROOT"
fi
runuser -u "$SVC_USER" -- test -x "$LUNEX_ROOT" \
  || die "$SVC_USER cannot traverse $LUNEX_ROOT ($(stat -c '%A %U:%G' "$LUNEX_ROOT")). Not changed automatically because it also holds production; grant o+x (or an ACL for $SVC_USER) yourself, then re-run."
ensure_dir "$WORKSPACE_PARENT" 0750 root "$SVC_USER"
ensure_dir "$AI_HOME" 0750 root "$SVC_USER"
ensure_dir "$SVC_HOME" 0700 "$SVC_USER" "$SVC_USER"
ensure_dir "$APP_DIR" 0750 root "$SVC_USER"

# ---- 4. Lunex source -------------------------------------------------------------
log "step 4/9 Lunex source: $SUPERVISOR_BRANCH @ $EXPECT_COMMIT"
if [[ -n "$BUNDLE" ]]; then
  install -m 0640 -o root -g "$SVC_USER" "$BUNDLE" "$AI_HOME/lunex.bundle"
  SRC="$AI_HOME/lunex.bundle"
  as_svc git bundle verify "$SRC" >>"$LOG_FILE" 2>&1 || die "git bundle verify failed (see $LOG_FILE)"
else
  SRC="$GIT_URL"
fi

if [[ -d "$WORKSPACE/.git" ]]; then
  [[ "$(stat -c %U "$WORKSPACE")" == "$SVC_USER" ]] || die "$WORKSPACE exists but is not owned by $SVC_USER -- refusing to take it over"
  grep -q '"name": "lunex-bot"' "$WORKSPACE/package.json" 2>/dev/null || die "$WORKSPACE is not the Lunex repository"
  dirty=$(in_ws git status --porcelain | wc -l)
  (( dirty == 0 )) || die "$WORKSPACE has $dirty uncommitted path(s) -- refusing to update (work is never discarded)"
  in_ws git fetch --no-tags "$SRC" "refs/heads/$SUPERVISOR_BRANCH:refs/remotes/deploy/$SUPERVISOR_BRANCH" >>"$LOG_FILE" 2>&1 \
    || die "fetch from the source failed (see $LOG_FILE)"
  if in_ws git show-ref --verify --quiet "refs/heads/$SUPERVISOR_BRANCH"; then
    in_ws git checkout -q "$SUPERVISOR_BRANCH"
    in_ws git merge --ff-only -q "refs/remotes/deploy/$SUPERVISOR_BRANCH" >>"$LOG_FILE" 2>&1 \
      || die "$SUPERVISOR_BRANCH on the VPS has diverged from the source -- refusing (no force, no rebase). Resolve manually."
  else
    in_ws git checkout -q -b "$SUPERVISOR_BRANCH" "refs/remotes/deploy/$SUPERVISOR_BRANCH"
  fi
  in_ws git update-ref -d "refs/remotes/deploy/$SUPERVISOR_BRANCH"
else
  if [[ -e "$WORKSPACE" && -n "$(ls -A "$WORKSPACE" 2>/dev/null)" ]]; then
    die "$WORKSPACE exists, is not a git repository and is not empty -- refusing"
  fi
  ensure_dir "$WORKSPACE" 0750 "$SVC_USER" "$SVC_USER"
  as_svc git clone -q --no-tags --branch "$SUPERVISOR_BRANCH" --origin deploy "$SRC" "$WORKSPACE" >>"$LOG_FILE" 2>&1 \
    || die "git clone failed (see $LOG_FILE). A private GitHub URL needs read credentials on the VPS -- use --bundle instead."
fi

HEAD_NOW=$(in_ws git rev-parse HEAD)
[[ "$HEAD_NOW" == "$EXPECT_COMMIT" ]] || die "workspace HEAD is $HEAD_NOW, expected $EXPECT_COMMIT"
while read -r remote; do
  [[ -n "$remote" ]] || continue
  in_ws git remote remove "$remote"
  log "removed git remote '$remote' (the supervisor workspace must have nothing to push to)"
done < <(in_ws git remote)
in_ws git config user.name "Lunex AI"
in_ws git config user.email "lunex-ai@localhost"
in_ws git config core.autocrlf false
if ! in_ws git show-ref --verify --quiet "refs/heads/$INTEGRATION_BRANCH"; then
  in_ws git branch "$INTEGRATION_BRANCH" "$SUPERVISOR_BRANCH"
  log "created $INTEGRATION_BRANCH from $SUPERVISOR_BRANCH"
fi
chmod 0750 "$WORKSPACE"
log "workspace ready: $(in_ws git rev-parse --abbrev-ref HEAD) @ ${HEAD_NOW:0:12}"

# ---- 5. dependencies -------------------------------------------------------------
log "step 5/9 dependencies (npm ci as $SVC_USER)"
in_ws npm ci --no-audit --no-fund >>"$LOG_FILE" 2>&1 \
  || die "npm ci failed (see $LOG_FILE). If better-sqlite3 failed to compile: apt-get install -y build-essential python3, then re-run."

# ---- 6. verification gates -------------------------------------------------------
log "step 6/9 verification gates (as $SVC_USER)"
run_gate() {
  local name=$1
  shift
  if in_ws "$@" >>"$LOG_FILE" 2>&1; then log "  PASS $name"; else log "  FAIL $name"; return 1; fi
}
if (( SKIP_GATES == 0 )); then
  gates_failed=0
  for gate in typecheck lint test build ai:typecheck ai:lint ai:test; do
    run_gate "npm run $gate" npm run "$gate" || gates_failed=1
  done
  grep -E '^[[:space:]]*Tests[[:space:]]+[0-9]+' "$LOG_FILE" | sed 's/\x1b\[[0-9;]*m//g' | while read -r line; do log "  $line"; done || true
  (( gates_failed == 0 )) || die "verification gates failed -- supervisor NOT installed or started (see $LOG_FILE)"
else
  log "  WARNING: gates skipped (--skip-gates)"
fi
run_gate "npm run ai:build" npm run ai:build || die "supervisor build failed (see $LOG_FILE)"

# ---- 7. deployed supervisor build ------------------------------------------------
log "step 7/9 install supervisor build into $APP_DIR"
rm -rf "$APP_DIR/dist.new"
cp -R "$WORKSPACE/ops/lunex-ai/dist" "$APP_DIR/dist.new"
chown -R root:"$SVC_USER" "$APP_DIR/dist.new"
find "$APP_DIR/dist.new" -type d -exec chmod 0750 {} +
find "$APP_DIR/dist.new" -type f -exec chmod 0640 {} +
rm -rf "$APP_DIR/dist.old"
if [[ -d "$APP_DIR/dist" ]]; then mv "$APP_DIR/dist" "$APP_DIR/dist.old"; fi
mv "$APP_DIR/dist.new" "$APP_DIR/dist"
printf '%s\n' "$HEAD_NOW" > "$APP_DIR/DEPLOYED_COMMIT"
chown root:"$SVC_USER" "$APP_DIR/DEPLOYED_COMMIT"
chmod 0640 "$APP_DIR/DEPLOYED_COMMIT"

# ---- 8. environment file ---------------------------------------------------------
log "step 8/9 environment file $ENV_FILE"
if [[ ! -e "$ENV_FILE" ]]; then
  (
    umask 077
    cat > "$ENV_FILE" <<'ENVEOF'
# Lunex AI supervisor environment. Fill in the three secrets with:
#   sudoedit /opt/lunex/ai/lunex-ai.env
# TELEGRAM_BOT_TOKEN must belong to a DEDICATED control bot -- never the Lunex trading bot.
TELEGRAM_BOT_TOKEN=
TELEGRAM_ADMIN_ID=
TOKENROUTER_API_KEY=
LUNEX_AI_MODEL=z-ai/glm-5.3-free
LUNEX_AI_BASE_URL=https://api.tokenrouter.com/v1
ENVEOF
  )
  log "created template (secrets empty)"
else
  log "exists -- contents left untouched"
fi
chown "$SVC_USER:$SVC_USER" "$ENV_FILE"
chmod 0600 "$ENV_FILE"
missing=()
for key in TELEGRAM_BOT_TOKEN TELEGRAM_ADMIN_ID TOKENROUTER_API_KEY; do
  grep -Eq "^${key}=[^[:space:]]+" "$ENV_FILE" || missing+=("$key")
done

# ---- 9. systemd ------------------------------------------------------------------
log "step 9/9 systemd unit"
tmp_unit=$(mktemp)
sed -e "s#^ExecStart=/usr/bin/node #ExecStart=$NODE_BIN #" \
    -e "s#^Environment=PATH=.*#Environment=PATH=$SAFE_PATH#" \
    "$WORKSPACE/ops/lunex-ai/systemd/lunex-ai.service" > "$tmp_unit"
grep -qx "ExecStart=$NODE_BIN $APP_DIR/dist/main.js" "$tmp_unit" || { rm -f "$tmp_unit"; die "unit template does not match the expected ExecStart"; }
install -m 0644 -o root -g root "$tmp_unit" "$UNIT_DST"
rm -f "$tmp_unit"
systemd-analyze verify "$UNIT_DST" >>"$LOG_FILE" 2>&1 || log "WARNING: systemd-analyze verify reported issues (see $LOG_FILE)"
systemctl daemon-reload
systemctl enable lunex-ai.service >>"$LOG_FILE" 2>&1
log "enabled lunex-ai.service (starts at boot, Restart=always)"

if (( ${#missing[@]} > 0 )); then
  log "NOT STARTED: secrets missing: ${missing[*]}"
  log "  fill them with:  sudoedit $ENV_FILE"
  log "  then start with: systemctl start lunex-ai"
else
  systemctl restart lunex-ai.service
  sleep 8
  if systemctl is-active --quiet lunex-ai.service; then
    log "lunex-ai.service is active"
  else
    log "lunex-ai.service is NOT active -- inspect: journalctl -u lunex-ai -n 50 --no-pager"
  fi
fi

log "done: commit=$HEAD_NOW"
log "next: sudo bash $WORKSPACE/ops/lunex-ai/deploy/20-validate.sh"
