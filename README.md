# Zerg Bot

Bot otomatisasi Zerg.app (devnet / stage) yang dikontrol via Telegram. Multi-akun,
multi-RPC failover, dengan job scheduling untuk farming sambil tidur. Cocok di-run
di VPS supaya 24/7.

**Fitur utama:**

- `/buy` & `/open` — beli box dari trending list + auto-open per loop, atau open
  inventory yang udah ada.
- `/autotask` — schedule multi-akun buy/open job dengan jeda anti-bot.
- `/daily` & `/check` — spin gumball machine harian (10/akun/hari) dengan slow-spin
  mode anti-bot, plus pre-flight check yang gak burn quota.
- `/tokens` — cek inventory token dan claim ke wallet.
- `/profile` & `/balance` — XP rank, breakdown, dan saldo SOL.
- Multi-akun manage langsung dari Telegram (`/accounts`).
- Sessions persist ke disk (wizard gak hilang pas bot restart).

> **Penting**: Zerg.app stage running di **Solana devnet**. Lo perlu **devnet SOL**
> (bukan mainnet SOL). Ambil gratis di
> **[https://faucet.solana.com/](https://faucet.solana.com/)** — pilih network "Devnet",
> paste wallet address lo, request 1-2 SOL. Cukup buat ratusan transaksi.

---

## Daftar Isi

1. [Persiapan](#persiapan)
2. [Setup di VPS (recommended)](#setup-di-vps-recommended)
3. [Setup di laptop / lokal](#setup-di-laptop--lokal)
4. [Manage Akun](#manage-akun)
5. [Pakai Bot — Feature Reference](#pakai-bot--feature-reference)
6. [Common Workflows](#common-workflows)
7. [Troubleshooting](#troubleshooting)
8. [Folder Structure](#folder-structure)

---

## Persiapan

Sebelum mulai, siapin hal-hal ini:

### 1. Telegram Bot Token

1. Buka Telegram, chat **[@BotFather](https://t.me/BotFather)**.
2. Kirim `/newbot`, ikutin instruksi (kasih nama + username).
3. BotFather kasih **bot token**, format: `123456:ABCdefGhIJKlmNoPqRsTuVwXyZ`. Simpen.

### 2. Telegram User ID kamu

1. Chat **[@userinfobot](https://t.me/userinfobot)** di Telegram.
2. Kirim apa aja, dia balas dengan ID kamu (angka, e.g. `123456789`).
3. Simpen — ini buat allowlist (cuma kamu yang bisa pakai bot).

### 3. Wallet Solana (devnet)

Lo butuh private key wallet Solana yang udah di-funded di **devnet**:

1. Bikin wallet baru (Phantom, Solflare, atau via CLI).
2. Switch ke devnet di wallet.
3. **Ambil devnet SOL gratis:**
   - Buka **[https://faucet.solana.com/](https://faucet.solana.com/)**
   - Pilih **Devnet** di dropdown
   - Paste wallet address (contoh: `4AZc...JZJ`)
   - Request 1-2 SOL (bisa request lagi tiap 24 jam)
4. Login ke **[stage.zerg.app](https://stage.zerg.app)** pake wallet itu, biar
   account ke-register di sistem Zerg.
5. Export private key (base58 format, 32B atau 64B) — disimpen aman.

> Bot baca private key dari `data/accounts.json` (multi-akun) atau `data/pk.txt`
> (single-akun). File-nya gitignored, gak akan ke-commit.

### 4. RPC URL (Solana devnet)

Butuh RPC URL devnet. Default `https://api.devnet.solana.com` (public, kadang
rate-limited). Lebih bagus pake Helius:

1. Sign up di **[helius.dev](https://helius.dev)** (free tier OK).
2. Bikin project, pilih **Devnet**.
3. Copy URL format: `https://devnet.helius-rpc.com/?api-key=YOUR_KEY`.

Bot support multi-RPC failover — lo bisa kasih lebih dari satu URL.

---

## Setup di VPS (recommended)

Setup di VPS supaya bot run 24/7 tanpa harus nyalain laptop. Cocok buat fitur
`/autotask` dan `/daily` yang perlu jeda berjam-jam.

### Spek minimum

- Ubuntu 22.04 / 24.04 LTS (bisa juga Debian, Tencent / DigitalOcean / Linode).
- 1 vCPU, 1 GB RAM, 10 GB disk (paling murah cukup).
- Akses SSH dengan SSH key.

### 1. Install Node.js + PM2

SSH ke VPS, lalu:

```sh
# Install Node.js 20 (LTS)
curl -fsSL https://deb.nodesource.com/setup_20.x | sudo -E bash -
sudo apt-get install -y nodejs

# Install PM2 (process manager — auto-restart, log management, startup script)
sudo npm install -g pm2

# Verify
node --version   # v20.x.x
pm2 --version
```

### 2. Clone repo + install deps

```sh
cd ~
git clone <your-repo-url> zerg
cd zerg
npm install
```

### 3. Buat `config.js`

Copy template `config.example.js` lalu edit:

```sh
cp config.example.js config.js
nano config.js
```

Isi minimal:

```js
export const config = {
  // RPC URLs — array, bot auto-failover kalau satu down/rate-limit
  rpcUrls: [
    'https://devnet.helius-rpc.com/?api-key=YOUR_HELIUS_KEY',
    'https://api.devnet.solana.com',
  ],

  // Telegram setup
  telegram: {
    botToken: '123456:ABCdef...',           // dari @BotFather
    allowedUserIds: [123456789],            // dari @userinfobot — array of numbers
  },

  // Defaults (boleh sesuaikan)
  defaultLoopsPerToken: 10,
  defaultQtyPerTx: { min: 20, max: 25 },

  // Anti-bot delays (semua dalam detik kecuali yang ditandai)
  delayBetweenTx: { min: 1, max: 3 },
  delayBeforeOpen: { min: 1, max: 3 },
  delayBetweenTokens: { min: 5, max: 5 },
  delayBetweenOpenChunks: { min: 500, max: 1500 }, // ms
  coffeeBreak: { everyN: 50, min: 30, max: 60 },   // pause N tx setiap 30-60s

  // Inter-account delay buat /autotask (detik)
  interAccountDelay: { min: 300, max: 900 }, // 5-15 menit
};
```

Lock permissions:

```sh
chmod 600 config.js
mkdir -p data && chmod 700 data
```

### 4. Tambah akun (private key)

Cara cepet: taruh 1 private key di `data/pk.txt`:

```sh
echo 'YOUR_BASE58_PRIVATE_KEY' > data/pk.txt
chmod 600 data/pk.txt
```

Bot bakal auto-import waktu pertama jalan, ke `data/accounts.json` dengan nama
default `default`. Multi-akun: pake `/account add <nama>` lewat Telegram nanti.

### 5. Start bot pake PM2

```sh
pm2 start npm --name zerg-bot -- run telegram

# Cek status
pm2 status
pm2 logs zerg-bot --lines 30
```

Kalau lo liat output `🤖 Telegram bot online`, berarti udah jalan.

### 6. Auto-start saat VPS reboot

```sh
pm2 startup           # ikutin instruksi yang dia print (sudo command)
pm2 save              # simpan list bot yang sekarang lagi running
```

Sekarang kalo VPS di-reboot, bot otomatis nyala lagi.

### 7. Test di Telegram

Buka chat bot kamu di Telegram, kirim `/start`. Harus dapet response:

```
👋 Zerg Bot Ready
Active: default
Wallet: 4AZc...JZJ
Network: devnet/stage
Pakai keyboard di bawah atau ketik /help.
```

Done — bot udah live di VPS.

### Useful PM2 commands

```sh
pm2 logs zerg-bot --lines 50    # tail logs
pm2 restart zerg-bot             # restart (e.g. setelah update config)
pm2 stop zerg-bot                # matiin (PM2 inget, bisa start lagi)
pm2 delete zerg-bot              # hapus dari PM2
pm2 monit                        # CPU/RAM monitor real-time
```

### Update bot di VPS (deploy)

```sh
cd ~/zerg
git pull
npm install                       # kalo ada package baru
pm2 restart zerg-bot --update-env
pm2 logs zerg-bot --lines 20      # verify running
```

---

## Setup di laptop / lokal

Sama kaya VPS, tapi tanpa PM2. Cocok buat development / testing.

```sh
git clone <repo> zerg
cd zerg
npm install

# Edit config.js — sama kaya step 3 di VPS section

# Run
npm run telegram
```

Untuk stop, `Ctrl+C`. Bot mati pas terminal di-close.

---

## Manage Akun

Bot support multi-akun. Tiap akun punya wallet sendiri, login session sendiri.

### Tambah akun baru

Lewat Telegram:

```
/account add namaakun
```

Bot akan minta private key (base58). Kirim sebagai message biasa. Bot save ke
`data/accounts.json` (encrypted di filesystem permission, gitignored).

### Switch akun aktif

```
/account use namaakun
```

Atau pake `/accounts` → pencet akun di inline keyboard.

Akun "aktif" itu yang dipakai buat command single-account kayak `/buy`, `/open`,
`/balance`, `/profile`.

### Operasi multi-akun

Beberapa fitur jalan di **semua akun sekaligus** (ga perlu switch):

- `/autotask` — pilih akun via multi-select wizard
- `/daily` — auto run di semua akun yang punya gumball aktif
- `/check` — cek status gumball semua akun (gak burn quota)

### Hapus / rename

```
/account remove namaakun
/account rename oldname newname
```

---

## Pakai Bot — Feature Reference

### Menu navigasi

`/menu` membuka menu kategori dengan inline buttons:

```
💰 Wallet      🎁 Trading
🤖 Tasks       ℹ️ Info
📊 Status      ⏸ Stop
```

Tap kategori → submenu dengan tombol-tombol langsung.

Atau pake reply-keyboard di bawah chat (4 tombol kategori).

---

### `/buy` — Beli box baru (auto-open)

Mode wizard (recommended buat awal):

1. Ketik `/buy` (no args).
2. Bot tampilkan **trending tokens** (10 teratas, sorted by volume).
3. Multi-select tombol token yang mau dibeli.
4. Tap **Lanjut** → input loops per token (default 10).
5. Input qty per tx (default 20-25, max 25 per transaksi).
6. Tap **Confirm**.

Bot bakal:
- Beli `qty` box, dapetin tx confirmation
- Auto-open box yang baru dibeli (chunked tiap 25)
- Loop sebanyak `loops` kali per token
- Sleep `delayBetweenTokens` antar token
- Coffee break tiap N tx (config-able)

Mode quick (advanced, tau ID tokennya):

```
/buy 01KQVMGR0M8GBQ7XH0PXPHMP0A 5 20-25
```

Args: `<id-list-comma-separated> [loops] [qty-or-range]`

Multi-token quick:

```
/buy 01KQV...ABC,01KQV...XYZ 10
```

### `/open` — Open box yang udah punya

Bedanya `/open` vs `/buy`: `/open` cuma buka box yang udah ada di inventory
(gak beli baru). Berguna kalo lo udah nimbun box dari `/buy` mode "buy semua dulu".

Mode wizard:

1. `/open` → bot fetch inventory, tampil daftar token + jumlah box unopened.
2. Multi-select token yang mau di-open.
3. Pilih: **Open semua** atau **Open sebagian** (specify count).
4. Confirm.

Mode quick:

```
/open 01KQV...ABC 100
```

(Open 100 box dari token ID-nya.)

### `/autotask` — Schedule multi-akun job

**Use case**: tinggal tidur 6 jam, mau bot beli + open ratusan box di 4 akun
sekaligus. Atau farm sambil kerja.

Wizard:

1. `/autotask`
2. **Pilih akun** — multi-select dari list akun yang lo punya.
3. **Pilih mode**:
   - 🛒 **Buy + Open** — beli baru, auto-open
   - 📦 **Open all boxes** — buka semua box yang udah ada (skip beli)
4. Kalau Buy + Open:
   - **Token IDs** — comma-separated, dari `/trending`
   - **Loops/token** — angka (e.g. `5`)
   - **Qty per tx** — `25` atau range `20-25`
   - **Sub-mode**: `⚡ Per-loop` (beli + open bergantian) atau `📦 Bulk`
     (beli semua dulu → open semua di akhir)
5. **Delay sebelum mulai**:
   - `30m` = 30 menit
   - `2h` = 2 jam
   - `1h30m` = 1 jam 30 menit
   - `0` = mulai sekarang
   - `90` (angka polos) = 90 menit
6. **Confirm** → tap **✅ Schedule**.

Bot proses akun pertama selesai dulu, lalu **anti-bot delay 5-15 menit random**,
lalu akun berikutnya, dst. Tiap akun di-track progressnya secara live di
Telegram message.

`/status` buat lihat progress, `/stop` buat batalin.

### `/daily` — Spin gumball machine

Tiap akun punya **10 spin gratis per hari** (reset jam 00:00 UTC = 07:00 WIB).
Tiap spin = XP + drops (rare items, beda rarities).

Wizard:

1. `/daily`
2. **Pilih jeda antar akun**: 5, 10, atau 15 menit (rekomen: 10).
3. **Confirm** → tap **🚀 Mulai**.

Bot bakal:
- Login ke setiap akun
- Spin sampe 10× per akun (atau sampe quota habis)
- **Slow-spin mode** — 8-20 detik random antar spin (anti-bot signature)
- Tiap akun selesai → kirim summary line (XP earned, rarity breakdown)
- Inter-account delay pake jeda yang lo pilih (±20% jitter)

Total durasi 4 akun × jeda 10m = **~50 menit**. Set & forget.

### `/check` — Pre-flight check daily (gak burn quota)

Sebelum `/daily`, cek dulu sisa spin per akun:

```
/check
```

Cuma hit endpoint `/gumball/status` (lenient, gak triger anti-abuse). Output:

```
🎰 Daily Status

○ mugi       — 0/10 spent · 10 left
○ cecenom    — 0/10 spent · 10 left
✓ tututlemot — 10/10 spent · 0 left
🚫 namcaca   — gumball nonaktif

Total tersisa: 20 spin
Reset dalam: 14h 22m
```

Icon: `○` belum spin, `◐` sebagian, `✓` udah max, `🚫` nonaktif, `❌` error.

### `/tokens` — Inventory token

Liat semua token yang lo punya dari hasil open box. Plus tombol **Claim** buat
withdraw token ke wallet (on-chain transaction).

### `/balance` — Saldo SOL

Cek saldo SOL devnet wallet aktif. Kalau kurang dari ~0.1 SOL, top-up dari
[faucet.solana.com](https://faucet.solana.com/).

### `/profile` — XP & rank

XP total, rank di leaderboard, breakdown spin/buy/open.

### `/status` — Status job aktif

Tampilkan job/auto-task yang lagi jalan atau scheduled. Termasuk:
- Auto-task: akun ke-N dari M, sub-job state, ETA
- Daily: akun ke-N, spin x/10
- Buy/open job: token ke-N, tx ok/fail, bought/opened count

### `/stop` — Cancel job

Stop job/auto-task yang lagi jalan atau scheduled. Aman — gak bakal corrupt
state, pause sub-job dulu lalu skip akun sisanya.

### `/login` — Re-login

Force re-login ke Zerg API (refresh cookies). Biasanya gak perlu — bot
auto-handle 401 dengan single-flight + cooldown logic.

### `/config` — Lihat config aktif

Tampilkan delays, RPC URLs, dan setting lain yang sedang dipakai. Read-only —
edit `config.js` di server kalau mau ubah.

### `/cancel` — Batalin wizard

Kalo lo lagi di tengah wizard (e.g. `/buy` di step "input loops") dan mau
batal, ketik `/cancel`.

---

## Common Workflows

### Tidur 8 jam, full farm 4 akun

```
1. /check                          # pastiin daily quota masih ada
2. /daily                          # spin dulu, ~50 menit
3. /autotask                       # schedule buy job
   - pilih 4 akun
   - mode: Buy + Open
   - tokens: 3-5 token trending
   - loops: 10
   - delay: 1h (start setelah daily kelar)
4. Tap ✅ Schedule
5. Tidur — bot kerja sendiri
```

Pas bangun, cek `/status` atau buka chat — bot udah kirim per-account summary.

### Hari biasa: cuma daily spin

```
/check    # liat sisa spin
/daily    # pilih 10m, mulai
```

50 menit kemudian semua akun udah max XP harian.

### Cek dulu market sebelum buy

```
/trending          # liat 10 token teratas
                   # tap-tap pilih, langsung jadi /buy wizard
```

### Open inventory yang nimbun

Setelah `/autotask` mode "Bulk" (beli semua dulu, open belakangan), atau kalo
lo manual nimbun box:

```
/open              # wizard pick dari inventory
```

---

## Troubleshooting

### Bot gak respon di Telegram

- Cek PM2: `pm2 status zerg-bot` — harus `online`. Kalo `errored`/`stopped`,
  cek logs: `pm2 logs zerg-bot --err --lines 50`.
- Cek allowlist: pastiin user ID kamu ada di `config.telegram.allowedUserIds`.
- Pastiin bot token bener dan dari BotFather (gak typo).

### "Unauthorized" pas kirim command

User ID kamu gak ada di allowlist. Edit `config.js`, restart bot.

### `/buy` selalu fail dengan "Insufficient SOL"

Saldo wallet kurang. Cek `/balance`, top up via
[faucet.solana.com](https://faucet.solana.com/) (pilih devnet).

### `/daily` semua akun langsung 429 dengan retry > 1 jam

IP VPS kamu kena anti-abuse Zerg. Penyebab umum:
- Spam `/daily` berkali-kali pas 429 (jangan retry kalo retry > 1h)
- Datacenter IP (Tencent/AWS/GCP) — Zerg lebih ketat ke datacenter IP
- Jalanin paralel banyak fitur sekaligus

Solusi:
- **Tunggu retry-window habis** (biasanya overnight)
- Jangan retry `/daily` kalo /check nampilin sisa spin masih utuh tapi tetep 429
- Pakai VPS di region yang beda, atau VPN/proxy residensial

### Session expired pas klik tombol

Sebelumnya: bot restart bikin sessions hilang. **Sekarang udah fix** — sessions
persist ke `data/sessions.json`. Kalo masih kena: ketik command lagi (e.g.
`/autotask`) buat mulai fresh.

### Bot nge-stuck "Checking..." atau status gak update

Ada race condition di throttle UI edit. Bot punya **per-account summary message**
sebagai fallback — even if live UI stuck, lo tetep dapet info di message baru
yang dikirim per akun.

### RPC failover

Kalo Helius rate-limit, bot auto-rotate ke RPC URL berikutnya di `config.rpcUrls`.
Cek logs:
```sh
pm2 logs zerg-bot | grep rpc-pool
```

---

## Folder Structure

```
zerg/
├── bin/                           # entry points (npm scripts)
│   ├── telegram-bot.js            # main: npm run telegram
│   ├── bot.js                     # interactive CLI: npm run bot
│   ├── login.js                   # auth smoke test: npm run login
│   ├── buy-box.js                 # one-shot buy
│   ├── buy-and-open.js            # one-shot buy+open loop
│   └── capture.js                 # puppeteer recorder (debug)
│
├── src/                           # library modules
│   ├── client.js                  # ZergClient: HTTP + auth
│   ├── actions.js                 # buyOne / openBoxes / claimTokens
│   ├── runner.js                  # buy/open job runner (event-driven)
│   ├── gumball.js                 # daily spin logic
│   ├── onchain.js                 # Solana on-chain ix builders
│   ├── account-manager.js         # multi-account state
│   └── rpc-pool.js                # multi-RPC failover
│
├── data/                          # runtime data (gitignored, mode 0700)
│   ├── accounts.json              # multi-account state + private keys
│   ├── pk.txt                     # legacy single-key fallback
│   └── sessions.json              # persisted wizard sessions
│
├── docs/
│   ├── auto-task.md               # /autotask deep-dive
│   └── idl.json                   # Anchor IDL reference
│
├── config.js                      # local config (gitignored)
├── package.json
└── README.md                      # ← you're here
```

---

## Resilience features (under the hood)

- **Single-flight login** — concurrent 401s dari berbagai endpoint share 1 login
  attempt, gak fire 5× login paralel.
- **Login cooldown** — 60s setelah fail biar gak hammer endpoint yang lagi 503.
- **Open retry** — 6× retry per chunk dengan exponential backoff (5xx/429/network).
- **Outage detection** — 3 token berturut gagal 5xx → pause job 5 menit.
- **Multi-RPC pool** — auto-failover kalau Helius rate-limit/down.
- **Anti-bot delays** — random jitter pada semua delays (per-tx, per-token,
  per-spin, per-akun) buat ngehindarin bot signature.
- **HTTP timeout** — 30s hard timeout di setiap request, fast-fail kalo
  endpoint nge-hang.
- **Sessions persist** — wizard data simpen ke disk tiap modify, restored on
  startup. Bot restart gak bikin user kehilangan progress.
- **Slow-spin mode** — `/daily` pake jeda 8-20s antar spin (vs 1.5-3.5s
  default) supaya gak ke-flag anti-abuse Zerg.
- **IP-rate-limit detection** — kalo 2 akun beruntun kena 429 dengan retry
  > 1 jam, bot stop early dan kirim warning (gak buang waktu di akun sisa).

Lihat [`docs/auto-task.md`](docs/auto-task.md) buat deep-dive fitur scheduling.
