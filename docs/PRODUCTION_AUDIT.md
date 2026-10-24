# Audit backend dan frontend

Audit dilakukan 10 Oktober 2026. Perubahan telah divalidasi pada Node.js 24 dan Python 3.12. Status: perbaikan kode dan konfigurasi deployment tersedia; deployment publik dan penerimaan TikTok LIVE nyata belum diverifikasi.

## Temuan dan perbaikan

| Prioritas | Temuan | Perbaikan |
| --- | --- | --- |
| Tinggi | JWT tetap berlaku setelah logout/perubahan password; Socket.IO tidak memeriksa kedaluwarsa setelah tersambung | Logout disimpan sebagai pencabutan sesi; password version membatalkan sesi lama; socket dicabut saat logout/perubahan password dan dicek setiap 30 detik |
| Tinggi | Webhook menerima jaringan privat melalui IP atau DNS | Validasi URL bersama frontend/backend, penolakan IP literal, pemeriksaan semua jawaban DNS, koneksi TLS ke alamat publik yang dipin, tanpa redirect |
| Tinggi | Webhook produksi tidak memiliki bukti autentikasi payload | HMAC-SHA256 dengan secret terpisah, timestamp dan body mentah; secret wajib sebelum mengaktifkan webhook produksi |
| Tinggi | Frame WebSocket terlalu besar berpotensi menghasilkan error tanpa handler | Handler error dan batas payload; koneksi ditutup tanpa menjatuhkan server |
| Sedang | Origin admin tidak diperiksa pada REST/Socket.IO | Penolakan origin berbeda dan browser cross-site; API eksternal tetap memakai allowlist khusus |
| Sedang | Rate limit WS mempercayai X-Forwarded-For seluruhnya | Resolusi IP menurut jumlah proxy terpercaya yang sama dengan Express |
| Sedang | Pengiriman webhook dan buffer klien lambat tidak dibatasi | Empat delivery aktif, 200 menunggu, overflow dicatat; klien WS dengan buffer di atas 1 MiB diputus |
| Sedang | Penulisan konfigurasi bisa gagal tetapi dilaporkan berhasil | Write file sementara berizin 0600 dan rename atomik; kegagalan tidak mengubah state |
| Sedang | Diagnostik upstream dapat membawa kredensial | Redaksi secret, header, URL credential dan konfigurasi nested; respons LIVE tidak mengembalikan raw cause |
| Sedang | Instalasi tidak reproducible dan Blueprint yang dirujuk tidak tersedia | package-lock.json, npm ci, Python requirements.lock, Blueprint Node dan Python opsional |
| Fungsional | Proxy Vite gagal saat npm run dev | ws:true dipindah ke konfigurasi proxy /socket.io |
| Fungsional | Frontend salah memperlakukan gangguan jaringan sebagai logout dan bisa menyimpan config sebelum termuat | Penanganan 401 terpusat, retry state, tombol config menunggu data, submit login dibatasi |

## Validasi

- 61 pengujian Node: normalisasi event, gift, gateway, webhook, history, keamanan dan integrasi server produksi; tidak ada tes dilewati.
- 10 pengujian Python: normalisasi, health, autentikasi endpoint, validasi username dan shutdown bridge.
- Build frontend dengan NODE_ENV=production.
- Chromium headless: login salah/benar, Socket.IO, validasi webhook privat, simpan/reload/batalkan, viewport mobile 390px dan logout; tidak ada error JavaScript atau CSP.
- Integrasi produksi: cookie Secure/HttpOnly, API key, origin asing, JSON invalid, pencabutan sesi lintas restart, perubahan password, frame WS berlebihan dan shutdown dengan koneksi terbuka.
- npm audit seluruh dependency: tidak ada kerentanan yang diketahui; gate high/critical tidak menggunakan pengecualian advisory.
- pip-audit seluruh dependency Python yang dipin: tidak ada kerentanan yang diketahui.
- Instalasi npm ci dan Python lockfile, serta startup development standar, diverifikasi di lingkungan ini.

Jalankan ulang:

```bash
npm ci --include=dev
npm test
NODE_ENV=production npm run build
CHROMIUM_PATH=/usr/bin/chromium npm run test:browser
python -m pip install -r python_fallback/requirements.lock
python -m unittest discover -s python_fallback -p 'test_*.py'
```

Browser smoke membutuhkan Chromium; path juga dideteksi otomatis untuk instalasi Chromium/Google Chrome Linux standar. CI memakai Node 24, npm ci, test, build dan browser smoke. Job Python memakai requirements.lock.

## Langkah produksi yang masih diperlukan

1. Review dan commit perubahan; deploy render.yaml atau platform dengan Node 24, npm ci --include=dev, npm run build dan npm start. Blueprint memakai Starter berbayar dan disk persisten; file Python terpisah hanya diperlukan untuk fallback.
2. Gunakan HTTPS dan satu instance Node. Isi ADMIN_USERNAME, ADMIN_PASSWORD awal (12+ karakter, maksimum 72 byte UTF-8), JWT_SECRET dan WS_TOKEN (32+ karakter). Isi API_KEY untuk API eksternal. Blueprint menghasilkan secret secara aman; jangan menggunakan placeholder .env.example. ADMIN_PASSWORD hanya dipakai saat belum ada hash tersimpan.
3. Simpan CONFIG_FILE pada disk persisten dan backup secara aman: file berisi hash password, token WS, konfigurasi webhook dan pencabutan sesi. Pada startup dengan konfigurasi lama, siapkan WEBHOOK_SIGNING_SECRET sebelum menjalankan webhook aktif. Semua sesi JWT format lama harus login kembali setelah upgrade.
4. Sesuaikan TRUST_PROXY: 1 untuk satu proxy Render yang menimpa header forwarding; 0 untuk server langsung. Batasi API_ALLOWED_ORIGINS pada website consumer yang diizinkan. Origin dashboard harus sama dengan server.
5. Isi EULER_API_KEY dan TIKTOK_USERNAME, pastikan akses signer/gateway sesuai paket Eulerstream, lalu uji Start LIVE saat broadcaster benar-benar LIVE. Firewall/allowlist harus mengizinkan destination TikTok dan transport Eulerstream yang dipilih.
6. Verifikasi HMAC di penerima webhook, timestamp dalam toleransi 5 menit dan deduplikasi event.id. Uji pengiriman nyata ke destination milik Anda. Jika memakai Python, isi URL HTTPS publik dan matching token kedua service; uji status engine python.
7. Jalankan smoke pada URL deployment publik: health, login, Socket.IO, API eksternal, Start/Stop LIVE dan webhook. Periksa log, kapasitas dan restart platform.

## Batas operasional

- Tidak ada deployment, push Git, pengiriman webhook ke pihak lain, atau koneksi broadcaster nyata yang dilakukan dalam audit ini.
- Health menunjukkan proses tersedia, bukan bukti koneksi TikTok LIVE aktif atau signing entitlement.
- State LIVE dan history berada dalam memori; tidak mendukung banyak replica. Persistent disk mencegah hilangnya perubahan password/webhook/revocation saat restart.
- Webhook bersifat best-effort; antrean tidak persisten, overflow/restart dapat kehilangan delivery. Reward/transaksi harus memiliki validasi dan idempotency di consumer; kebutuhan delivery tahan gangguan memerlukan antrean durable pada pekerjaan terpisah.
- Pemeriksaan dependency menemukan advisory yang tersedia saat audit; hasil nol tidak menjamin tidak ada kerentanan yang belum diketahui.
