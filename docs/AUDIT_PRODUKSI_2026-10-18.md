# Audit kesiapan produksi — 18 Oktober 2026

> Ini snapshot **sebelum perbaikan**, pada commit yang disebut di bawah. Status dan hasil verifikasi sesudah perbaikan tersedia di [laporan perbaikan](PRODUCTION_HARDENING_2026-10-18.md).

Commit yang diperiksa: `3660b385078318e2d10782ddf1e00dc8492d3b28`.

**Keputusan: belum siap untuk produksi yang membutuhkan event dan statistik akurat atau pemrosesan reward.** Pengamanan dasar sudah cukup baik dan pengujian yang tersedia lulus, tetapi audit tambahan menemukan lima bug integritas data yang belum ditangkap pengujian tersebut. Dashboard dengan operator dan toleransi kehilangan data dapat dipertimbangkan untuk pilot setelah bug yang relevan diperbaiki.

Audit meliputi kode Node, dashboard React, fallback Python, autentikasi, webhook, WebSocket, persistensi, konfigurasi deployment, dan CI. Kode aplikasi tidak diubah; file ini merupakan hasil audit. Temuan baru melengkapi laporan 10 Oktober di `PRODUCTION_AUDIT.md`.

## Temuan yang harus diperbaiki

### 1. P1 — Gift non-streak berulang terhitung terlalu sedikit

Lokasi: `server/index.js:94`, khususnya baris 101–104; normalisasi di `server/gifts.js:66`.

`addGift()` menerapkan pengurangan counter streak pada semua gift. Entri baru dihapus jika `repeatEnd` bernilai benar. Gift non-streak (`giftType !== 1`) tidak memiliki kewajiban mengirim penutup streak, sehingga gift berikutnya dari pengguna dan ID yang sama dibandingkan dengan gift sebelumnya.

Reproduksi menjalankan fungsi `addGift` yang diambil langsung dari source dengan dua event hasil `normalizeGiftData`: pengguna `alice`, gift ID `5953`, `giftType: 0`, `repeatCount: 1`, `repeatEnd: 0`, dan `diamondCount: 100`.

```text
Seharusnya: gifts=2, giftCoins=200
Aktual:     gifts=1, giftCoins=100, satu entri streak tertinggal
```

Dampak: angka gift, coins, dan kontribusi pengirim dapat salah pada engine native/managed. Map streak juga menahan entri non-streak sampai statistik direset. Ini bukan bukti webhook kehilangan gift: alur dispatch tetap menerima masing-masing event.

Perbaikan: lakukan akumulasi langsung untuk gift non-streak; gunakan delta hanya untuk gift streakable. Tambahkan tes dua gift independen dari pengguna yang sama, streak bertambah, dan penutupan streak.

### 2. P2 — Follow/share dari engine native tidak diteruskan

Lokasi: `server/tiktok.js:183`.

Aplikasi hanya memasang handler `WebcastEvent.SOCIAL`. SDK terkunci `tiktok-live-connector@2.5.0` memproses `WebcastSocialMessage` dengan `common.displayText.key` yang memuat `follow` atau `share` menjadi event `follow`/`share` tersendiri, kemudian langsung kembali. Kedua event tersebut tidak memiliki listener aplikasi.

Reproduksi menggunakan instance SDK asli, memasang `TikTokService.bind()`, lalu memanggil `processDecodedData()` untuk masing-masing pesan follow dan share. Tidak ada koneksi jaringan.

```text
SDK:      follows=1, shares=1
Aplikasi: event yang diteruskan=[]
```

Dampak: feed, penghitung follow, WebSocket eksternal, dan webhook tidak menerima follow/share yang sudah dipisahkan SDK native. Temuan ini spesifik pada jalur native yang diuji.

Perbaikan: pasang handler `WebcastEvent.FOLLOW` dan `WebcastEvent.SHARE` secara eksplisit. Uji melalui decoder SDK agar perbedaan kontrak SDK tidak tertutup mock normalisasi.

### 3. P2 — Event awal native dihitung lalu dihapus dari statistik

Lokasi: `server/tiktok.js:125` dan `server/tiktok.js:230`; reset di `server/index.js:124`.

`processInitialData: true` memproses paket awal sebelum SDK mengumumkan `connected`. Handler `connected` kemudian mengirim `stream.started`, yang menyebabkan `resetStats()`. Akibatnya event awal sudah masuk history dan dikirim ke consumer, tetapi kontribusinya di statistik dihapus.

Urutan ini dikonfirmasi dari implementasi SDK terkunci: `_connect()` memanggil `processProtoMessageFetchResult()` sebelum `connect()` mengirim `connected`. Simulasi decoder dan lifecycle SDK menghasilkan urutan aplikasi `[chat, stream.started]`. Reproduksi fungsi counter/reset source menunjukkan `chat=1, giftCoins=100` menjadi `chat=0, giftCoins=0` setelah pengumuman started.

Dampak: statistik dashboard/REST tidak sesuai dengan history dan event yang telah diterima consumer pada awal koneksi.

Perbaikan: tentukan awal sesi/reset sebelum event awal diproses, atau buffer event awal sampai pengumuman started, seperti pola buffer pada engine managed. Pertahankan reset hanya sekali per sesi.

### 4. P2 — Top gifter melupakan akumulasi pengguna di luar 10 besar

Lokasi: `server/index.js:108`.

`topGifter` sekaligus menjadi sumber saldo kumulatif dan daftar tampilan yang dipotong menjadi 10 entri. Begitu seseorang terpotong, gift berikutnya memulai saldo orang tersebut dari nol.

Reproduksi memakai fungsi source dengan semua gift `repeatEnd: true` untuk memisahkannya dari temuan #1:

```text
10 pengguna masing-masing mengirim 100 coins.
alice mengirim 90 coins, lalu 90 coins lagi.
Seharusnya: alice memimpin dengan 180 coins.
Aktual: alice tidak ada di top 10; pemimpin tetap memiliki 100 coins.
Total coins global tetap benar: 1180.
```

Perbaikan: simpan akumulasi per pengguna terpisah dari tampilan top 10. Tetapkan batas/masa hidup state yang sesuai sesi LIVE, lalu urutkan proyeksi untuk respons.

### 5. P2 — Fallback Python membuang event terakhir setelah LIVE berakhir

Lokasi: `server/python-fallback.js:83`; snapshot bridge di `python_fallback/app.py:159`.

Bridge tetap mengembalikan event yang belum dibaca meskipun status sudah `disconnected`/`error`. Poller Node memeriksa status dan langsung kembali sebelum membaca `result.events`.

Reproduksi memberikan snapshot `status: disconnected`, `latestSeq: 1`, dan satu event gift valid. Hasil: event yang diteruskan `0`, cursor tetap `0`, status menjadi `Disconnected`.

Dampak: event di antara polling terakhir dan akhir LIVE hilang dari feed, statistik, WS, dan webhook. Bisa lebih dari satu batch jika terdapat backlog; ukuran batch bridge maksimal 200.

Perbaikan: kuras event hingga cursor mencapai snapshot akhir sebelum menandai sesi selesai. Pastikan seluruh batch tersisa diproses dan tetap lindungi pergantian generasi/sesi.

## Kesenjangan operasional

### 6. P2 — Gangguan koneksi memerlukan tindakan operator

Lokasi: `server/managed-live.js:267`, `server/tiktok.js:133`, `server/python-fallback.js:103`, serta startup `server/index.js:426`.

Pada putus koneksi, engine mengubah status lalu berhenti. Tidak ada kebijakan reconnect aplikasi dengan backoff. Startup proses juga hanya membuka HTTP server; LIVE harus dimulai kembali lewat admin. Reconnection Socket.IO di browser memulihkan koneksi dashboard saja.

Simulasi managed yang sudah connected lalu menerima close `1006` menghasilkan satu percobaan koneksi, status `Error`, `active=false`, dan `connected=false`; jalur close tidak menjadwalkan percobaan lain.

Dampak: gangguan sementara atau restart dapat menghentikan penerimaan event sampai operator memulai LIVE kembali. `/api/health` tetap dapat mengembalikan HTTP 200 karena mengukur ketersediaan proses, bukan keberhasilan ingest. Ini dapat diterima untuk deployment dengan operator, tetapi belum cukup untuk layanan tanpa pengawasan.

Perbaikan: definisikan desired-running state terpisah dari status transport, reconnect terbatas dengan backoff/jitter, pembatalan pada stop eksplisit, dan alert ketika ingest yang diharapkan berhenti. Jangan mengubah liveness menjadi kegagalan saat broadcaster memang offline.

### 7. Batas desain — Delivery webhook belum tahan restart atau antrean penuh

Lokasi: `server/work-queue.js:2`, `server/webhooks.js:57`, dan shutdown `server/index.js:429`.

Antrean hanya berada dalam memori: 4 job aktif dan 200 menunggu. Overflow dilewati dengan log; restart menghapus antrean. Shutdown tidak menunggu penyelesaian delivery. Retry membantu gangguan singkat, tetapi tidak memberikan jaminan delivery. Batas ini sudah dinyatakan pada dokumentasi sebelumnya.

Untuk dashboard best-effort, batas ini bisa diterima jika kehilangan event memang diperbolehkan. Untuk reward, saldo, transaksi, atau audit trail, diperlukan event log/outbox persisten, retry durable, pencatatan kegagalan permanen, serta deduplikasi/idempotency consumer. Persistensi delivery saja tidak memperbaiki event yang tidak pernah diingest selama koneksi terputus.

History, statistik, dan kontrol sesi LIVE juga berada dalam memori dan tidak mendukung banyak replica secara konsisten. Gunakan satu instance sesuai dokumentasi sampai desain state diubah.

## Verifikasi yang dijalankan

| Pemeriksaan | Hasil |
| --- | --- |
| Node.js | 24.19.0 |
| `npm test` | 61/61 lulus, tanpa skip; termasuk integrasi autentikasi, persistensi sesi, Socket.IO, WS, dan shutdown |
| `npm run check` | Lulus |
| `NODE_ENV=production npm run build` | Lulus; Vite 7.3.7 |
| `npm run test:browser` | Lulus: login, realtime, webhook validation/save/reload/cancel, mobile, logout |
| Python | 3.12.14; virtualenv sementara dengan `requirements.lock` |
| `python -m unittest discover -s python_fallback -p 'test_*.py' -v` | 10/10 lulus |
| `pip check` | Tidak ada konflik dependency |
| `npm audit --omit=dev --json` dan gate repo | Tidak ada advisory yang dilaporkan; gate lulus |
| `pip-audit --no-deps --disable-pip -r python_fallback/requirements.lock` | Tidak ada kerentanan yang diketahui |
| Reproduksi tambahan | Lima bug data di atas berhasil ditunjukkan; jalur putus koneksi managed dikonfirmasi |

Instalasi Python dilakukan di `/tmp/tlk-audit-venv`, alat auditor di `/tmp/tlk-pip-audit-tool`; dependency aplikasi tidak diubah. Pengujian server/browser dan Python dijalankan dengan izin eksekusi lokal yang diperlukan setelah sandbox membatasi akses port/proxy. Kegagalan awal akibat sandbox tidak dihitung sebagai bug aplikasi.

Pengamanan yang diperiksa mencakup cookie HttpOnly/Secure pada produksi, validasi secret startup, pencabutan JWT lintas restart dan perubahan password, pemeriksaan origin admin, pembatasan payload/rate/antrean, validasi tujuan webhook dan DNS publik yang dipin, signature HMAC, dan penyimpanan konfigurasi atomik. Hasil ini tidak berarti audit keamanan menyeluruh atau jaminan tidak adanya kerentanan yang belum diketahui.

## Syarat sebelum rilis

1. Perbaiki temuan #1–#4 untuk engine native/managed; perbaiki #5 jika fallback Python digunakan. Tambahkan pengujian perilaku yang gagal sebelum perbaikan dan lulus sesudahnya.
2. Tetapkan kebutuhan delivery: best-effort untuk dashboard, atau delivery durable dan idempotent untuk reward/transaksi. Atur pemulihan koneksi dan alert sesuai kebutuhan operasi tanpa pengawasan.
3. Verifikasi deployment sebenarnya: HTTPS, secret berbeda dan acak, jumlah proxy tepercaya, satu instance, serta `CONFIG_FILE` di disk persisten. Uji backup/restore dan restart dengan konfigurasi tersimpan.
4. Lakukan smoke test pada URL publik ketika broadcaster benar-benar LIVE: chat, gift streak/non-streak, follow/share, akhir LIVE, serta penerimaan WS dan verifikasi HMAC receiver.
5. Uji beban yang mewakili volume LIVE dan jumlah consumer/tujuan webhook; ukur penggunaan memori, keterlambatan event, overflow, dan recovery setelah tujuan webhook gagal.

Audit ini tidak mengakses deployment publik, tidak melakukan koneksi broadcaster nyata, tidak menguji entitlement Eulerstream, dan tidak mengirim webhook ke pihak lain. Konfigurasi secret/infrastruktur produksi aktual, backup/restore, dan kapasitas beban belum diverifikasi. Kelulusan tes lokal tidak cukup untuk menyatakan deployment sudah siap produksi.
