# TikTok Live Konektor

Realtime TikTok LIVE bridge: Express + React/Vite + Socket.IO + external WebSocket + webhook retry/filter + JWT auth + Render + GitHub Actions.

Run: `npm install && npm run dev`

Production: `npm install && npm run build && npm start`

External WebSocket: `wss://DOMAIN/live?token=YOUR_WS_TOKEN`

TikTok connector is unofficial.

## Euler signing

Set `EULER_API_KEY` in the Render environment when TikTok room discovery reports `Failed to retrieve Room ID from all sources`. The connector passes this key to the Euler signing fallback without exposing it to the browser.
