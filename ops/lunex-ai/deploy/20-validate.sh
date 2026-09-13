#!/usr/bin/env bash
# Lunex AI supervisor -- post-install validation. Run as root.
#
# Prints PASS / FAIL / WARN / INFO / MANUAL per check. Secret values are never
# printed: leak checks report counts only, and live checks print masked JSON.
#
# Usage:
#   sudo bash 20-validate.sh                   host, sandbox, guards, git, secrets, state, live connectivity
#   sudo bash 20-validate.sh --restart-test    also: systemctl restart, and SIGKILL crash-restart when idle
#   sudo bash 20-validate.sh --recovery-test   also: SIGKILL while a task is running, verify it is re-queued
set -uo pipefail
export LC_ALL=C.UTF-8
if [[ $EUID -ne 0 ]]; then echo "run as root" >&2; exit 1; fi

readonly SVC_USER=lunex-ai
readonly UNIT=lunex-ai.service
readonly WORKSPACE=/opt/lunex/workspace/lunex
readonly AI_HOME=/opt/lunex/ai
readonly APP_DIR=$AI_HOME/lunex-ai
readonly ENV_FILE=$AI_HOME/lunex-ai.env
readonly STATE=$WORKSPACE/.ai/state
readonly FORBIDDEN=(/opt/finance-bot /opt/guardian /opt/lunex/production /opt/lunex/trading /root)

RESTART_TEST=0
RECOVERY_TEST=0
for arg in "$@"; do
  case "$arg" in
    --restart-test) RESTART_TEST=1 ;;
    --recovery-test) RECOVERY_TEST=1 ;;
    *) echo "unknown argument: $arg" >&2; exit 2 ;;
  esac
done

pass=0; fail=0; warn=0
PASS() { printf 'PASS    %s\n' "$*"; pass=$((pass + 1)); }
FAIL() { printf 'FAIL    %s\n' "$*"; fail=$((fail + 1)); }
WARN() { printf 'WARN    %s\n' "$*"; warn=$((warn + 1)); }
INFO() { printf 'INFO    %s\n' "$*"; }
MANUAL() { printf 'MANUAL  %s\n' "$*"; }
section() { printf '\n== %s ==\n' "$1"; }
indent() { sed 's/^/        /'; }
expect_mode() {
  local got
  got=$(stat -c '%a %U:%G' "$1" 2>/dev/null)
  if [[ "$got" == "$2" ]]; then PASS "$1 is $2"; else FAIL "$1 is '${got:-absent}', expected $2"; fi
}
g() { runuser -u "$SVC_USER" -- git --no-optional-locks -C "$WORKSPACE" "$@"; }

NODE_BIN=$(systemctl show -p ExecStart --value "$UNIT" 2>/dev/null | sed -n 's/.*path=\([^ ;]*\).*/\1/p')
[[ -x "${NODE_BIN:-}" ]] || NODE_BIN=$(readlink -f "$(command -v node)")

# Runs a deployed tool as lunex-ai with the service's env file and filesystem sandbox.
sandboxed() {
  systemd-run --quiet --wait --pipe --collect \
    --uid="$SVC_USER" --gid="$SVC_USER" \
    -p EnvironmentFile="$ENV_FILE" -p WorkingDirectory="$WORKSPACE" \
    -p Environment=HOME="$AI_HOME/home" \
    -p ProtectSystem=strict -p ProtectHome=yes -p PrivateTmp=yes -p NoNewPrivileges=yes \
    -p "InaccessiblePaths=-/opt/finance-bot -/opt/guardian -/opt/lunex/production -/opt/lunex/trading -/root" \
    "$NODE_BIN" "$@"
}

# ---------------------------------------------------------------------------------
section "1. service user"
if id "$SVC_USER" >/dev/null 2>&1; then PASS "user $SVC_USER exists"; else FAIL "user $SVC_USER missing"; fi
if [[ "$(id -nG "$SVC_USER" 2>/dev/null)" == "$SVC_USER" ]]; then PASS "$SVC_USER is only in group $SVC_USER"; else FAIL "$SVC_USER groups: $(id -nG "$SVC_USER" 2>/dev/null)"; fi
if [[ "$(getent passwd "$SVC_USER" | cut -d: -f7)" == /usr/sbin/nologin ]]; then PASS "no login shell"; else WARN "login shell: $(getent passwd "$SVC_USER" | cut -d: -f7)"; fi
if sudo -l -U "$SVC_USER" 2>/dev/null | grep -q 'may run'; then FAIL "$SVC_USER has sudo rights"; else PASS "$SVC_USER has no sudo rights"; fi

# ---------------------------------------------------------------------------------
section "2. files and permissions"
expect_mode "$WORKSPACE" "750 $SVC_USER:$SVC_USER"
expect_mode "$AI_HOME" "750 root:$SVC_USER"
expect_mode "$APP_DIR" "750 root:$SVC_USER"
expect_mode "$APP_DIR/dist/main.js" "640 root:$SVC_USER"
expect_mode "$ENV_FILE" "600 $SVC_USER:$SVC_USER"
for key in TELEGRAM_BOT_TOKEN TELEGRAM_ADMIN_ID TOKENROUTER_API_KEY; do
  if grep -Eq "^${key}=[^[:space:]]+" "$ENV_FILE" 2>/dev/null; then PASS "$key is set (value not shown)"; else FAIL "$key is empty or missing"; fi
done
if grep -qx 'LUNEX_AI_MODEL=z-ai/glm-5.3-free' "$ENV_FILE" 2>/dev/null; then PASS "LUNEX_AI_MODEL=z-ai/glm-5.3-free"; else WARN "LUNEX_AI_MODEL is not z-ai/glm-5.3-free"; fi
if grep -qx 'LUNEX_AI_BASE_URL=https://api.tokenrouter.com/v1' "$ENV_FILE" 2>/dev/null; then PASS "LUNEX_AI_BASE_URL=https://api.tokenrouter.com/v1"; else WARN "LUNEX_AI_BASE_URL differs from https://api.tokenrouter.com/v1"; fi
if [[ ! -e "$WORKSPACE/.env" ]]; then PASS "no .env file in the workspace"; else FAIL ".env present in the workspace"; fi
deployed=$(cat "$APP_DIR/DEPLOYED_COMMIT" 2>/dev/null)
branch_head=$(g rev-parse ai/lunex-ai-supervisor 2>/dev/null)
if [[ -n "$deployed" && "$deployed" == "$branch_head" ]]; then PASS "deployed build = ai/lunex-ai-supervisor @ ${deployed:0:12}"; else WARN "deployed ${deployed:-?} vs ai/lunex-ai-supervisor ${branch_head:-?}"; fi

# ---------------------------------------------------------------------------------
section "3. systemd"
if systemctl is-enabled --quiet "$UNIT"; then PASS "unit enabled (starts at boot)"; else FAIL "unit not enabled"; fi
if systemctl is-active --quiet "$UNIT"; then PASS "unit active"; else FAIL "unit not active"; fi
restart_policy=$(systemctl show -p Restart --value "$UNIT")
if [[ "$restart_policy" == always ]]; then PASS "Restart=always"; else FAIL "Restart=$restart_policy"; fi
PID=$(systemctl show -p MainPID --value "$UNIT")
if [[ "${PID:-0}" != 0 ]]; then
  if [[ "$(ps -o user= -p "$PID" | tr -d ' ')" == "$SVC_USER" ]]; then PASS "main process $PID runs as $SVC_USER"; else FAIL "main process user: $(ps -o user= -p "$PID")"; fi
  if grep -q '^NoNewPrivs:[[:space:]]*1' "/proc/$PID/status"; then PASS "NoNewPrivileges in effect"; else FAIL "NoNewPrivileges not in effect"; fi
  cap_eff=$(awk '/^CapEff:/ {print $2}' "/proc/$PID/status")
  if [[ "$cap_eff" =~ ^0+$ ]]; then PASS "no effective capabilities"; else FAIL "CapEff=$cap_eff"; fi
else
  FAIL "no main PID (service not running)"
fi
INFO "systemd-analyze security: $(systemd-analyze security "$UNIT" 2>/dev/null | tail -1)"

# ---------------------------------------------------------------------------------
section "4. filesystem isolation of the running service (its own mount namespace, as $SVC_USER)"
if [[ "${PID:-0}" != 0 ]] && command -v nsenter >/dev/null 2>&1; then
  svc_uid=$(id -u "$SVC_USER"); svc_gid=$(id -g "$SVC_USER")
  in_ns() { nsenter --target "$PID" --mount --setuid "$svc_uid" --setgid "$svc_gid" -- "$@"; }
  for p in "${FORBIDDEN[@]}"; do
    if [[ -e "$p" ]]; then
      if in_ns ls -A "$p" >/dev/null 2>&1; then FAIL "service can list $p"; else PASS "service cannot list $p"; fi
    else
      INFO "$p does not exist on this host"
    fi
  done
  if in_ns test -w "$ENV_FILE"; then FAIL "service can modify its env file"; else PASS "env file is read-only inside the sandbox"; fi
  if in_ns test -w "$APP_DIR/dist/main.js"; then FAIL "service can modify its deployed build"; else PASS "deployed build is read-only inside the sandbox"; fi
  if in_ns test -w "$WORKSPACE/package.json"; then PASS "workspace is writable"; else FAIL "workspace is not writable"; fi
else
  FAIL "cannot inspect the service namespace (service not running or nsenter missing)"
fi
INFO "Unix permissions OUTSIDE the sandbox (defence in depth; never changed by the installer):"
for p in "${FORBIDDEN[@]}"; do
  [[ -e "$p" ]] || continue
  if runuser -u "$SVC_USER" -- test -r "$p"; then
    WARN "  $SVC_USER could read $p if it ran outside systemd ($(stat -c '%a %U:%G' "$p")) -- consider removing 'other' permissions on it yourself"
  else
    PASS "  Unix permissions deny $SVC_USER on $p"
  fi
done

# ---------------------------------------------------------------------------------
section "5. in-code scope guard and command allowlist (deployed build, real config, sandboxed)"
if out=$(sandboxed "$APP_DIR/dist/tools/probeScope.js" 2>&1); then PASS "all scope and command probes behaved as expected"; else FAIL "scope/command probe mismatch"; fi
printf '%s\n' "$out" | indent

# ---------------------------------------------------------------------------------
section "6. git safety"
if [[ -z "$(g remote 2>/dev/null)" ]]; then PASS "workspace has no git remote (nothing can be pushed)"; else FAIL "workspace remotes: $(g remote | tr '\n' ' ')"; fi
INFO "branch=$(g rev-parse --abbrev-ref HEAD 2>/dev/null) head=$(g rev-parse --short HEAD 2>/dev/null) uncommitted=$(g status --porcelain 2>/dev/null | wc -l)"
INFO "ai branches: $(g for-each-ref --format='%(refname:short)' refs/heads/ai 2>/dev/null | tr '\n' ' ')"

# ---------------------------------------------------------------------------------
section "7. secret leak scan (occurrence counts only)"
mapfile -t SECRETS < <(grep -E '^(TELEGRAM_BOT_TOKEN|TOKENROUTER_API_KEY)=' "$ENV_FILE" 2>/dev/null | cut -d= -f2- | awk 'length($0) >= 8')
if (( ${#SECRETS[@]} == 0 )); then
  WARN "no secrets configured yet -- leak scan skipped"
else
  patterns=$(mktemp)
  chmod 0600 "$patterns"
  printf '%s\n' "${SECRETS[@]}" > "$patterns"
  count_lines() { grep -F -c -f "$patterns" 2>/dev/null || true; }
  report() { if [[ "${2:-0}" == 0 ]]; then PASS "$1: 0 occurrences"; else FAIL "$1: $2 line(s) contain a configured secret"; fi; }
  report "journal (lunex-ai)" "$(journalctl -u "$UNIT" --no-pager -o cat 2>/dev/null | count_lines)"
  report ".ai/logs" "$(cat "$WORKSPACE"/.ai/logs/*.jsonl 2>/dev/null | count_lines)"
  report ".ai/state" "$(cat "$STATE"/*.json 2>/dev/null | count_lines)"
  report "git history, all branches" "$(g log --all -p 2>/dev/null | count_lines)"
  report "workspace files" "$(grep -r -F -l -f "$patterns" "$WORKSPACE" --exclude-dir=node_modules --exclude-dir=.git 2>/dev/null | wc -l)"
  report "install logs" "$(cat /var/log/lunex-ai-install-*.log 2>/dev/null | count_lines)"
  rm -f "$patterns"
  unset SECRETS
fi

# ---------------------------------------------------------------------------------
section "8. state and checkpoints"
for f in progress checkpoints; do
  if [[ -s "$STATE/$f.json" ]]; then PASS ".ai/state/$f.json present"; else FAIL ".ai/state/$f.json missing"; fi
done
expect_mode "$STATE" "750 $SVC_USER:$SVC_USER"
if [[ -s "$STATE/checkpoints.json" ]]; then
  INFO "checkpoints: $("$NODE_BIN" -e 'const c=JSON.parse(require("fs").readFileSync(process.argv[1],"utf8"));const l=c[c.length-1]||{};console.log(`${c.length} total; last: ${l.at||"?"} ${l.phase||"?"} -- ${String(l.note||"").slice(0,140)}`)' "$STATE/checkpoints.json")"
fi

# ---------------------------------------------------------------------------------
section "9. live connectivity (sandboxed as $SVC_USER; masked output)"
if out=$(sandboxed "$APP_DIR/dist/tools/checkTelegram.js" 2>&1); then PASS "Telegram Bot API reachable with the configured token, no webhook"; else FAIL "Telegram check failed"; fi
printf '%s\n' "$out" | indent
if out=$(sandboxed "$APP_DIR/dist/tools/checkModel.js" 2>&1); then PASS "TokenRouter answered with the configured model"; else FAIL "TokenRouter / model check failed"; fi
printf '%s\n' "$out" | indent

# ---------------------------------------------------------------------------------
wait_active_new_pid() {
  local old=$1 now
  for _ in $(seq 1 90); do
    now=$(systemctl show -p MainPID --value "$UNIT")
    if systemctl is-active --quiet "$UNIT" && [[ "$now" != 0 && "$now" != "$old" ]]; then echo "$now"; return 0; fi
    sleep 1
  done
  return 1
}
current_task() {
  if [[ -s "$STATE/current_task.json" ]]; then
    "$NODE_BIN" -e 'const t=JSON.parse(require("fs").readFileSync(process.argv[1],"utf8"));console.log(t?`${t.id} ${t.status}`:"none")' "$STATE/current_task.json" 2>/dev/null || echo none
  else
    echo none
  fi
}

if (( RESTART_TEST )); then
  section "10. restart tests"
  old=$(systemctl show -p MainPID --value "$UNIT")
  systemctl restart "$UNIT"
  if new=$(wait_active_new_pid "$old"); then PASS "systemctl restart: active again (pid $old -> $new)"; else FAIL "not active after systemctl restart"; fi
  sleep 5
  if [[ "$(current_task)" == none ]]; then
    restarts_before=$(systemctl show -p NRestarts --value "$UNIT")
    old=$(systemctl show -p MainPID --value "$UNIT")
    systemctl kill --signal=SIGKILL "$UNIT"
    if new=$(wait_active_new_pid "$old"); then PASS "crash (SIGKILL): systemd restarted the service automatically (pid $old -> $new)"; else FAIL "no automatic restart after SIGKILL"; fi
    restarts_after=$(systemctl show -p NRestarts --value "$UNIT")
    if (( restarts_after > restarts_before )); then PASS "NRestarts $restarts_before -> $restarts_after"; else WARN "NRestarts $restarts_before -> $restarts_after"; fi
  else
    WARN "SIGKILL crash test skipped: a task is running ($(current_task)) -- use --recovery-test for that case"
  fi
fi

if (( RECOVERY_TEST )); then
  section "11. crash recovery of a running task"
  task=$(current_task)
  task_id=${task%% *}
  task_status=${task#* }
  if [[ "$task" == none || "$task_status" != running ]]; then
    MANUAL "no task is running. Send one from Telegram, e.g. '/task P4 Add a unit test for an edge case in src/discovery/sanitize.ts',"
    MANUAL "wait until /status shows 'Worker: WORKING', then run: sudo bash $0 --recovery-test"
  else
    since=$(date '+%Y-%m-%d %H:%M:%S')
    old=$(systemctl show -p MainPID --value "$UNIT")
    systemctl kill --signal=SIGKILL "$UNIT"
    if wait_active_new_pid "$old" >/dev/null; then PASS "service back after SIGKILL during task $task_id"; else FAIL "service did not come back"; fi
    found=0
    for _ in $(seq 1 60); do
      if journalctl -u "$UNIT" --since "$since" -o cat --no-pager 2>/dev/null | grep -q "\"event\":\"task_recovered_after_restart\",\"taskId\":\"$task_id\""; then found=1; break; fi
      sleep 1
    done
    if (( found )); then PASS "recovery re-queued interrupted task $task_id"; else FAIL "no task_recovered_after_restart event for $task_id"; fi
    "$NODE_BIN" -e '
      const fs = require("fs"); const [dir, id] = process.argv.slice(1);
      const read = (f) => { try { return JSON.parse(fs.readFileSync(`${dir}/${f}`, "utf8")); } catch { return null; } };
      const completed = (read("completed.json") || []).some((t) => t.id === id);
      const queued = (read("queue.json") || []).some((t) => t.id === id);
      const cur = read("current_task.json");
      process.exit(completed ? 1 : (queued || (cur && cur.id === id)) ? 0 : 2);
    ' "$STATE" "$task_id"
    case $? in
      0) PASS "task $task_id is queued or running again, and NOT marked completed" ;;
      1) FAIL "task $task_id was marked completed" ;;
      *) FAIL "task $task_id is neither queued nor running" ;;
    esac
  fi
fi

# ---------------------------------------------------------------------------------
section "12. Telegram checks (from your phone)"
MANUAL "admin: /start -> help text;  /status -> must contain 'Production: NOT TOUCHED'"
MANUAL "admin: /test -> 'Test run started', then a PASS/FAIL report"
MANUAL "a DIFFERENT Telegram account: /status -> no reply at all; then: journalctl -u lunex-ai | grep -c telegram_unauthorized"
MANUAL "admin: 'Periksa failure handling pada exit transaction. Jangan mengubah trading strategy.' -> queued, 'Strategy changes: not allowed'"
MANUAL "strategy guard: /task P3 Change EXITS.HARD_STOP_LOSS_PCT to -0.07 in src/config/constants.ts -> BLOCKED report (do NOT /approve)"

section "summary"
printf 'PASS=%d FAIL=%d WARN=%d\n' "$pass" "$fail" "$warn"
if (( fail == 0 )); then exit 0; else exit 1; fi
