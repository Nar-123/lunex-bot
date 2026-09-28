# Lunex Bot — Production Deployment (VPS hardening)

**Status: NOT verified against a real VPS.** This document, the systemd
unit, the Caddyfile, and the backup script were all authored in a
development session with **no SSH/network access to the target VPS at
all** — everything here is a proposed, ready-to-review design plus the
exact commands to apply it, not a confirmed deployment. The database
migration section below is the one exception: it *was* actually run, but
against this local development checkout (the only environment this
session had access to), not the VPS. Re-run it there too.

Target assumed (per this project's own prior deployment work for the
separate `lunex-ai` supervisor — confirm these still hold): Ubuntu 24.04,
x86_64, 2 CPU, 3.6 GB RAM, Node.js 22, systemd 255, sharing the host with
`/opt/finance-bot` and `/opt/guardian`. Per that same prior work,
`/opt/lunex/production/` is the reserved path for this bot (the AI
supervisor's own systemd unit already `InaccessiblePaths`-blocks it) —
this document uses `/opt/lunex/production/lunex-bot` throughout;
adjust every path below if the real layout differs.

---

## A. Database migration

**Already run — but only in this local development checkout, not the
VPS.**

```
$ npx prisma migrate status
Error: P1003: Database `lunex.db` does not exist

$ npx prisma migrate deploy
SQLite database lunex.db created at file:./data/lunex.db
13 migrations found in prisma/migrations
Applying migration `20260906150250_add_token_cooldown`
... (13 total, all applied)
All migrations have been successfully applied.

$ npx prisma migrate status
Database schema is up to date!
```

Verified afterward: every table (`TokenCooldown`, `TransactionAttempt`,
`Position`, `ExitState`, `PoolPriceSample`, `BotSettings`) has **0 rows** —
schema only, no fake/seed data inserted, per instruction.

**Run the identical command on the real VPS**, as the `lunex-bot` user,
from `/opt/lunex/production/lunex-bot`, against the real `.env`'s
`DATABASE_URL`:

```bash
sudo -u lunex-bot bash -c 'cd /opt/lunex/production/lunex-bot && npx prisma migrate deploy'
sudo -u lunex-bot bash -c 'cd /opt/lunex/production/lunex-bot && npx prisma migrate status'
```

Expect the same "All migrations have been successfully applied" /
"Database schema is up to date!" output. If `data/lunex.db` already
exists with different history, **stop and investigate before deploying**
— don't let `migrate deploy` run against an unexpected existing database.

---

## B. HTTPS — TLS architecture

**This session cannot confirm whether Nginx, Caddy, or any reverse proxy
already exists on the target VPS.** First command to run there, before
anything else in this section:

```bash
sudo ss -tlnp | grep -E ':80|:443'
systemctl list-units --type=service --state=running | grep -iE 'nginx|caddy|traefik|haproxy'
```

If either shows something already listening on 80/443, **use that
existing proxy** — add a new site/server block pointing at Lunex instead
of installing a second TLS terminator. The steps below assume a clean
host with nothing there yet.

### Design (why this shape)

Confirmed in the Phase 7 audit: Lunex's own `api/server.ts` calls Express's
plain `app.listen()` — it never uses `httpsCertPath`/`httpsKeyPath` despite
those existing in config. **Lunex itself cannot terminate TLS.** The only
safe architecture is: Lunex binds to a private interface only, and a
reverse proxy in front of it holds the real certificate and is the only
thing reachable from the public internet.

```
Internet ──443──▶ Caddy (real cert, auto-renewed) ──127.0.0.1:8443──▶ Lunex (plain HTTP, private only)
```

### Steps (Caddy — recommended for a single-app host, no nginx present)

1. **Change Lunex's own bind address** — in the real `.env` on the VPS:
   ```
   API_HOST=127.0.0.1
   ```
   (currently `0.0.0.0` — this is a one-line `.env` edit, not a code
   change; not applied to this local `.env` since this session isn't the
   deployed instance).

2. **Install Caddy:**
   ```bash
   sudo apt-get update
   sudo apt-get install -y debian-keyring debian-archive-keyring apt-transport-https curl
   curl -1sLf 'https://dl.cloudsmith.io/public/caddy/stable/gpg.key' | sudo gpg --dearmor -o /usr/share/keyrings/caddy-stable-archive-keyring.gpg
   curl -1sLf 'https://dl.cloudsmith.io/public/caddy/stable/debian.deb.txt' | sudo tee /etc/apt/sources.list.d/caddy-stable.list
   sudo apt-get update
   sudo apt-get install -y caddy
   ```

3. **Deploy the config** — copy `ops/lunex-bot/Caddyfile` to
   `/etc/caddy/Caddyfile`, replacing `lunex.example.com` with the real
   hostname (needs real DNS pointed at this VPS for automatic Let's
   Encrypt; use `tls internal` in the file instead if this stays
   admin-only behind a VPN with no public DNS):
   ```bash
   sudo cp /opt/lunex/production/lunex-bot/ops/lunex-bot/Caddyfile /etc/caddy/Caddyfile
   sudo systemctl reload caddy
   ```

4. **Firewall — only 443 (and SSH) exposed, never 8443:**
   ```bash
   sudo ufw allow 443/tcp
   sudo ufw allow OpenSSH
   sudo ufw deny 8443/tcp   # explicit: Lunex's own port must never be reachable directly
   ```

5. **Verify** (per this repo's own health-check flow — see Phase 7's
   report for the two-step login/status commands), now over `https://`
   instead of a raw `http://<host>:8443`.

### Alternative — nginx (if one already exists on the host)

Add a new `server` block in `/etc/nginx/sites-available/lunex-bot`
reverse-proxying to `127.0.0.1:8443`, with `proxy_set_header
Authorization $http_authorization;` (nginx does not forward this header
by default), obtain a cert via `certbot --nginx`, symlink into
`sites-enabled`, `nginx -t && systemctl reload nginx`. Not written out in
full here since this session could not confirm nginx is actually the
right target — ask the operator to confirm before spending effort on this
path.

---

## C. Permissions

**Dedicated non-root user:**
```bash
sudo useradd --system --home-dir /opt/lunex/production/lunex-bot --shell /usr/sbin/nologin lunex-bot
sudo mkdir -p /opt/lunex/production/lunex-bot/{data,logs}
sudo chown -R lunex-bot:lunex-bot /opt/lunex/production/lunex-bot
```

**`.env` — owner-only, never group/world-readable:**
```bash
sudo chmod 600 /opt/lunex/production/lunex-bot/.env
sudo chown lunex-bot:lunex-bot /opt/lunex/production/lunex-bot/.env
```
(Currently `644` in this local dev checkout — fine for a single-user dev
machine, **must** be `600` on the shared VPS. Not changed here since this
isn't the deployed instance.)

**Database + logs — writable only by `lunex-bot`:**
```bash
sudo chmod 750 /opt/lunex/production/lunex-bot/data /opt/lunex/production/lunex-bot/logs
sudo chown -R lunex-bot:lunex-bot /opt/lunex/production/lunex-bot/data /opt/lunex/production/lunex-bot/logs
```

**Verify no other user on the shared host can read any of it:**
```bash
sudo -u finance-bot cat /opt/lunex/production/lunex-bot/.env    # must fail: Permission denied
sudo -u guardian cat /opt/lunex/production/lunex-bot/.env       # must fail: Permission denied
```
(Substitute the real usernames those services run as, if different.)

---

## D. systemd

Unit file: `ops/lunex-bot/systemd/lunex-bot.service` (in this repo,
copied alongside `ops/lunex-ai/systemd/lunex-ai.service`'s proven
hardening pattern — `NoNewPrivileges`, `ProtectSystem=strict`,
`InaccessiblePaths` blocking every other service on the host, etc.).

Key choices, and why:
- **`Restart=on-failure`** (not `always`) — a clean, intentional exit must
  never be auto-restarted out from under an operator who meant to stop it.
- **`TimeoutStopSec=630`** — `src/index.ts`'s own `SIGTERM` handler
  deliberately refuses to force-exit while a critical transaction write
  may still be in flight, waiting up to `config.composition.shutdownTimeoutMs`
  (10 minutes / 600s default) before giving up on waiting — systemd's own
  stop timeout must stay comfortably above that or it will `SIGKILL`
  mid-write, exactly what graceful shutdown exists to prevent.
- **No `Nice`/`CPUQuota` throttling** (unlike `lunex-ai.service`) — this
  is the production trading tenant on the host, not a background dev
  tool; only a `MemoryMax` ceiling as a leak safety net.

**Install (do NOT start yet — per instruction):**
```bash
sudo cp /opt/lunex/production/lunex-bot/ops/lunex-bot/systemd/lunex-bot.service /etc/systemd/system/lunex-bot.service
sudo systemctl daemon-reload
# NOT run yet: sudo systemctl enable --now lunex-bot
```

**When explicitly ready to start** (not part of this phase):
```bash
sudo systemctl enable --now lunex-bot
sudo systemctl status lunex-bot
journalctl -u lunex-bot -f
```

**Controlled shutdown, once running:**
```bash
sudo systemctl stop lunex-bot   # sends SIGTERM, same graceful path as Ctrl+C
```

---

## E. RPC fallback — design only, NOT implemented

**Current state** (confirmed by reading the code, re-verified this
session): `src/blockchain/viemClient.ts` builds its client as
`transport: http(config.chain.rpcUrl)` — a single explicit URL. `RPC_FALLBACK_URLS`
is parsed into `config.chain.rpcFallbackUrls` and even appended into the
viem `Chain` object's `rpcUrls.default.http` array
(`src/blockchain/viemChain.ts:18`) — but that array is only consulted
when `http()` is called with **no** argument; since the real code always
passes `config.chain.rpcUrl` explicitly, the fallback list is inert. An
Alchemy outage today means every RPC call fails until the operator
manually edits `RPC_URL`.

**Smallest safe fix** (proposed, not applied):

```ts
// src/blockchain/viemClient.ts
import { createPublicClient, fallback, http, type PublicClient } from 'viem';
import { config } from '../config';
import { robinhoodChain } from './viemChain';

let cachedClient: PublicClient | undefined;

export function getPublicClient(): PublicClient {
  if (!cachedClient) {
    const urls = [config.chain.rpcUrl, ...config.chain.rpcFallbackUrls];
    cachedClient = createPublicClient({
      chain: robinhoodChain,
      transport: fallback(
        urls.map((url) => http(url)),
        { rank: false }, // try in listed order (Alchemy first) -- not health-ranked
      ),
    });
  }
  return cachedClient;
}
```

One import, one transport construction change, zero other call sites
touched — every existing caller of `getPublicClient()` keeps the exact
same `PublicClient` interface. `rank: false` means "try each URL in the
order given, move to the next only on failure" (matches the mental model
of "Alchemy primary, `robinhood-rpc.publicnode.com` as backup" already
implied by the env var names); `rank: true` would instead periodically
health-check and reorder by latency, which adds behavior worth deciding
on deliberately rather than defaulting into.

**Caution worth naming before implementing:** a fallback masks
*connectivity* failures (timeouts, connection refused) well — that's
exactly the class of failure Phase 7 observed against the official RPC.
It does **not** protect against a fallback endpoint that responds but with
subtly stale or wrong state (e.g. a lagging public node). This codebase's
existing binding self-checks (`checkStateViewBinding`,
`checkPositionManagerBinding`) would catch a *structurally* wrong
response but not a merely-stale one. Worth a conscious decision, not
necessarily a blocker.

**Not implemented in this phase**, per instruction ("do NOT implement
unless needed; first report the design"). If the operator wants this
applied: say so explicitly, and it's a two-line diff to
`src/blockchain/viemClient.ts` plus the existing test suite
(`tests/pools/poolStateProvider.test.ts` and friends already exercise
`getPublicClient()`'s consumers) would need to keep passing.

---

## F. Backup / restore

Script: `ops/lunex-bot/backup-db.sh` (syntax-checked with `bash -n`, not
yet run against a real deployed database — none exists in production
yet). Uses SQLite's own online backup API (`sqlite3 <db> ".backup
<dest>"`), not a raw file copy — safe to run against a live, writing
database without risking a torn/corrupt snapshot. Verifies the resulting
file with `PRAGMA integrity_check` before trusting it, and prunes backups
older than the most recent 30.

**Set up as a daily cron job (as the `lunex-bot` user):**
```bash
sudo -u lunex-bot crontab -e
# add:
0 3 * * * /opt/lunex/production/lunex-bot/ops/lunex-bot/backup-db.sh /opt/lunex/production/lunex-bot/data/lunex.db /opt/lunex/production/lunex-bot/data/backups >> /opt/lunex/production/lunex-bot/logs/backup.log 2>&1
```

**Restore procedure** (destructive — NOT run in this phase, documented
only):
```bash
# 1. Stop the service first -- never restore into a live database.
sudo systemctl stop lunex-bot

# 2. Move the current (possibly corrupt/unwanted) db aside, don't delete it yet.
sudo -u lunex-bot mv /opt/lunex/production/lunex-bot/data/lunex.db \
  /opt/lunex/production/lunex-bot/data/lunex.db.pre-restore-$(date -u +%Y%m%dT%H%M%SZ)

# 3. Copy the chosen backup into place.
sudo -u lunex-bot cp /opt/lunex/production/lunex-bot/data/backups/lunex-<TIMESTAMP>.db \
  /opt/lunex/production/lunex-bot/data/lunex.db

# 4. Verify integrity BEFORE restarting the service.
sqlite3 /opt/lunex/production/lunex-bot/data/lunex.db "PRAGMA integrity_check;"
# must print exactly: ok

# 5. Confirm migration state matches what the deployed code expects.
sudo -u lunex-bot bash -c 'cd /opt/lunex/production/lunex-bot && npx prisma migrate status'

# 6. Only then restart.
sudo systemctl start lunex-bot
```

A restored database is, by definition, missing any position/transaction
state written after the backup was taken — a stale restore while real
positions are open is a real-money risk. If any position could have been
ACTIVE/OPENING/CLOSING at the backup timestamp, reconcile against the
real Robinhood Chain PositionManager NFTs (`reconciliation/`'s existing
orphan-scan logic) before resuming normal cycles, not just trust the
restored rows blindly.

---

## Remaining blockers before first `npm start` / `systemctl start lunex-bot`

1. **This entire document is unverified against the real VPS** — every
   command above needs to actually be run there, in order, with results
   checked at each step, not assumed from this local dry-run.
2. `API_HOST` must be changed to `127.0.0.1` in the **real** VPS `.env`
   before the reverse proxy is meaningful (§B step 1) — not yet done
   anywhere, including this local `.env`.
3. TLS proxy (§B) not installed anywhere yet.
4. systemd unit (§D) not installed, not enabled, not started anywhere yet.
5. RPC fallback (§E) is a reported design only — still not implemented.
6. Backup cron (§F) not scheduled anywhere yet.
7. **`ASSET_TYPE` remains exactly Draft V1 — fail-closed, no positive
   Meme/Project source exists.** Even once every item above is resolved
   and the service is running, no new entry can currently pass screening.
   This is the correct, deliberate state, not something this document
   changes or works around.

No transaction was signed or broadcast. No entry or exit was executed.
`npm start` / `systemctl start` was not run.
