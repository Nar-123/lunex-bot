#!/usr/bin/env bash
# Lunex AI supervisor -- READ-ONLY VPS discovery.
#
# Changes nothing. Prints metadata only: OS facts, tool versions, directory
# existence/owner/mode, service names and states, process owner+name counts,
# and HTTP status codes. It never lists or reads the contents of other projects
# (/opt/finance-bot, /opt/guardian, /opt/lunex/production), and never prints
# environment variables, process command lines, or file contents.
#
# Usage: sudo bash 00-discovery.sh      (also runs without sudo, with fewer facts)
set -uo pipefail
export LC_ALL=C

section() { printf '\n===== %s =====\n' "$1"; }
meta() {
  if [[ -e "$1" || -L "$1" ]]; then stat -c '%A %a %U:%G %n' -- "$1"; else printf 'absent %s\n' "$1"; fi
}

section "host"
if [[ -r /etc/os-release ]]; then . /etc/os-release; echo "os: ${PRETTY_NAME:-unknown}"; fi
echo "arch: $(uname -m)  kernel: $(uname -r)  cpus: $(nproc)"
free -m | awk 'NR==1 || /^Mem:/ || /^Swap:/'
df -hP / /opt 2>/dev/null | awk '!seen[$0]++'
echo "uptime: $(uptime -p 2>/dev/null || uptime)"

section "current user"
id
if [[ $EUID -eq 0 ]]; then
  echo "running as root"
elif sudo -n true 2>/dev/null; then
  echo "sudo: passwordless available"
else
  echo "sudo: NOT passwordless -- system-level install steps need an operator with sudo"
fi

section "tools"
for t in node npm npx git systemctl systemd-run systemd-analyze runuser nsenter useradd install curl jq python3 make g++; do
  if p=$(command -v "$t" 2>/dev/null); then printf '%-16s %s\n' "$t" "$p"; else printf '%-16s MISSING\n' "$t"; fi
done
if command -v node >/dev/null 2>&1; then
  node_real=$(readlink -f "$(command -v node)")
  echo "node: $(node -v)  realpath: $node_real"
  case "$node_real" in
    /root/*|/home/*) echo "WARNING: node lives under /root or /home -- invisible to the sandboxed service; a system-wide Node.js is required" ;;
  esac
fi
command -v npm >/dev/null 2>&1 && echo "npm: $(npm -v 2>/dev/null)"
git --version 2>/dev/null
systemctl --version 2>/dev/null | head -1
nsenter --version 2>/dev/null | head -1
for pkg in build-essential python3; do
  if dpkg -s "$pkg" >/dev/null 2>&1; then echo "package $pkg: installed"; else echo "package $pkg: not installed"; fi
done

section "/opt top level (name, mode, owner only)"
for d in /opt/*; do meta "$d"; done

section "Lunex layout"
for d in /opt/lunex /opt/lunex/workspace /opt/lunex/workspace/lunex /opt/lunex/ai /opt/lunex/ai/lunex-ai /opt/lunex/ai/lunex-ai.env /opt/lunex/ai/home /opt/lunex/production /opt/lunex/trading /etc/systemd/system/lunex-ai.service; do
  meta "$d"
done
if [[ -d /opt/lunex/workspace/lunex/.git ]]; then
  g() { git --no-optional-locks -c safe.directory='*' -C /opt/lunex/workspace/lunex "$@"; }
  echo "workspace branch: $(g rev-parse --abbrev-ref HEAD 2>/dev/null)  head: $(g rev-parse HEAD 2>/dev/null)"
  echo "workspace uncommitted paths: $(g status --porcelain 2>/dev/null | wc -l)"
  echo "workspace remotes: $(g remote 2>/dev/null | tr '\n' ' ')"
  echo "workspace ai/* branches: $(g for-each-ref --format='%(refname:short)' refs/heads/ai 2>/dev/null | tr '\n' ' ')"
fi

section "other projects (metadata only -- never listed or read)"
for d in /opt/finance-bot /opt/guardian /opt/lunex/production; do
  meta "$d"
  if [[ -d "$d" ]]; then
    others=$(( 8#$(stat -c '%a' "$d") % 8 ))
    if (( others == 0 )); then
      echo "  others: no access"
    else
      echo "  NOTE: 'other' users have access bits on $d -- the systemd sandbox and code guard will still block lunex-ai; not changed by the installer"
    fi
  fi
done

section "users"
getent passwd lunex-ai || echo "user lunex-ai: absent"
getent group lunex-ai || echo "group lunex-ai: absent"

section "systemd services (name, state; owner and working directory for project-like units)"
systemctl list-units --type=service --all --no-pager --no-legend --plain 2>/dev/null \
  | awk '{print $1, $3, $4}' | grep -Ei 'lunex|finance|guardian|bot|telegram|node|pm2' || echo "(no matching services)"
while read -r unit; do
  [[ -n "$unit" ]] || continue
  printf '%s user=%s workdir=%s enabled=%s\n' "$unit" "$(systemctl show -p User --value "$unit")" "$(systemctl show -p WorkingDirectory --value "$unit")" "$(systemctl is-enabled "$unit" 2>/dev/null)"
done < <(systemctl list-units --type=service --all --no-pager --no-legend --plain 2>/dev/null | awk '{print $1}' | grep -Ei 'lunex|finance|guardian')

section "node processes (owner + name counts only; no command lines)"
ps -eo user=,comm= | awk '$2 ~ /^(node|npm|pm2)/ {print $1, $2}' | sort | uniq -c || true
command -v pm2 >/dev/null 2>&1 && echo "pm2: installed" || echo "pm2: not installed"
command -v docker >/dev/null 2>&1 && echo "docker: installed" || echo "docker: not installed"

section "egress (HTTP status only; no credentials sent)"
for url in https://api.telegram.org/ https://api.tokenrouter.com/v1/models https://registry.npmjs.org/ https://github.com/; do
  printf '%-42s %s\n' "$url" "$(curl -sS -m 15 -o /dev/null -w '%{http_code}' "$url" 2>&1)"
done

section "memory (top 6 processes by RSS: user, MB, name)"
ps -eo user=,rss=,comm= --sort=-rss | head -6 | awk '{printf "%-12s %6d MB  %s\n", $1, $2/1024, $3}'

section "done -- no changes were made"
