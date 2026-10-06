# Target-host deployment (43.159.56.24)

Replaces `ops/lunex-bot/deployD.sh` **for the target host only**. deployD.sh is
kept unchanged as the record of how D1–D12 were deployed on the old host; it does
not exist on the target and cannot run there.

## What the target looks like (audited 2026-10-03)

| | |
|---|---|
| Service | `lunex-bot.service` in `/etc/systemd/system`, `User=lunex-bot`, `ExecStart=/usr/bin/node /opt/lunex/production/lunex-bot/dist/index.js`, `WorkingDirectory` = the production tree, `EnvironmentFile=…/.env`, `ProtectSystem=strict`, `ReadWritePaths=data logs`, `PrivateTmp=true`, UnitFileState **disabled** (deliberate) |
| Artifact | one in-place tree `/opt/lunex/production/lunex-bot` (0750, owned by `lunex-bot`), `RELEASE_SHA` marker |
| Rollback copies / DB backup cron | none on the target |
| Operator account | `lunex-admin`: passwordless sudo only for rsync, mkdir, chown, chmod, install, systemctl, journalctl, apt-get, sqlite3, timedatectl, useradd, groupadd |

### Why not root-owned releases + an atomic symlink switch

`ExecStart`, `WorkingDirectory`, `ReadWritePaths`/`ReadOnlyPaths`, the logger
(`cwd/logs`) and the `.env` path all hard-code the production tree. A switch would
mean changing the unit and moving `data/`, `logs/` and `.env` out of the tree. The
current tree is kept, with the race-safe defence below.

## Two releases

* **Application release** — the commit to deploy (`--expected-release-sha`).
* **Tool release** — the commit carrying `src/deploy/` and this directory, staged
  with the same `prepare-release.sh`. The CLI refuses to run from anywhere but
  `/opt/lunex/releases/<its own RELEASE_SHA>`; the identity probe instance and the
  start-lock source come from that same sealed build.

## Commands

| command | effect on the host |
|---|---|
| `plan` | **none.** Every command passes through a read-only guard (systemctl show, rsync --list-only, sqlite3 -readonly SELECT/PRAGMA \*_check, journalctl); the ports have no filesystem write method; no session dir, no log file. It does not run the identity probe — it reports `IDENTITY_NOT_PROBED` and checks the *expected* executor on chain. |
| `verify-identity` | starts/stops the one-shot identity probe; nothing else |
| `execute --confirm-release <sha>` | the deployment |
| `rollback --confirm-rollback <prev sha>` | code-only rollback from a validated snapshot |

## execute

```
identity probe        lunex-deploy-identity@<TOOL>.service as lunex-bot, PrivateNetwork: executor + chainId from the PRODUCTION config
read-only gates       chain id · release manifest + seal · release layout · previous release · DB · schema · service running · prod layout · executor nonce #1 · retired-wallet tripwire (warn)
start-lock            /run/systemd/system/lunex-bot.service.d/50-lunex-deploy-lock.conf (AssertPathExists on a path that never exists)
stop                  then journal cursor
post-stop             quiescent · layout · DB · schema · nonce #2
snapshot              /opt/lunex/rollback/<prev>-<UTC> (0700 root): DB copy (journal/WAL refused, byte-compared, integrity_check) + every replaced item, byte-compared
pre-replace           quiescent · layout · DB unchanged · release manifest + seal re-verified · nonce #3
replace               rsync -a --delete --chown=lunex-bot:lunex-bot -- <release>/<item> <prod>/      (per manifest item)
post-replace          quiescent (was anything started while writing?) · release re-verified · deployed bytes == release · RELEASE_SHA · .env unchanged · layout · nonce #4
unlock + start        the ONLY path that releases the lock
health                see below
```

A failed gate ends the run; nothing falls back. **Every failure before start
leaves the service stopped AND start-locked.** A failure after start stops the
service and re-locks it.

## H-1: symlink safety

The production tree belongs to the service account, so root must never follow
anything it could plant:

1. **Copies never write through a symlink.** Items are copied as
   `rsync … -- <srcRoot>/<item> <dstRoot>/` — no trailing slash on the item — so
   the transfer root is the destination directory itself, and rsync (without
   `--keep-dirlinks`) *replaces* a symlink found anywhere below it. Verified on
   Linux for a top-level directory symlink, a nested directory symlink, a file
   symlink and an `ops` symlink: each was replaced and its target untouched.
2. **No `chown` binary.** Ownership is set on the receiving side by
   `rsync --chown`; `chown` (which dereferences a symlink argument) is never run.
3. **Nobody can race a swap.** Before the first write the service is stopped and
   start-locked, `/proc` holds no process of the service account, and the journal
   shows no activity since the stop — re-checked before and after the writes.
4. **Layout gate.** The production root must be a real directory, its ancestors
   root-owned and not group/other-writable, and every top-level entry a plain
   file or directory of the same type as in the release. Any symlink fails.

## M-2: the start lock

A runtime `systemctl mask` does **not** work here: the unit file lives in
`/etc/systemd/system`, which outranks `/run`, so the mask is ignored (verified:
start succeeded while "masked"). Drop-ins from every directory are merged, so a
runtime drop-in with `AssertPathExists=/nonexistent/…` makes every start fail
(verified: "Assertion failed on job"). It is installed with `install` and
neutralised by installing `/dev/null` over it (the whitelist has no `rm`); it
disappears on reboot. A journal cursor taken right after stop detects any start
attempt, even one that was stopped again.

## M-6: health

Decided by structural signals, evidenced on the production host:

* active/running, NRestarts 0, MainPID and InvocationID unchanged over the window (90 s);
* startup markers of this invocation: `startup`, `api_server_started`, and
  `telegram_bot_started` or `telegram_disabled` (`telegram_bot_start_failed` fails);
* no `[lunex-bot] fatal startup error`, no signing/broadcast line, still `paused=1`.

Error-level events do not fail health. The only one proven benign is
`screening_cycle_error` from the absent gmgn-cli (the only error event in the
current production run). Any other error event makes the result
**NEEDS_VERIFICATION** (exit code 4): deployed, but not to be resumed until checked.
There is no unauthenticated health endpoint (`/status` is behind the admin JWT).

## Preparing a release (two stages)

The integration test suite runs `prisma migrate deploy` against
`<project>/data/test-*.db` and removes only the database files, so every test run
leaves an empty `data/` behind. When the suite ran inside the release directory,
that `data/` was sealed into the release (found 2026-10-06 in fb4d330 and 5f26f40;
both releases are **STALE** and must not be deployed). `prepare-release.sh` now:

* **Stage A — validate** in a private `mktemp` workspace: unpack + blob check,
  `npm ci`, Prisma 7.10.0 gate, `npm run test / typecheck / lint / build`. Every
  test byproduct stays in the workspace (removed on success, kept on failure).
* **Stage B — release**: unpack the pristine archive again into
  `/opt/lunex/releases/<sha>`, its own `npm ci` + `npm run build` (HOME in the
  workspace, never a test run), and require the release build to be byte-identical
  to the validated build.
* `check-release-layout.sh` before and after the seal: the tree may hold only the
  archive's files and directories, `dist/`, `ui/dist/`, `node_modules/`,
  `RELEASE_SHA` and `.lunex-release/`. Forbidden names (`data`, `logs`, `.env`,
  `.env.*` except the tracked `.env.example`, `.home`, caches, `coverage`, `tmp`,
  `rollback`, `*.db*`, `*.log`, …), top-level symlinks and anything untracked fail.

## Release layout gate (deploy tool)

Independently of the manifest, the tool lists the release directory's actual top
level (lstat) and applies the same forbidden-name rules (`RELEASE_LAYOUT_INVALID`).
It runs in `plan`, and in `execute` before the start lock and the stop, and again at
pre-replace and post-replace. The copy primitive also refuses those names.

## Release integrity (L-1 / L-2)

`prepare-release.sh` seals the release (root:root, `go-w,ug-s`), then writes
`.lunex-release/release-manifest.v2` describing **every** entry except the
`.lunex-release/` metadata itself (path, type, mode, sha256 or link target),
installs it 0444 root, and prints `EXPECTED_MANIFEST_SHA256`. The operator passes
that value; the tool re-walks the release with lstat and requires byte equality
plus the seal on every entry, at pre-stop, pre-replace and post-replace.

## M-4: schema

The release's `prisma/migrations/*/migration.sql` (name + sha256) must equal the
finished, not-rolled-back rows of `_prisma_migrations`. A release needing a
migration, a database ahead of the release, or an edited migration is blocked.
This tool never migrates. For fb4d330: 23/23 identical to production.

## Rollback

`rollback --rollback-dir /opt/lunex/rollback/<prev>-<UTC> --expected-previous-sha <prev> --confirm-rollback <prev>`
validates **before any write**: directory name pattern, name SHA == expected
previous, rollback root root-owned 0700, snapshot and `app/` real directories,
the snapshot's own `RELEASE_SHA` == expected previous, no symlinked or protected
items. Then lock → stop → quiescent + layout → restore (byte-verified) → previous
RELEASE_SHA → unlock → start → health. **Code only**: the snapshot DB is kept and
never restored automatically.

## One-time host setup (operator, not automated)

1. `sudo install -m 0644 ops/deploy/lunex-deploy-identity@.service /etc/systemd/system/ && sudo systemctl daemon-reload`
2. Stage the tool release and the application release with `prepare-release.sh`.

Nothing here changes the production `.env`, the database, or `lunex-bot.service`.
