# TikTok Live Konektor

Realtime TikTok LIVE bridge: Express + React/Vite + Socket.IO + external WebSocket + webhook retry/filter + JWT auth + Render + GitHub Actions.

Run: `npm install && npm run dev`

Production: `npm install && npm run build && npm start`

External WebSocket: `wss://DOMAIN/live?token=YOUR_WS_TOKEN`

TikTok connector is unofficial.

## Automatic Room ID discovery

Saat **START LIVE**, server sekarang memakai urutan:

1. Room ID manual dari dashboard (jika diisi).
2. `tiktok-live-connector.fetchRoomId()`.
3. Fallback langsung ke halaman `@username/live` TikTok dengan browser-like headers dan ekstraksi Room ID dari HTML.
4. Jika Room ID ditemukan, server memanggil `connect(roomId)` sehingga proses scraping Room ID di dalam connect dilewati.

Library resmi connector memang mendukung `fetchRoomId()` dan `connect(roomId)`; Room ID manual/hasil discovery hanya berlaku untuk sesi LIVE tersebut. citeturn0search0turn0search4

Jika ketiga jalur gagal, kemungkinan halaman LIVE TikTok tidak dapat diakses dari jaringan/egress Render, akun belum LIVE, atau TikTok tidak lagi memberikan Room ID pada respons tersebut. Dashboard akan menampilkan detail error.

## TikTok signing / free mode

The connector intentionally does **not** send `EULER_API_KEY` and does not enable `enableExtendedGiftInfo`. This avoids paid Euler Business-only routes and keeps the project from attempting to bypass a provider paywall.

If anonymous signing itself is rejected by TikTok/Euler, successful Room ID discovery will not by itself solve the WebSocket signing/handshake step. In that case use a supported signing plan or a compatible self-hosted/custom signing provider.

## Diagnostics

Connection failures preserve structured error details when the connector exposes them. The dashboard shows the returned error instead of only a generic Room ID message.