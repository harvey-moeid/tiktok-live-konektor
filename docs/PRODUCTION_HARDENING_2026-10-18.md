# Perbaikan audit produksi — 18 Oktober 2026

Perubahan ini menindaklanjuti [audit awal](AUDIT_PRODUKSI_2026-10-18.md) pada commit `3660b385078318e2d10782ddf1e00dc8492d3b28`. Kelima bug integritas data telah diperbaiki; recovery koneksi dan outbox persisten juga ditambahkan. Deployment publik dan TikTok LIVE nyata masih memerlukan smoke test setelah deployment.

## Hasil perbaikan

| Temuan | Perilaku sekarang | Bukti regresi |
| --- | --- | --- |
| Gift non-streak terhitung kurang | Gift independen dihitung langsung; delta hanya untuk streakable. Grup streak dipisahkan jika upstream memberikan group ID. | Dua gift 100 coins menghasilkan 2 gift/200 coins; progres, penutupan, grup bersamaan dan streak baru diuji. |
| Follow/share native hilang | Listener FOLLOW/SHARE SDK dipasang secara eksplisit; format social managed juga membaca `common.displayText.key`. | Decoder SDK asli meneruskan kedua event ke consumer. |
| Event awal hilang dari statistik | Controller menahan event selama koneksi dibuka, lalu mengumumkan satu `stream.started` sebelum mengurasnya. | SDK asli dengan initial chat/gift/follow menghasilkan statistik 1 chat, 100 coins dan 1 follow. |
| Akumulasi top gifter terhapus | Map saldo pengirim terpisah dari daftar tampilan top 10. | Pengirim 90+90 coins mengalahkan 10 pengirim masing-masing 100 coins. |
| Event akhir Python dibuang | Poller menguras semua batch terakhir sebelum status terminal; perubahan sesi bridge terdeteksi. | Backlog terminal lintas batch diteruskan; snapshot bridge 205 event dan pergantian session ID diuji. |
| Tidak ada pemulihan koneksi | Desired state persisten, operasi terserialisasi, backoff/jitter, retry terbatas, cleanup engine lama, Stop membatalkan retry. | Recovery, startup dari intent, pembatalan startup, retry habis, kegagalan persistensi dan callback usang diuji. |
| Webhook hilang saat restart | Outbox SQLite WAL/FULL menyimpan semua destinasi secara atomik sebelum delivery. Pending pulih; failed tersimpan untuk retry admin. | Restart, retry exhaustion/replay, shutdown timeout, disk read-only, kapasitas, concurrency dan pembatalan destinasi diuji. |

Pengiriman realtime dipusatkan pada event normalisasi yang sama dengan history/webhook. ID pesan upstream yang tersedia diubah menjadi ID stabil untuk mengurangi duplikasi replay. Identitas protobuf kosong/nol tidak digunakan sebagai kunci, sehingga gift independen tidak salah terhapus. Jendela deduplikasi proses terbatas pada 10 menit/10.000 ID; consumer tetap wajib melakukan deduplikasi persisten.

Statistik dipertahankan ketika recovery membuktikan Room ID yang sama, dan direset untuk sesi baru/room berbeda. Batas pelacakan adalah 100.000 pengirim dan 20.000 streak aktif; streak tanpa penutup kedaluwarsa setelah 5 menit. Bila batas kapasitas tercapai, `stats.trackingLimited` menandai statistik tidak lengkap dan dashboard menampilkannya. Statistik dan history tetap bersifat per-proses.

## Operasi setelah deployment

- Node 24 tetap wajib. SQLite menggunakan modul bawaan Node; tidak ada dependency npm baru. Default outbox berada di direktori `CONFIG_FILE`, sehingga Blueprint yang sudah memakai `/var/data/config.json` otomatis menyimpan outbox pada disk persisten yang sama.
- Startup pertama tidak langsung menghubungkan broadcaster. Sesudah admin menekan Start, intent disimpan. Restart melanjutkan intent tersebut; Stop eksplisit menyimpan intent berhenti. `LIVE_AUTO_RECONNECT=false` menonaktifkan retry setelah kegagalan, bukan menghapus intent Start yang sudah tersimpan.
- Retry default maksimum 10, dengan delay mulai sekitar 2 detik dan maksimum 60 detik, memakai jitter. Koneksi stabil setidaknya 30 detik mereset hitungan kegagalan ketika berikutnya terputus. Penolakan entitlement/autentikasi yang dikenali tidak diulang tanpa batas. Setelah retry habis, perbaiki penyebab lalu gunakan Stop dan Start.
- `running` mempertahankan arti transport Connected/Connecting. `desiredRunning` menunjukkan intent admin dan tetap benar ketika recovery menunggu atau habis. UI menggunakan intent agar Stop tetap tersedia.
- `/api/health` adalah liveness dan tetap menjadi health check hosting. `/api/ready` mengukur kesiapan ingest/delivery: LIVE sengaja dihentikan dapat ready; LIVE yang diharapkan tetapi tidak Connected atau delivery bermasalah menghasilkan 503. Gunakan readiness untuk alert, bukan restart otomatis ketika penyiar offline.
- Status delivery tersedia di dashboard dan `GET /api/webhooks/status` dengan cookie admin. `POST /api/webhooks/retry` mengulang job failed memakai ID/body asli dan signature bertimestamp baru. Endpoint dilindungi autentikasi dan pemeriksaan origin. Menonaktifkan/menghapus destinasi membatalkan backlog destinasi tersebut.
- Default outbox: empat delivery aktif, kapasitas total 10.000 job pending+failed atau 100 MiB payload logis, tiga retry setelah percobaan pertama dan timeout 5 detik. Batas halaman SQLite juga dipasang. Kegagalan storage/overflow dicatat tanpa URL/secret dan menurunkan readiness. Counter insiden storage/overflow bertahan selama proses berjalan; periksa log dan selesaikan penyebab sebelum restart untuk menghapus latch readiness tersebut.
- Shutdown menghentikan ingest lebih dahulu, lalu memberikan kesempatan delivery aktif selesai. Job yang belum diakui tetap berada di database untuk startup berikutnya. Deadline proses 25 detik; timeout/kill paksa dapat menyebabkan pengiriman diulang dengan ID yang sama.
- Backup konfigurasi dan outbox secara konsisten. Gunakan mekanisme backup SQLite atau hentikan service sebelum menyalin; file database utama saja bukan backup konsisten saat WAL masih aktif. Tetap jalankan satu instance.

## Verifikasi

| Pemeriksaan | Hasil |
| --- | --- |
| `npm test` pada Node 24.19.0 | 95 tes Node lulus; tanpa skip |
| `npm run check` | Semua modul server, termasuk controller/stats/outbox baru, lulus syntax check |
| `NODE_ENV=production npm run build` | Lulus |
| `npm run test:browser` | Login, realtime, status delivery, webhook validation/save/reload/cancel, mobile 390px dan logout lulus; tanpa runtime/CSP error |
| Python 3.12.14 dengan `requirements.lock` | 12 tes lulus, tanpa koneksi broadcaster eksternal |
| Integrasi proses produksi | Auth/origin, revocation lintas restart, API/WS, failed outbox lintas restart, readiness dan shutdown lulus |
| Uji antrean sintetis | 1.000 event ke dua destinasi menjadi 2.000 job tersimpan dan terkirim ke transport palsu; tidak ada job hilang/duplikat |
| Audit dependency | Audit npm/Python pada sesi ini melaporkan nol advisory; dependency dan lockfile tidak berubah oleh perbaikan |

Uji antrean sintetis menggunakan direktori sementara: commit 2.000 job memerlukan sekitar 47 ms, seluruh pengiriman palsu selesai sekitar 192 ms, RSS sekitar 49 MiB. Angka ini hanya pengamatan lokal; tidak mewakili throughput disk produksi, latensi HTTPS penerima, atau jaminan kapasitas/SLA.

## Batas yang masih berlaku

Outbox menyediakan **at-least-once untuk job yang berhasil dikomit**, bukan exactly-once. Crash setelah penerima memproses tetapi sebelum ack/delete lokal dapat menghasilkan replay. Receiver harus memverifikasi HMAC/timestamp, menyimpan deduplikasi `event.id` secara durable, serta mengakui job setelah pekerjaan diterima secara durable.

Storage gagal atau kapasitas habis menyebabkan penolakan enqueue yang terlihat di log/diagnostik; event yang ditolak belum tersimpan untuk replay. Event yang tidak pernah diterima saat TikTok/upstream terputus tidak dapat dipulihkan oleh outbox. Buffer Python tetap terbatas 2.000 event dan dapat overrun; upstream tanpa message ID tidak menjamin deduplikasi replay.

Perbaikan kode tidak membuktikan entitlement Eulerstream, akses jaringan deployment, atau penerimaan LIVE nyata. Sebelum rilis operasional, lakukan smoke pada HTTPS publik dengan broadcaster LIVE: chat, gift streak/non-streak, follow/share, akhir sesi, disconnect/restart, WebSocket consumer dan verifikasi HMAC receiver. Uji beban sesuai jumlah penonton/tujuan dan pastikan backup/restore disk bekerja. Reward/transaksi memerlukan validasi dan idempotency pada consumer; angka coins bukan bukti pembayaran.
