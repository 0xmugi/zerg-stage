---
description: Cara pakai fitur /auto-task di Telegram bot (multi-account scheduled buy job)
---

# Auto-task — Multi-account Scheduled Buy

Fitur `/auto-task` memungkinkan kamu menjadwalkan job buy+open di beberapa akun secara berurutan, dengan jeda anti-bot otomatis. Cocok ditinggal tidur.

## Use case

- Beli semua box dari beberapa token TBO sekaligus, di banyak akun
- Mulai job nanti (mis. 30 menit lagi, atau jam 2 pagi)
- Bot proses akun pertama selesai dulu → switch ke akun berikutnya → dst
- Jeda random 5–15 menit antar akun supaya ga keliatan bot

## Wizard flow

1. Tap `/auto-task` di Telegram (atau dari keyboard)
2. **Pilih akun** — multi-select via tombol. Tap akun untuk toggle, lalu tap "✓ Lanjut"
3. **Token IDs** — kirim tboID comma-separated, contoh:
   ```
   01KQVMGR0M8GBQ7XH0PXPHMP0A, 01KQVP4BAM1NJQXZ785456ABC6
   ```
   (ambil dari `/trending` atau `/buy` picker)
4. **Loops/token** — angka, contoh `5` (= 5 loops per token per akun)
5. **Qty per tx** — angka atau range, contoh `25` atau `20-25` (max 25)
6. **Delay** — kapan task dimulai:
   - `30m` = 30 menit
   - `2h` = 2 jam
   - `1h30m` = 1 jam 30 menit
   - `0` = mulai sekarang
   - Angka polos (mis. `90`) = menit
7. **Konfirmasi** — tap "✅ Schedule" atau "❌ Batal"

## Selama task berjalan

- Pakai `/status` untuk lihat progress (akun ke-berapa, sub-job state)
- Pakai `/stop` untuk batal:
  - Sebelum mulai → cancel timer
  - Sedang jalan → abort sub-job + skip akun sisanya
- Bot kirim notifikasi:
  - Header per akun: `▶️ [N/M] {accountName}`
  - Live progress bar di sub-job message
  - "💤 Anti-bot sleep XmYs..." sebelum switch akun
  - Final summary dengan total bought/opened per akun

## Anti-bot behavior

- **Inter-account delay**: random 5–15 menit antar akun (configurable via `config.interAccountDelay`)
- **Token order shuffle**: tiap akun dapat urutan token random sendiri
- **Existing per-tx delays**: dari `config.delayBetweenTx`, `coffeeBreak`, dll tetap aktif

## Limits

- Cuma bisa 1 auto-task aktif (scheduled atau running) sekaligus
- Selama auto-task aktif, `/buy`, `/open`, `/trending` di-block (untuk mencegah konflik)
- Bot crash / restart selama task = task hilang (tidak persisten ke disk)
- Kalau ada akun yg belum login, bot akan auto-login waktu giliran akun itu jalan

## Tips

- Sebelum jalanin, pastikan SOL cukup di SEMUA akun yg dipilih
- Test dulu dengan 1 akun + 1 token + delay 0 untuk verify config
- Kalau mau tidur 6 jam dan ada 5 akun, set delay sesuai jam tidur — bot akan stagger akun-akun across the night dengan inter-account delay 5-15m
