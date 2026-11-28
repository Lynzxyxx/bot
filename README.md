# Panel Pterodactyl untuk Bot Telegram (Vercel)

Panel bergaya Pterodactyl (Console, Files, Schedules, Startup, Settings) untuk menjalankan
**bot Telegram 24 jam di Vercel**, tanpa VPS.

## Kenapa bot bisa 24 jam tanpa "dibangunkan"?

Vercel itu *serverless*: tidak ada proses yang hidup terus, jadi bot dengan *long polling*
(`bot.launch()`, `polling: true`) **tidak mungkin** jalan di Vercel — mau di-ping sesering apa pun.

Solusinya **webhook**: Telegram yang memanggil `https://domainmu.vercel.app/api/webhook` setiap ada
pesan, Vercel menjalankan `bot.js` sebentar, membalas, lalu tidur. Karena Telegram yang
membangunkan, bot selalu menjawab 24 jam. Tombol **Start** = pasang webhook, **Stop** = hapus webhook.

Endpoint `/api/keepalive` tetap disediakan: memeriksa webhook dan memasangnya ulang otomatis bila hilang.

## Deploy (±5 menit)

1. Upload isi folder ini ke repo GitHub (atau `vercel deploy` dari CLI). Framework preset: **Other**.
2. Di Vercel → **Storage → Marketplace → Upstash Redis** → buat database gratis → *Connect to project*
   (otomatis menambah env `KV_REST_API_URL` & `KV_REST_API_TOKEN`).
3. Vercel → **Settings → Environment Variables**, tambahkan:
   - `ADMIN_PASSWORD` = password login panel (min. 6 karakter) — **wajib**
   - (opsional) `ADMIN_PASSWORD2`, `ADMIN_PASSWORD3`, … untuk admin tambahan
4. **Redeploy**, buka `https://nama-project.vercel.app`, login.
5. Tab **Files** → upload script bot kamu (`.zip` langsung bisa di-**Unarchive**).
6. Tab **Console** → **Start**. Script dijalankan, intro/banner-nya tampil di console, token & owner dibaca dari config script. Kirim `/start` ke botmu. Selesai.

> Token dan ID owner **tidak diisi di panel**. Panel membaca token dari script itu sendiri
> (argumen `new Telegraf(token)`, `config.js`, `settings.json`, atau `.env`). Owner/admin bot diatur di config script seperti biasa.

## Branding (logo & gambar header)

Logo (`public/assets/logo.jpg`) dan gambar header (`public/assets/hero.jpg`) adalah bawaan contoh —
ganti saja dengan gambarmu sendiri (nama file harus sama persis) untuk mengganti tampilan panel.
Nama "Lynzxyx" / "Pterodactyl Panel" di header diatur lewat atribut `id="panelName"` /
`id="panelSub"` di `public/index.html` (cari `<h1 id="panelName">`), tinggal ganti teksnya.

## Fitur File Manager

- **Upload tanpa batas ukuran & jumlah file** (file, banyak file, atau satu folder utuh; bisa drag & drop).
  File dipotong 512 KB per bagian, tiap bagian dicoba ulang otomatis bila koneksi putus, dan server
  memverifikasi file lengkap sebelum dianggap berhasil. File yang tetap gagal ditampilkan dengan tombol
  **Coba lagi yang gagal** — tidak ada file yang hilang diam-diam.
- **Unarchive (unzip)**: upload `.zip`, lalu menu `•••` → **Unarchive** (atau langsung ditawari setelah upload).
  Bisa pilih folder tujuan, melepas folder pembungkus, dan melewati `node_modules` / `__MACOSX` / `.git`.
  Ekstraksi berjalan bertahap dengan progress bar, mendukung ZIP64 dan nama file Unicode, dan menolak path
  berbahaya (zip-slip).
- Edit file teks dengan highlight sintaks (file >2 MB atau biner dibuka lewat **Download**).
- Menu `•••`: Edit, Download, Rename/pindahkan, Delete (folder rekursif).

> Batas yang tetap ada ada di luar panel: kuota penyimpanan & jumlah perintah Upstash milikmu
> (paket Free ±256 MB dan ±500 rb perintah/bulan; tiap file yang diunggah memakai beberapa perintah, dan
> auto-refresh panel memakai sekitar 1 perintah/detik hanya saat panel terbuka & aktif — otomatis melambat
> bila idle dan berhenti setelah 15 menit).

## Multi-admin — setiap admin = server sendiri

Tambah admin dengan membuat env baru di Vercel: `ADMIN_PASSWORD2`, `ADMIN_PASSWORD3`, … (jumlah bebas,
min. 6 karakter), lalu Redeploy. Menghapus env itu langsung mencabut akses admin tersebut.

**Setiap admin punya server TERPISAH TOTAL**, bukan cuma login berbeda ke server yang sama:
- File Manager, Console/log, konfigurasi (entry, auto-restart, dll.), token bot, dan URL webhook
  masing-masing admin terisolasi penuh — tidak pernah saling terlihat atau tertimpa.
- Setiap admin bisa upload & menjalankan **script bot Telegram yang sama sekali berbeda**, dengan
  token bot berbeda pula.
- Admin 1 (`ADMIN_PASSWORD`) memakai data yang sudah ada sebelum fitur ini (tidak perlu upload ulang).
  Admin 2 dan seterusnya otomatis mendapat ruang kosong sendiri.
- Tab **Databases** menampilkan status koneksi Redis dan berapa banyak admin yang aktif.

## Sinkronisasi dependencies ke GitHub

Kalau script yang di-upload butuh paket yang belum ada di `package.json` repo, panel bisa menambahkannya
sendiri lewat GitHub API — tidak perlu edit manual setiap kali ganti-ganti SC.

1. Buat **Personal Access Token** GitHub (Settings → Developer settings → Fine-grained tokens),
   beri akses **Contents: Read and write** khusus ke repo panel ini.
2. Di Vercel, tambahkan env: `GITHUB_TOKEN` (token di atas) dan `GITHUB_REPO` (format `namaAkun/namaRepo`).
   Opsional: `GITHUB_BRANCH` (default `main`) dan `DEPLOY_HOOK_URL` agar redeploy otomatis setelah sinkron.
3. **Jangan tempelkan token itu di chat atau di file yang ter-commit** — hanya taruh di Environment
   Variables Vercel. Token ini punya akses tulis ke repo, jadi perlakukan seperti password.
4. Upload/edit `package.json` SC-mu di tab **Files** — begitu terdeteksi, tombol
   **"Sinkronkan dependencies"** muncul. Panel akan menambahkan paket yang belum ada ke `package.json`
   GitHub (paket yang sudah ada **tidak pernah dihapus/ditimpa** tanpa alasan), lalu commit otomatis.
5. Redeploy (otomatis kalau `DEPLOY_HOOK_URL` di-set, atau manual lewat Vercel).

Tanpa `GITHUB_TOKEN`/`GITHUB_REPO`, tombol ini menampilkan instruksi manual seperti sebelumnya.

## Auto-restart (pemulih CPU)

Tab **Startup → Auto-restart**: jika CPU ≥ batas (default 90%) selama N proses berturut-turut, atau bot error
5× berturut-turut, panel me-restart server otomatis (pasang ulang webhook, reset cache kode & penghitung)
dan menulis alasannya di Console. Ada jeda minimal 5 menit antar restart agar tidak berulang-ulang.
Catatan: di serverless, "restart" tidak me-reboot proses (tidak ada proses tetap); fungsinya memulihkan
webhook dan state-nya.

## Script bot yang didukung

Tekan **Start** → panel menjalankan script (file utama otomatis: `main` di package.json → `index.js` → `main.js`
→ `bot.js` …, atau isi sendiri di Startup), semua `console.log` / banner / warna ANSI tampil di Console.

| Jenis script | Cara kerja |
|---|---|
| **Telegraf** (`new Telegraf(token)` + `bot.launch()`) | `launch()` dialihkan ke webhook, update diteruskan ke `bot.handleUpdate` |
| **grammY** (`new Bot(token)` + `bot.start()`) | `start()` dialihkan ke webhook |
| **node-telegram-bot-api** (`polling: true`) | polling dimatikan otomatis, `onText`/`on('message')` tetap jalan |
| **Format panel** `module.exports = async (ctx) => {}` | `ctx.reply()`, `ctx.send()`, `ctx.api()`, dst. |

- Mendukung **ESM** (`import`/`export`, `"type":"module"`) dan CommonJS; `dotenv` dan file `.env` dibaca otomatis.
  Tidak didukung: top-level `await`.
- Edit file lewat panel langsung berlaku di pesan berikutnya (tanpa Start ulang).
- `process.exit()` dan `process.on('SIGINT')` diabaikan agar server tidak mati.
- **Paket npm**: Vercel tidak bisa `npm install` saat runtime. `package.json` panel sudah memuat paket umum
  (telegraf, grammy, node-telegram-bot-api, axios, node-fetch, cheerio, moment, chalk@4, figlet, dotenv, lodash,
  fs-extra, form-data, uuid). Kalau script-mu butuh paket lain, Start akan menampilkan peringatan berisi
  baris yang harus ditambahkan ke `dependencies` di `package.json` repo GitHub, lalu Redeploy.
- **Batasan serverless** (tidak bisa disulap): script tidak berjalan terus-menerus, jadi `setInterval`/timer
  panjang, WebSocket (mis. Baileys WhatsApp) tidak cocok; variabel di memori hilang saat instance tidur;
  menulis file lokal (`database.json`, `sessions/`) tidak permanen — pakai database eksternal.
  Satu pesan harus selesai < 25 detik.

### Format panel (opsional, tanpa library)

```js
module.exports = async (ctx) => {
  if (ctx.command === 'start') return ctx.reply('Halo!');
  if (ctx.text) return ctx.reply('Kamu bilang: ' + ctx.text);
};
```

## Versi NodeJS

Tab **Startup** menampilkan Node 20–24 (+26). Kenyataan di sisi Vercel (dicek November 2026):
tersedia **22, 24, 26**; **20** sudah dinonaktifkan 1 Okt 2026; **21 & 23** (versi ganjil) tidak pernah
disediakan. Item yang tidak tersedia ditampilkan abu-abu dan tidak bisa dipilih.

Tombol **Terapkan versi** mengubah setelan Node.js project lewat Vercel API bila env berikut ada:
`VERCEL_TOKEN` (buat di vercel.com/account/tokens) — opsional `VERCEL_TEAM_ID` dan
`DEPLOY_HOOK_URL` (agar redeploy otomatis). Tanpa itu, ubah manual di
Settings → Build and Deployment → Node.js Version, lalu Redeploy.
Jangan tambahkan `engines.node` di package.json — itu menimpa setelan ini.

## Keep-alive tambahan (opsional)

- `vercel.json` sudah berisi Vercel Cron harian (batas paket Hobby).
- Tab **Schedules**: URL `/api/keepalive` + auto-ping tiap 4 menit selama panel terbuka.
- Untuk ping rutin 24 jam, daftarkan URL itu di UptimeRobot / cron-job.org (5 menit, gratis).

## Keamanan

- Panel dikunci `ADMIN_PASSWORD` (+ `ADMIN_PASSWORD2`, dst.); tanpa itu semua API menolak akses.
- Webhook hanya menerima request dengan `secret_token` dari Telegram.
- `bot.js` adalah kode yang dieksekusi server — jangan bagikan password panel.
- Token yang terdeteksi dari script disimpan di Redis milikmu (cadangan: env `BOT_TOKEN` di Vercel).
- `GITHUB_TOKEN` HANYA dibaca dari Environment Variable Vercel — panel tidak pernah menyimpannya di
  Redis maupun menerimanya lewat input di tampilan, supaya token sekuat itu tidak tersimpan di tempat
  yang kurang aman.

## Batasan jujur

- Statistik CPU/Memory adalah angka run terakhir dari function, bukan container sungguhan.
- Statistik grafik berasal dari polling panel (hanya terisi saat panel terbuka).
- Paket Hobby Vercel punya batas invokasi/durasi; bot ramai sebaiknya pakai Pro.

## Struktur

```
api/panel.js      API panel (login, power, console, files, unzip, startup)
api/webhook.js    endpoint yang dipanggil Telegram -> menjalankan bot.js
api/keepalive.js  endpoint pembangun + self-healing webhook
lib/              store (Redis, file tanpa batas), zip (unzip), runner (eksekusi bot), control, auth
public/index.html tampilan panel
```
