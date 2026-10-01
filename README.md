# TikTok Live Konektor

Realtime TikTok LIVE bridge: Express + React/Vite + Socket.IO + external WebSocket + webhook retry/filter + JWT auth + Render + GitHub Actions.

Run: `npm install && npm run dev`

Production: `npm install && npm run build && npm start`

External WebSocket: `wss://DOMAIN/live?token=YOUR_WS_TOKEN`

TikTok connector is unofficial.

## Room ID fallback

Jika muncul `Failed to retrieve Room ID from all sources`, dashboard sekarang menyediakan kolom **Room ID (opsional)**. Isi Room ID livestream yang sedang aktif lalu tekan **SIMPAN** dan **START LIVE**. Library TikTok Live Connector mendukung `connect(roomId)`, sehingga koneksi dapat melewati proses pencarian Room ID otomatis.

Room ID bersifat spesifik untuk sesi livestream. Jika TikTok membuat Room ID baru pada live berikutnya, nilai tersebut perlu diperbarui.

## TikTok signing / free mode

The connector intentionally does **not** send `EULER_API_KEY` and does not enable `enableExtendedGiftInfo`. This avoids paid Euler Business-only routes and keeps the project from attempting to bypass a provider paywall.

If anonymous signing itself is rejected by TikTok/Euler, an explicit Room ID only solves the Room ID discovery step; WebSocket signing can still be a separate blocker. In that case use a supported signing plan or a compatible self-hosted/custom signing provider.

## Diagnostics

Connection failures now preserve structured error details when the connector exposes them. The dashboard shows the returned error instead of only a generic Room ID message, making Render logs and the UI more useful for troubleshooting.