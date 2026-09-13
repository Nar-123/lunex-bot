# Lunex AI Supervisor — Deployment VPS

Cara memasang **Lunex AI Supervisor** (`ops/lunex-ai/`) di VPS Ubuntu sebagai `lunex-ai.service`,
dikendalikan lewat **satu** Telegram bot khusus.

Target yang dirancang: Ubuntu 24.04, x86_64, 2 CPU, 3.6 GB RAM, Node.js 22, systemd 255,
dengan project lain (`/opt/finance-bot`, `/opt/guardian`) di host yang sama.

> **Status verifikasi:** ditulis dan diuji di mesin development (258 test supervisor, typecheck, lint,
> build; `bash -n` pada script). Script deployment, unit systemd, Telegram dan TokenRouter
> **belum** pernah dijalankan di VPS sungguhan. `20-validate.sh` adalah sumber kebenaran setelah install.

---

## 0. Ringkasan jaminan keamanan

| Larangan | Lapisan 1: kode | Lapisan 2: OS |
|---|---|---|
| Akses `/opt/finance-bot`, `/opt/guardian`, `/opt/lunex/production`, `/opt/lunex/trading`, `/root` | `ScopeGuard` (realpath, anti-symlink/`..`), selalu ditolak | systemd `InaccessiblePaths`, `ProtectHome`, `ProtectSystem=strict` |
| Membaca `.env`, `*.pem`, `*.key`, `lunex-ai.env` | `ScopeGuard` menolak nama file | env file `ReadOnlyPaths`, mode 600 |
| `node`, `npm start`, `validate-live`, install paket, shell, `curl`, `systemctl` | `commandPolicy` allowlist tanpa shell | `NoNewPrivileges`, tanpa capability, tanpa sudo |
| `git push`, `reset --hard`, `clean`, `rebase`, force, hapus branch, tambah remote | `commandPolicy` | workspace tanpa remote git |
| Mengubah guardrail sendiri | agent tidak bisa menulis `ops/lunex-ai/`, `.git`, `.ai` | build yang dijalankan ada di `/opt/lunex/ai/lunex-ai`, read-only |
| Commit secret / path terlarang | scan baris yang ditambahkan + path guard sebelum commit | — |
| Strategi trading berubah tanpa izin | strategy guard → BLOCKED sampai `/approve <taskId>` | — |
| Secret bocor ke child process / log / Telegram / model | env child di-allowlist, semua output di-mask | — |
| Mengganggu bot lain di VPS | — | `CPUQuota=150%`, `MemoryMax=2048M`, `Nice=10` |

Tidak ada yang otomatis masuk ke `main` atau remote mana pun.

---

## 1. Layout

```
/opt/lunex/                               (tidak diubah jika sudah ada; production tinggal di sini)
├── workspace/                            root:lunex-ai 0750
│   └── lunex/                            lunex-ai:lunex-ai 0750   repo Lunex (git, TANPA remote)
│       └── .ai/{state,logs,reports}      lunex-ai 0750            state runtime (gitignored)
├── ai/                                   root:lunex-ai 0750
│   ├── lunex-ai/dist/                    root:lunex-ai 0750/0640  build supervisor yang dijalankan (read-only)
│   ├── lunex-ai/DEPLOYED_COMMIT
│   ├── lunex-ai.env                      lunex-ai:lunex-ai 0600   secret
│   ├── lunex.bundle                      root:lunex-ai 0640       sumber git yang terverifikasi
│   └── home/                             lunex-ai 0700            HOME service (cache npm)
└── production/                           TIDAK dapat diakses lunex-ai
```

Branch di workspace:
- `ai/lunex-ai-supervisor` — branch deployment (berisi baseline Lunex + P1 fix + supervisor).
- `ai/develop` — branch integrasi AI, dibuat dari `ai/lunex-ai-supervisor`; setiap task bekerja di
  `ai/<topik>-<id>` lalu di-fast-forward ke sini.
- `main` tidak pernah disentuh supervisor.

---

## 2. Script deployment

Semua ada di `ops/lunex-ai/deploy/` dan dijalankan sebagai root di VPS:

| Script | Mengubah sistem? | Fungsi |
|---|---|---|
| `00-discovery.sh` | **Tidak** | Fakta host, versi tool, layout `/opt`, owner/mode, service terkait, egress. Tidak pernah membaca isi project lain atau mencetak env. |
| `10-install.sh` | Ya (idempoten) | User `lunex-ai`, direktori, repo dari bundle, `npm ci`, gate verifikasi, pasang build, env template, unit systemd. |
| `20-validate.sh` | Hanya dengan `--restart-test` / `--recovery-test` (restart service lunex-ai saja) | PASS/FAIL untuk user, permission, systemd, sandbox, guard, git, kebocoran secret, checkpoint, konektivitas live. |

`10-install.sh` **tidak** pernah: menyentuh finance-bot/guardian/production, menimpa isi env file yang sudah ada,
membuang perubahan yang belum di-commit, push/force/rebase, atau mengubah permission `/opt/lunex` yang sudah ada.

---

## 3. Prosedur

### 3.1 Dari laptop: buat bundle yang reproducible

```bash
cd lunex_bot
git status --short                                  # harus kosong
git rev-parse ai/lunex-ai-supervisor                 # catat sebagai COMMIT
git bundle create lunex-ai-supervisor.bundle ai/lunex-ai-supervisor
git bundle verify lunex-ai-supervisor.bundle
scp lunex-ai-supervisor.bundle <vps>:/tmp/
```

### 3.2 Di VPS: discovery (read-only)

Untuk mendapatkan script sebelum repo ada, ekstrak dari bundle tanpa memasang apa pun:

```bash
mkdir -p /tmp/lunex-deploy && cd /tmp/lunex-deploy
git clone -q --branch ai/lunex-ai-supervisor /tmp/lunex-ai-supervisor.bundle src
git -C src rev-parse HEAD                            # harus sama dengan COMMIT
sudo bash src/ops/lunex-ai/deploy/00-discovery.sh
```

Periksa terutama: path Node **tidak** di `/root` atau `/home`; `/opt/lunex` bisa ditelusuri (o+x);
egress ke `api.telegram.org`, `api.tokenrouter.com`, `registry.npmjs.org`.

### 3.3 Di VPS: install

```bash
sudo bash /tmp/lunex-deploy/src/ops/lunex-ai/deploy/10-install.sh \
  --bundle /tmp/lunex-ai-supervisor.bundle --commit <COMMIT>
```

Tanpa secret, script berhenti di: `NOT STARTED: secrets missing`. Itu memang disengaja.

### 3.4 Secret (dilakukan operator sendiri)

```bash
sudoedit /opt/lunex/ai/lunex-ai.env
```

Isi langsung di editor (jangan `echo` ke shell):

```
TELEGRAM_BOT_TOKEN=<token bot kontrol AI yang BARU>
TELEGRAM_ADMIN_ID=<id numerik Telegram Anda>
TOKENROUTER_API_KEY=<api key TokenRouter>
LUNEX_AI_MODEL=z-ai/glm-5.3-free
LUNEX_AI_BASE_URL=https://api.tokenrouter.com/v1
```

Lalu `sudo systemctl start lunex-ai`.

### 3.5 Validasi

```bash
sudo bash /opt/lunex/workspace/lunex/ops/lunex-ai/deploy/20-validate.sh
sudo bash /opt/lunex/workspace/lunex/ops/lunex-ai/deploy/20-validate.sh --restart-test
# kirim satu task dari Telegram, tunggu /status = WORKING, lalu:
sudo bash /opt/lunex/workspace/lunex/ops/lunex-ai/deploy/20-validate.sh --recovery-test
```

---

## 4. Setup Telegram bot

1. @BotFather → `/newbot` → mis. `Lunex AI Control`. **Jangan** memakai token bot trading Lunex
   (dua proses polling token yang sama → HTTP 409).
2. BotFather → `/setjoingroups` → Disable.
3. ID numerik Anda: kirim pesan ke @userinfobot.
4. Kirim `/start` ke bot baru **sebelum** service dinyalakan (bot hanya bisa mengirim laporan ke user yang pernah memulai chat).
5. `20-validate.sh` bagian 9 menjalankan `checkTelegram.js`: menampilkan username bot dan memastikan tidak ada webhook. Token tidak pernah ditampilkan.

## 5. TokenRouter dan GLM

- Endpoint: `POST https://api.tokenrouter.com/v1/chat/completions`, header `Authorization: Bearer <key>`
  (format OpenAI-compatible sesuai docs.tokenrouter.io). `GET /v1/models` tanpa key menjawab 401 pada 2026-09-13,
  artinya host aktif dan butuh autentikasi.
- Model: `z-ai/glm-5.3-free`, **UNVERIFIED** sampai `checkModel.js` (validate bagian 9) mengembalikan `"ok":true`.
  Supervisor tidak pernah berpindah model sendiri; jika ID salah, ubah `LUNEX_AI_MODEL` di env file.
- Protokol: satu objek JSON per langkah (tanpa `tools`/JSON mode). Error 429/5xx di-retry dengan backoff; 4xx tidak.

## 6. Variabel environment

| Variabel | Wajib | Default |
|---|---|---|
| `TELEGRAM_BOT_TOKEN` | ya | — |
| `TELEGRAM_ADMIN_ID` | ya | — (angka, pisahkan koma) |
| `TOKENROUTER_API_KEY` | ya | — |
| `LUNEX_AI_MODEL` | tidak | `z-ai/glm-5.3-free` |
| `LUNEX_AI_BASE_URL` (alias `TOKENROUTER_BASE_URL`) | tidak | `https://api.tokenrouter.com/v1`; dua nilai berbeda → ditolak |
| `LUNEX_AI_WORKSPACE` / `LUNEX_AI_HOME` | tidak | `/opt/lunex/workspace/lunex` / `/opt/lunex/ai` |
| `LUNEX_AI_EXTRA_DENIED_PATHS` | tidak | — (production, trading, finance-bot, guardian, /root selalu ditolak) |
| `LUNEX_AI_INTEGRATION_BRANCH` | tidak | `ai/develop` |
| `LUNEX_AI_MAX_AGENT_STEPS` / `LUNEX_AI_MAX_DEBUG_ROUNDS` | tidak | `60` / `3` |
| `LUNEX_AI_COMMAND_TIMEOUT_MS` / `LUNEX_AI_LLM_TIMEOUT_MS` | tidak | `900000` / `300000` |
| `LUNEX_AI_AUTONOMOUS_IDLE` / `..._IDLE_TASK_COOLDOWN_MS` / `..._MAX_SELF_TASKS_PER_DAY` | tidak | `true` / `1800000` / `10` |
| `LUNEX_AI_REPLY_UNAUTHORIZED` | tidak | `false` (user tak dikenal diabaikan, tetap dicatat di log) |

Konfigurasi salah → exit code 2, pesan menyebut **nama** variabel, bukan nilainya.

## 7. systemd: start / stop / status

```bash
sudo systemctl start lunex-ai
sudo systemctl stop lunex-ai          # task berjalan berhenti di titik aman, di-commit WIP, di-requeue
sudo systemctl restart lunex-ai
systemctl status lunex-ai
systemctl is-enabled lunex-ai         # enabled = hidup lagi setelah reboot
systemd-analyze security lunex-ai
```

Dari Telegram: `/status /progress /queue /task /continue /pause /resume /stop /test /build /diff /git /log /audit /approve /restart /help`.

## 8. Log

```bash
journalctl -u lunex-ai -f
journalctl -u lunex-ai --since "1 hour ago" -o cat | jq -c '{ts,level,event}'
sudo -u lunex-ai tail -n 50 /opt/lunex/workspace/lunex/.ai/logs/supervisor-$(date -u +%F).jsonl
ls -l /var/log/lunex-ai-install-*.log
```

Event penting: `task_started`, `task_finished`, `agent_action_refused`, `telegram_unauthorized`,
`task_recovered_after_restart`, `stale_git_lock`, `state_file_corrupt`.

## 9. Recovery

- **Crash / reboot / restart:** `Restart=always` + `enable`. Saat start: lock git yang tertinggal dari perintah git yang terbunuh
  dihapus (hanya jika tidak ada proses git lain di repo), task berstatus `running` ditandai `interrupted`, dicatat
  state git-nya, dan dimasukkan lagi ke antrian di branch-nya sendiri. Task **tidak pernah** ditandai completed tanpa verifikasi penuh.
- **Offset Telegram** disimpan sebelum command diproses → command tidak dieksekusi dua kali.
- **Worker PAUSED** (working tree kotor di luar task, konten mirip secret, path terlarang, error supervisor):
  periksa `sudo -u lunex-ai git -C /opt/lunex/workspace/lunex status`, selesaikan manual, lalu `/resume`.
- **Strategy guard:** tinjau branch di laporan; `/approve <taskId>` menjalankan ulang verifikasi lalu fast-forward ke `ai/develop`.
- **Reset state (terakhir):** `systemctl stop lunex-ai`, pindahkan `.ai/state` ke backup, `systemctl start lunex-ai`.

## 10. Update supervisor

Ulangi 3.1 (bundle baru) lalu 3.3 dengan `--commit` baru. Installer menolak jika workspace punya perubahan
yang belum di-commit atau branch sudah diverge (tanpa force/rebase), memasang build baru, dan me-restart service.

## 11. Pemetaan acceptance criteria

| Kriteria | Dibuktikan oleh |
|---|---|
| Source tersedia, user dibuat, berjalan sebagai lunex-ai, systemd active | validate §1–3 |
| Restart otomatis | validate `--restart-test` (restart + SIGKILL) |
| Recovery setelah restart, checkpoint tersimpan | validate `--recovery-test`, §8 |
| Filesystem guard, command guard, private key tidak dapat diakses | validate §4 (namespace service), §5 (probe build ter-deploy) |
| finance-bot / guardian / production tidak tersentuh | validate §4; installer tidak pernah menyentuh path tersebut |
| Tidak ada secret di git / log / state | validate §7 (hitungan saja) |
| Tidak ada push ke main | workspace tanpa remote (validate §6); tidak ada push dari laptop |
| TokenRouter terhubung, model GLM terpanggil | validate §9 `checkModel.js` |
| Telegram /start, /status, /test, unauthorized ditolak, task dari Telegram, autonomous run, strategy guard | validate §12 (manual dari HP) + laporan task |
