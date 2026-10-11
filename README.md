# TikTok Live Konektor

Jembatan event TikTok LIVE untuk dashboard, overlay, game, dan website lain. Backend memakai Node.js 24, Express, Socket.IO, WebSocket eksternal, serta webhook bertanda tangan HMAC; dashboard memakai React/Vite. Python TikTokLive tersedia sebagai fallback opsional.

Website konsumen terhubung ke layanan ini melalui **backend website → REST API/WebSocket**, atau menerima **webhook → backend website**. Secret tetap berada di server.

- [Panduan integrasi website: konfigurasi, REST, Worker, WebSocket, webhook](docs/INTEGRASI_WEBSITE.md)
- [Laporan audit dan persyaratan deployment produksi](docs/PRODUCTION_AUDIT.md)
- [Blueprint Node](render.yaml) dan [Blueprint Python opsional](render-python.yaml)

## Menjalankan secara lokal

Gunakan Node.js **24.x**. Dari root repositori:

```bash
npm ci
npm run dev
```

Dashboard development tersedia pada port **5173**; Express pada **10000**. Vite meneruskan `/api` dan `/socket.io` ke Express, termasuk upgrade WebSocket. Login development default adalah `admin` / `change-me-now` jika tidak ada password atau hash tersimpan. Login ini hanya untuk development lokal.

`npm run dev` dan `npm start` **tidak otomatis membaca `.env`**. Aplikasi membaca environment proses. Untuk memakai file lokal, buat `.env` dari `.env.example`, isi konfigurasi, lalu jalankan:

```bash
node --env-file=.env --run dev
```

`.env.example` menetapkan `NODE_ENV=production` dan berisi placeholder. Untuk development, ubah `NODE_ENV=development` dan `TRUST_PROXY=0`; hapus/ganti placeholder sesuai kebutuhan. Jangan commit `.env` atau credential.

## Build dan startup produksi

```bash
npm ci --include=dev
npm run build
node --env-file=.env --run start
```

File `.env` harus berisi `NODE_ENV=production` dan konfigurasi produksi yang valid. Pada Render atau platform yang sudah menginjeksi environment, gunakan `npm start` tanpa file `.env`, dengan `NODE_ENV=production` di pengaturan service.

Dependency build tetap diperlukan: `.npmrc` menyertakan `include=dev`. `package-lock.json` digunakan oleh `npm ci`; jangan menjalankan build dengan dependency Vite/React plugin dihilangkan.

### Konfigurasi environment

| Variabel | Penggunaan |
| --- | --- |
| `NODE_ENV` | `production` pada deployment publik; `development` pada development lokal |
| `PORT` | Port Express; default `10000`, atau port yang diinjeksi hosting |
| `ADMIN_USERNAME` | Wajib pada produksi; username dashboard |
| `ADMIN_PASSWORD` | Wajib pada startup produksi pertama tanpa hash; minimal 12 karakter, maksimal 72 byte UTF-8; placeholder ditolak |
| `JWT_SECRET` | Wajib pada produksi; secret acak minimal 32 karakter untuk sesi admin |
| `WS_TOKEN` | Wajib pada produksi; token acak minimal 32 karakter untuk `/live` |
| `API_KEY` | Minimal 32 karakter bila diisi; diperlukan untuk `/api/v1/*`, juga diterima oleh `/live` |
| `WEBHOOK_SIGNING_SECRET` | Minimal 32 karakter bila diisi; wajib sebelum webhook produksi diaktifkan |
| `API_ALLOWED_ORIGINS` | Origin browser consumer yang diizinkan pada REST eksternal dan `/live`, dipisahkan koma; tanpa path/trailing slash |
| `TIKTOK_USERNAME` | Akun penyiar default; bisa diatur dari dashboard |
| `TIKTOK_ROOM_ID` | Room ID manual opsional; kosong untuk discovery otomatis |
| `EULER_API_KEY` | Key Eulerstream di server; akses signer/gateway mengikuti entitlement akun |
| `CONFIG_FILE` | Default `./data/config.json`; tempat konfigurasi, hash password dan pencabutan sesi; gunakan storage persisten |
| `TRUST_PROXY` | Jumlah hop proxy tepercaya, `0–10`; default produksi `1`, development `0`; Render memakai `1` |

Gunakan secret yang berbeda untuk JWT, WS, API dan webhook. Kode menolak JWT/WS/API yang identik dan placeholder JWT/WS/API; jangan mengandalkan pemeriksaan panjang sebagai pengganti secret acak. Contoh membuat **satu** secret untuk disimpan secara aman di pengaturan hosting:

```bash
node -e "console.log(require('node:crypto').randomBytes(32).toString('hex'))"
```

Ulangi untuk setiap secret. Jangan menempelkan secret ke issue, log, frontend, atau URL publik. Hash password tersimpan diprioritaskan atas `ADMIN_PASSWORD`; mengubah environment password tidak mereset hash yang sudah ada.

### Render

1. Deploy `render.yaml` sebagai Blueprint untuk Node. Konfigurasi memakai **Starter berbayar**, Node 24, health check `/api/health`, serta disk `/var/data` untuk `CONFIG_FILE`.
2. Blueprint menghasilkan `ADMIN_PASSWORD`, `JWT_SECRET`, `WS_TOKEN`, `API_KEY`, dan `WEBHOOK_SIGNING_SECRET`. Ambil nilai yang diperlukan melalui pengaturan service secara aman; berikan hanya API key atau secret webhook yang relevan kepada backend consumer.
3. Isi `TIKTOK_USERNAME` dan `EULER_API_KEY`. Atur `API_ALLOWED_ORIGINS` hanya jika consumer mengirim `Origin`.
4. Gunakan domain HTTPS publik service. Login dashboard, kemudian klik **Start LIVE** saat penyiar sedang siaran.
5. Verifikasi `status: Connected` dan event nyata pada [panduan integrasi](docs/INTEGRASI_WEBSITE.md). Health sukses hanya membuktikan proses tersedia.

Jalankan **satu instance Node**. LIVE state, rate limit, history, dan socket session tracking berada dalam memori proses. Backup file konfigurasi secara aman; file itu berisi data sensitif. Environment username/Room ID yang tidak kosong dan `WS_TOKEN` diprioritaskan saat startup. Restart menghapus history dan statistik LIVE.

## Integrasi cepat dari website lain

| Kebutuhan | Endpoint/metode | Autentikasi |
| --- | --- | --- |
| Memeriksa proses | `GET /api/health` | Publik |
| Status dan statistik | `GET /api/v1/status`, `GET /api/v1/stats` | `Authorization: Bearer <API_KEY>` atau `X-API-Key` |
| History terbaru | `GET /api/v1/events?type=chat,like,gift&limit=20` | API key |
| Event realtime | `wss://<domain-konektor>/live?events=chat,like,gift` | Header Bearer API key atau WS token dari backend |
| Workflow di website | Webhook HTTPS dari dashboard | Verifikasi HMAC pada receiver |
| Start/Stop LIVE, konfigurasi | Dashboard dan endpoint admin `/api/*` | Cookie sesi admin, origin dashboard yang sama |

`/api/v1/*` bersifat **read-only**. API key bukan kredensial login admin, dan `WS_TOKEN` tidak mengautentikasi REST API. `/socket.io` dipakai dashboard dengan sesi admin; consumer eksternal memakai `/live`.

Untuk website publik, backend menyimpan `TLK_BASE_URL` dan `TLK_API_KEY`, mengambil data dari konektor, lalu meneruskan data yang diizinkan ke frontend. Contoh server-side:

```js
const base = new URL(process.env.TLK_BASE_URL);
const key = process.env.TLK_API_KEY;
if (!key) throw new Error('TLK_API_KEY belum diatur');
const response = await fetch(new URL('/api/v1/status', base), {
  headers: { Authorization: `Bearer ${key}` },
  signal: AbortSignal.timeout(10_000),
  redirect: 'error'
});
if (!response.ok) throw new Error(`Konektor HTTP ${response.status}`);
const live = await response.json();
console.log({ status: live.status, engine: live.engine, running: live.running });
```

`API_ALLOWED_ORIGINS` memeriksa request yang membawa `Origin`. Backend consumer tanpa header tersebut tidak memerlukan origin di allowlist, tetapi tetap memerlukan API key. CORS bukan autentikasi; frontend sebaiknya hanya memanggil backend milik website sendiri.

Mode kompatibilitas browser `/live?key=<API_KEY>` atau `?token=<WS_TOKEN>` masih tersedia untuk klien terkontrol, dengan origin yang diizinkan. URL itu mengungkap credential kepada pengguna dan kemungkinan log; jangan memakainya untuk menyembunyikan secret pada website publik.

## Webhook dan riwayat admin

Pada dashboard **Integrasi Webhook**, tambah maksimal 20 tujuan HTTPS publik, pilih event, aktifkan, lalu klik **Simpan webhook**. Daftar event kosong berarti semua event yang disiarkan. Edit belum berlaku sampai disimpan; **Batalkan** mengembalikan draft. `PUT /api/webhooks` hanya memperbarui webhook, tanpa menimpa username/Room ID LIVE.

Webhook produksi memerlukan `WEBHOOK_SIGNING_SECRET`. Header signature adalah `sha256=<hex HMAC-SHA256>` atas **timestamp + `.` + raw body**. Receiver harus memverifikasi signature, toleransi waktu, dan deduplikasi `event.id`. [Panduan lengkap receiver](docs/INTEGRASI_WEBSITE.md#6-webhook-dengan-verifikasi-hmac) menjelaskan cara pemasangan sebelum middleware JSON.

URL IP literal, private/local DNS, kredensial URL, fragment, duplikat URL dan redirect ditolak. Alamat DNS publik dipin untuk koneksi TLS. Delivery dibatasi empat job aktif dan 200 menunggu; overflow dicatat dan dilewati. Timeout default 5 detik; retry default tiga setelah percobaan pertama. Delivery bersifat best-effort dan antrean tidak persisten.

Riwayat aktivitas dapat dihapus oleh admin:

- `DELETE /api/events/:id`: hapus satu event; ID invalid menghasilkan 400, event tidak ditemukan menghasilkan 404.
- `DELETE /api/events`: hapus semua history, termasuk event yang tersembunyi oleh filter.
- Perubahan disinkronkan ke dashboard lain lewat Socket.IO. Penghapusan history tidak mengubah statistik, gift counter atau webhook yang telah dikirim.

Logout mencabut sesi saat ini dan memutus socket terkait. Perubahan password mencabut seluruh sesi. Socket.IO memeriksa kedaluwarsa JWT setiap 30 detik. Sesi JWT dari versi sebelum audit produksi harus login ulang.

## TikTok LIVE, Room ID dan fallback

Start LIVE memakai Room ID manual jika diisi; jika kosong, connector mencoba resolver bawaan lalu probe HTML LIVE yang ketat. Room ID hanya membantu discovery, tidak menggantikan validasi room atau signing WebSocket. Extended gift info aktif; nama gift tetap bergantung pada metadata upstream. Event menyertakan `giftId` dan `giftName`; nama yang tidak tersedia menjadi `Gift #<id>` atau `Gift tidak dikenal`.

Urutan koneksi: **Node → managed Cloud WebSocket pada error Business-plan → Python bila dikonfigurasi**. Status `engine` dapat berupa `node`, `managed`, `python`, atau `none`.

Eulerstream Business signing dan managed Cloud WebSocket adalah layanan berbeda. Community key tidak memberikan akses Business signing. Gateway hanya berhasil jika key diterima, kuota/entitlement sesuai, dan broadcaster benar-benar LIVE. Room ID manual, restart, dan Python fallback tidak menjamin melewati pembatasan TikTok atau signer.

### Python opsional

Deploy `render-python.yaml` secara terpisah bila fallback diperlukan. Blueprint memakai Starter berbayar, Python 3.12, lockfile dependency dan secret `PYTHON_BRIDGE_TOKEN`.

Pada Node, isi:

- `PYTHON_FALLBACK_URL`: origin HTTPS publik Python, tanpa path/query/credential; atau `PYTHON_FALLBACK_HOSTNAME` berupa hostname saja.
- `PYTHON_FALLBACK_TOKEN`: nilai yang sama dengan `PYTHON_BRIDGE_TOKEN` di Python, minimal 32 karakter.

Blueprint terpisah **tidak otomatis menghubungkan** URL/token. Python `/health` publik; `/start`, `/stop`, `/events` memakai bearer bridge token. Node melakukan polling otomatis setelah fallback berhasil. Python meresolve username sendiri, memiliki buffer maksimal 2000 event dan membaca maksimal 200 per polling; overload dapat kehilangan data. Setelah LIVE berakhir, mulai lagi dari dashboard bila diperlukan.

Manual startup Python dari root repositori:

```bash
python3 -m venv .venv
.venv/bin/python -m pip install -r python_fallback/requirements.lock
# Injeksi PYTHON_BRIDGE_TOKEN ke environment sebelum startup.
.venv/bin/python -m uvicorn python_fallback.app:app --host 0.0.0.0 --port 10001
```

## Pengujian dan batas operasional

```bash
npm test
npm run build
npm run test:browser
```

Browser smoke membutuhkan Chromium/Google Chrome; set `CHROMIUM_PATH` bila tidak berada di path standar. Tes Python:

```bash
.venv/bin/python -m unittest discover -s python_fallback -p 'test_*.py'
```

CI memakai Node 24, `npm ci`, pengujian, build dan browser smoke, serta Python lockfile. Job security memeriksa advisory runtime high/critical tanpa pengecualian. Opsi timeout, payload, history, retry dan debug ada di [.env.example](.env.example).

Hasil audit pada [laporan produksi](docs/PRODUCTION_AUDIT.md) mencakup pengujian lokal. Integrasi nyata memerlukan pengujian pada deployment Anda dengan broadcaster aktif dan receiver milik Anda. Event/history bukan database transaksi; gunakan penyimpanan serta idempotency pada backend consumer untuk data penting.
