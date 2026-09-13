# Lunex AI Supervisor — Deployment VPS

Dokumen ini menjelaskan cara memasang **Lunex AI Supervisor** (`ops/lunex-ai/`) di VPS sebagai
service `lunex-ai.service`, dikendalikan lewat **satu** Telegram bot.

> **Status verifikasi (jujur):** kode, 243 unit/integration test, typecheck, lint, dan build
> supervisor sudah lulus di mesin development. Yang **BELUM** diverifikasi: berjalan di VPS
> sungguhan, systemd unit di Linux sungguhan, koneksi Telegram sungguhan, dan panggilan
> TokenRouter sungguhan. Model ID `z-ai/glm-5.3-free` **UNVERIFIED** — tidak tercantum di
> dokumentasi publik TokenRouter; cek di dashboard TokenRouter Anda (lihat §8).

---

## 0. Apa yang dilakukan supervisor — dan apa yang tidak

**Dilakukan:** menerima task dari Telegram (command atau bahasa natural), menjalankan loop
*inspect → plan → implement → test → debug → verify → checkpoint → report* memakai GLM via
TokenRouter, memverifikasi sendiri (typecheck, lint, seluruh test, build), commit ke branch
`ai/<topik>-<id>`, fast-forward ke `ai/develop`, lalu mengirim laporan ke Telegram.

**Tidak pernah dilakukan (dipaksakan di kode + systemd, bukan hanya prompt):**

| Larangan | Mekanisme |
|---|---|
| Menyentuh `/opt/lunex/production`, `/opt/lunex/trading`, `/root`, repo/bot lain | `ScopeGuard` (realpath, anti-symlink/`..`) **dan** systemd `InaccessiblePaths` + `ProtectSystem=strict` |
| Membaca `.env`, `*.pem`, `*.key`, `lunex-ai.env` | `ScopeGuard` menolak nama file tersebut untuk agent **dan** supervisor |
| Menjalankan `node`, `npm start`, `validate-live`, install paket, shell | `commandPolicy` allowlist (hanya `git`, `npm run <script aman>`, `npx vitest/tsc/eslint/prisma generate`), tanpa shell |
| `git push`, `reset`, `clean`, `rebase`, force, hapus branch, ubah config | `commandPolicy` |
| Menulis ke `ops/lunex-ai/` (guardrail-nya sendiri), `.git`, `.ai`, `.github` | `ScopeGuard` write protection + pengecekan saat commit |
| Commit secret | scan baris yang ditambahkan sebelum commit → BLOCKED + worker pause |
| Mengubah strategi trading tanpa izin eksplisit | strategy guard: perubahan pada file sensitif hanya di-commit di branch task, **tidak di-merge**, dilaporkan BLOCKED sampai `/approve <taskId>` |
| Membocorkan token/key ke child process, log, Telegram, atau model | env child di-allowlist; semua output di-mask |
| Signing transaksi / trading / deploy | tidak ada kode untuk itu; `node` dan script live diblokir |

Tidak ada yang otomatis masuk ke `main` atau remote. Merge ke `main` selalu manual oleh Anda.

---

## 1. Prasyarat VPS

- Linux dengan systemd (Ubuntu 22.04/24.04 atau Debian 12 direkomendasikan).
- Node.js **≥ 20** di `/usr/bin/node` (cek: `command -v node && node -v`). Jika path berbeda,
  sesuaikan `ExecStart` di unit file.
- `git`, `build-essential`, `python3` (dibutuhkan `better-sqlite3` saat `npm ci` di workspace Lunex).
- Akses root/sudo untuk langkah instalasi.

```bash
sudo apt-get update && sudo apt-get install -y git build-essential python3 rsync jq
```

---

## 2. Unix user `lunex-ai`

User sistem khusus, tanpa shell login, tanpa sudo, **tidak** menjadi anggota grup user/bot produksi.

```bash
sudo useradd --system --create-home --home-dir /opt/lunex/ai/home --shell /usr/sbin/nologin lunex-ai
id lunex-ai
```

Pastikan `id lunex-ai` **tidak** menampilkan grup yang dipakai bot produksi/trading.

---

## 3. Direktori dan permission

Layout akhir:

```
/opt/lunex/workspace/lunex/        # repo Lunex (milik lunex-ai) — satu-satunya yang boleh diubah AI
/opt/lunex/workspace/lunex/.ai/    # state/log/report runtime (gitignored)
/opt/lunex/ai/                     # root:lunex-ai 0750
/opt/lunex/ai/app/dist/            # salinan build supervisor (root-owned, read-only bagi service)
/opt/lunex/ai/home/                # HOME service (cache npm)
/opt/lunex/ai/lunex-ai.env         # secret (root:lunex-ai 0640)
/opt/lunex/production/             # TIDAK dapat diakses lunex-ai
/opt/lunex/trading/                # TIDAK dapat diakses lunex-ai
```

```bash
# AI home
sudo mkdir -p /opt/lunex/ai/app /opt/lunex/ai/home /opt/lunex/workspace
sudo chown root:lunex-ai /opt/lunex/ai && sudo chmod 0750 /opt/lunex/ai
sudo chown -R lunex-ai:lunex-ai /opt/lunex/ai/home && sudo chmod 0700 /opt/lunex/ai/home

# Workspace Lunex (clone repo development — BUKAN direktori produksi)
sudo git clone <URL-REPO-LUNEX> /opt/lunex/workspace/lunex
sudo chown -R lunex-ai:lunex-ai /opt/lunex/workspace/lunex
sudo chmod 0750 /opt/lunex/workspace/lunex

# Produksi/trading: pastikan lunex-ai tidak bisa masuk (sesuaikan owner dengan user bot produksi)
sudo chmod 0750 /opt/lunex/production /opt/lunex/trading 2>/dev/null || true
sudo -u lunex-ai ls /opt/lunex/production   # HARUS: Permission denied (atau No such file)
```

Identitas git untuk commit AI, dan **tanpa kredensial push** (supervisor tidak pernah push; jangan beri
SSH key/token git ke user `lunex-ai`):

```bash
cd /opt/lunex/workspace/lunex
sudo -u lunex-ai git config user.name  "Lunex AI"
sudo -u lunex-ai git config user.email "lunex-ai@localhost"
sudo -u lunex-ai git checkout <branch-dasar>     # mis. ai/fix-exit-proceeds-resumable atau main
```

Instal dependency dan pastikan baseline hijau **sebelum** menyalakan AI. Workspace development tidak
butuh `.env` — test Lunex memakai fixture palsu dari `tests/setup.ts`. **Jangan pernah menyalin `.env`
produksi ke workspace.**

```bash
sudo -u lunex-ai env HOME=/opt/lunex/ai/home bash -c 'cd /opt/lunex/workspace/lunex && npm ci && npm run typecheck && npm run lint && npm test && npm run build'
```

---

## 4. Build dan pasang supervisor

Supervisor tidak punya dependency npm runtime (hanya modul bawaan Node: `fetch`, `child_process`, `fs`).
Service menjalankan **salinan** build di `/opt/lunex/ai/app`, bukan kode di workspace — sehingga
perubahan apa pun di `ops/lunex-ai/` tidak berlaku tanpa redeploy manual oleh Anda.

```bash
cd /opt/lunex/workspace/lunex
sudo -u lunex-ai env HOME=/opt/lunex/ai/home npm run ai:typecheck
sudo -u lunex-ai env HOME=/opt/lunex/ai/home npm run ai:lint
sudo -u lunex-ai env HOME=/opt/lunex/ai/home npm run ai:test
sudo -u lunex-ai env HOME=/opt/lunex/ai/home npm run ai:build

sudo rsync -a --delete ops/lunex-ai/dist/ /opt/lunex/ai/app/dist/
sudo chown -R root:lunex-ai /opt/lunex/ai/app
sudo chmod -R u=rwX,g=rX,o= /opt/lunex/ai/app
```

---

## 5. Environment variables

```bash
sudo install -o root -g lunex-ai -m 0640 ops/lunex-ai/lunex-ai.env.example /opt/lunex/ai/lunex-ai.env
sudoedit /opt/lunex/ai/lunex-ai.env
```

Isi nilai secret **langsung di editor** (jangan `echo` ke shell — masuk history). Supervisor sendiri tidak
pernah membaca file ini; systemd yang menyuntikkannya ke environment proses.

| Variabel | Wajib | Default | Keterangan |
|---|---|---|---|
| `TELEGRAM_BOT_TOKEN` | ya | — | Token bot **kontrol AI** (§6). Harus bot yang berbeda dari bot trading Lunex. |
| `TELEGRAM_ADMIN_ID` | ya | — | ID numerik Telegram admin, pisahkan koma bila lebih dari satu. |
| `TOKENROUTER_API_KEY` | ya | — | API key TokenRouter (§7). |
| `TOKENROUTER_BASE_URL` | tidak | `https://api.tokenrouter.io/v1` | Harus `https://`. |
| `LUNEX_AI_MODEL` | tidak | `z-ai/glm-5.3-free` | Tidak pernah diganti otomatis (§8). |
| `LUNEX_AI_WORKSPACE` | tidak | `/opt/lunex/workspace/lunex` | Harus repo git; ditolak jika overlap path terlarang. |
| `LUNEX_AI_HOME` | tidak | `/opt/lunex/ai` | |
| `LUNEX_AI_EXTRA_DENIED_PATHS` | tidak | — | Path terlarang tambahan (koma). `production`, `trading`, `/root` selalu terlarang. |
| `LUNEX_AI_INTEGRATION_BRANCH` | tidak | `ai/develop` | Harus diawali `ai/`. Tidak pernah di-push. |
| `LUNEX_AI_MAX_AGENT_STEPS` | tidak | `60` | Aksi model per percobaan task. |
| `LUNEX_AI_MAX_DEBUG_ROUNDS` | tidak | `3` | Putaran perbaikan setelah verifikasi gagal. |
| `LUNEX_AI_COMMAND_TIMEOUT_MS` | tidak | `900000` | Timeout per command (test/build). |
| `LUNEX_AI_LLM_TIMEOUT_MS` | tidak | `300000` | Timeout per panggilan model. |
| `LUNEX_AI_AUTONOMOUS_IDLE` | tidak | `true` | Saat antrian kosong, buat task "Continue developing Lunex". |
| `LUNEX_AI_IDLE_TASK_COOLDOWN_MS` | tidak | `1800000` | Jeda minimal antar task otomatis. |
| `LUNEX_AI_MAX_SELF_TASKS_PER_DAY` | tidak | `10` | Batas task otomatis per hari (UTC). |
| `LUNEX_AI_REPLY_UNAUTHORIZED` | tidak | `false` | `false` = user tak dikenal diabaikan diam-diam (tetap dicatat di log). |

Konfigurasi salah → service keluar dengan kode 2 dan pesan yang **menyebut nama variabel, bukan nilainya**.

---

## 6. Setup Telegram bot

1. Di Telegram buka **@BotFather** → `/newbot` → beri nama, mis. `Lunex AI Control`.
2. Salin token ke `TELEGRAM_BOT_TOKEN` (via `sudoedit`). **Jangan** memakai token bot trading Lunex:
   dua proses yang long-polling token yang sama akan saling bentrok (HTTP 409).
3. Dapatkan ID numerik Anda: kirim pesan ke **@userinfobot**, atau kirim pesan ke bot baru lalu buka
   `https://api.telegram.org/bot<TOKEN>/getUpdates` di browser pribadi dan lihat `message.from.id`.
   Isi ke `TELEGRAM_ADMIN_ID`.
4. Kirim **`/start`** ke bot dari akun admin **sebelum** service dinyalakan — Telegram hanya mengizinkan bot
   mengirim pesan (laporan, notifikasi) ke user yang pernah memulai chat.
5. Disarankan: BotFather → `/setjoingroups` → **Disable** (bot hanya untuk chat pribadi).

---

## 7. Setup TokenRouter

1. Buat API key di dashboard TokenRouter, isi ke `TOKENROUTER_API_KEY`.
2. Endpoint yang dipakai (sesuai docs.tokenrouter.io, OpenAI-compatible):
   `POST https://api.tokenrouter.io/v1/chat/completions` dengan header `Authorization: Bearer <key>`.
3. Uji key + model **tanpa** menaruh key di history atau argumen yang terlihat di `ps`:

```bash
read -rs TR_KEY && export TR_KEY
curl -sS https://api.tokenrouter.io/v1/chat/completions \
  -H "Authorization: Bearer ${TR_KEY}" -H 'content-type: application/json' \
  -d '{"model":"z-ai/glm-5.3-free","messages":[{"role":"user","content":"Reply with OK"}]}' | head -c 600; echo
unset TR_KEY
```

Respons berisi `choices[0].message.content` → key dan model valid. Error 401 → key salah. Error 400/404
tentang model → lihat §8.

---

## 8. Konfigurasi GLM

- Default model: `z-ai/glm-5.3-free` (sesuai permintaan operator). Model ini **tidak tercantum** di dokumentasi
  publik TokenRouter yang diperiksa saat implementasi (docs memakai format `provider:model` dan mode `auto:*`),
  jadi statusnya **UNVERIFIED** sampai uji §7 berhasil.
- Jika uji §7 gagal karena model: cari ID GLM yang tepat di dashboard/model list TokenRouter, lalu set
  `LUNEX_AI_MODEL=<id-tepat>`. Supervisor **tidak pernah** berpindah model sendiri.
- Protokol: supervisor tidak memakai `tools`/JSON mode (docs TokenRouter menyebut JSON mode bergantung
  provider). Model menjawab satu objek JSON per langkah; jawaban tidak valid ditolak dan diminta ulang;
  4 kali berturut-turut → task di-requeue dengan backoff 5 menit.
- `temperature` 0.2. Ukuran kerja diatur via `LUNEX_AI_MAX_AGENT_STEPS` dan `LUNEX_AI_MAX_DEBUG_ROUNDS`.
- Error gateway (429/5xx/timeout) di-retry dengan backoff; error 4xx tidak di-retry. Setelah 3 percobaan task
  gagal karena gateway, task dilaporkan BLOCKED dengan instruksi memeriksa key/URL/model.

---

## 9. systemd

```bash
sudo install -o root -g root -m 0644 /opt/lunex/workspace/lunex/ops/lunex-ai/systemd/lunex-ai.service /etc/systemd/system/lunex-ai.service
sudo systemctl daemon-reload
sudo systemctl enable --now lunex-ai.service
```

Unit ini:
- `Restart=always`, `RestartSec=10` → hidup lagi setelah crash, `/restart` dari Telegram, atau reboot
  (`WantedBy=multi-user.target` + `enable`).
- `User=lunex-ai`, `NoNewPrivileges`, `ProtectSystem=strict`, `ProtectHome`, `PrivateTmp`, tanpa capability.
- `ReadWritePaths` hanya workspace Lunex dan `/opt/lunex/ai`.
- `InaccessiblePaths=-/opt/lunex/production -/opt/lunex/trading -/root -/etc/lunex -/opt/other-bots`.
  Tambahkan direktori bot lain di VPS Anda ke baris ini (awali `-`), lalu `daemon-reload`.

Periksa tingkat isolasi: `systemd-analyze security lunex-ai.service`.

---

## 10. Start / stop / status

```bash
sudo systemctl start lunex-ai        # nyalakan
sudo systemctl stop lunex-ai         # matikan (task berjalan di-checkpoint, di-requeue saat start berikutnya)
sudo systemctl restart lunex-ai      # restart
systemctl status lunex-ai            # status proses
systemctl is-enabled lunex-ai        # harus: enabled (auto-start setelah reboot)
```

Dari Telegram: `/status`, `/progress`, `/queue`, `/pause`, `/resume`, `/stop`, `/restart`, `/help`.

Checklist setelah instalasi:
1. Bot mengirim "LUNEX AI online" ke admin.
2. `/help` dan `/status` dijawab; `/status` menampilkan `Production: NOT TOUCHED`.
3. Dari akun Telegram **lain**: kirim `/status` → tidak ada balasan; `journalctl` mencatat `telegram_unauthorized`.
4. `/test` → hasil test suite Lunex dikirim setelah selesai.
5. Task kecil: `/task P4 Perbaiki typo pada komentar di src/api/server.ts` → tunggu laporan, cek
   `/git` dan `git log ai/develop`.

---

## 11. Inspeksi log

```bash
journalctl -u lunex-ai -f                          # live (stdout JSON, sudah di-mask)
journalctl -u lunex-ai --since "1 hour ago"
sudo -u lunex-ai ls /opt/lunex/workspace/lunex/.ai/logs/
sudo -u lunex-ai tail -n 50 /opt/lunex/workspace/lunex/.ai/logs/supervisor-$(date -u +%F).jsonl | jq -c '{ts,level,event}'
sudo -u lunex-ai jq -c 'select(.level=="warn" or .level=="error")' /opt/lunex/workspace/lunex/.ai/logs/supervisor-$(date -u +%F).jsonl
```

Event penting: `task_started`, `task_finished`, `agent_action_refused`, `telegram_unauthorized`,
`task_recovered_after_restart`, `state_file_corrupt`, `llm`-related errors. Dari Telegram: `/log 30`.

Log harian tidak dirotasi otomatis; hapus file lama bila perlu:
`sudo -u lunex-ai find /opt/lunex/workspace/lunex/.ai/logs -name '*.jsonl' -mtime +30 -delete`.

---

## 12. Recovery

**Crash / reboot / `systemctl restart`:** systemd menyalakan ulang service. Saat start, supervisor:
1. membaca `.ai/state/current_task.json`;
2. jika ada task berstatus `running` → ditandai `interrupted`, dicatat state git (branch, HEAD, jumlah file belum
   di-commit), dikembalikan ke antrian dengan prioritas & urutan aslinya — **tidak pernah dianggap selesai**;
3. task dilanjutkan di branch-nya sendiri, dan tetap harus lulus verifikasi penuh sebelum di-commit/merge;
4. offset Telegram dipersist sebelum command diproses → command tidak dieksekusi dua kali setelah restart.

**File state:** `/opt/lunex/workspace/lunex/.ai/state/`
`current_task.json`, `queue.json`, `progress.json`, `checkpoints.json`, `completed.json`, `blocked.json`.
File rusak otomatis dipindah ke `<nama>.json.corrupt-<timestamp>` dan diganti default (dicatat `state_file_corrupt`).

**Worker PAUSED karena butuh manusia** (laporan BLOCKED: working tree kotor di luar task, konten mirip secret,
path terlarang berubah, error supervisor):

```bash
cd /opt/lunex/workspace/lunex
sudo -u lunex-ai git status
sudo -u lunex-ai git diff --stat
# putuskan secara manual: commit ke branch ai/*, atau pindahkan perubahan — supervisor tidak pernah membuang kerja
```
Setelah bersih: kirim `/resume`.

**Task BLOCKED oleh strategy guard:** tinjau branch di laporan (`git log -p ai/develop..<branch>`). Jika setuju:
`/approve <taskId>` (supervisor checkout branch, verifikasi ulang penuh, fast-forward ke `ai/develop`). Jika tidak:
biarkan branch tidak di-merge.

**Reset antrian/state (terakhir):**
```bash
sudo systemctl stop lunex-ai
sudo -u lunex-ai mv /opt/lunex/workspace/lunex/.ai/state /opt/lunex/workspace/lunex/.ai/state.bak-$(date -u +%Y%m%dT%H%M%S)
sudo systemctl start lunex-ai
```

**Membawa hasil AI ke `main`:** selalu manual — review `ai/develop`, jalankan test, merge/PR oleh Anda.
Deployment ke produksi tetap lewat pipeline produksi Anda, bukan supervisor.

---

## 13. Update supervisor

```bash
cd /opt/lunex/workspace/lunex
sudo -u lunex-ai git log --oneline -5 -- ops/lunex-ai     # tinjau perubahan supervisor (hanya dari manusia)
sudo -u lunex-ai env HOME=/opt/lunex/ai/home bash -c 'npm run ai:typecheck && npm run ai:lint && npm run ai:test && npm run ai:build'
sudo rsync -a --delete ops/lunex-ai/dist/ /opt/lunex/ai/app/dist/
sudo chown -R root:lunex-ai /opt/lunex/ai/app && sudo chmod -R u=rwX,g=rX,o= /opt/lunex/ai/app
sudo install -o root -g root -m 0644 ops/lunex-ai/systemd/lunex-ai.service /etc/systemd/system/lunex-ai.service
sudo systemctl daemon-reload && sudo systemctl restart lunex-ai
```

---

## 14. Arsitektur singkat

```
Telegram (admin) ──► telegram/bot.ts ──► commands.ts (auth → command / bahasa natural)
                                             │
                                             ▼
                               supervisor/supervisor.ts (worker loop, pause/stop, idle task)
                                             │
                                             ▼
                        supervisor/taskRunner.ts ── gitOps (branch/commit/ff) ── verification (typecheck/lint/test/build)
                                             │                    ▲
                                             ▼                    │ allowlist + scope guard
                        agent/agentLoop.ts ◄──► llm/tokenRouterClient.ts (GLM via TokenRouter)
                                             │
                                             ▼
                        agent/tools.ts ──► scopeGuard.ts / commandRunner.ts (commandPolicy.ts)
State: stateStore.ts + taskQueue.ts + recovery.ts (.ai/state)   Log: logger.ts (.ai/logs)   Mask: secretMask.ts
```
