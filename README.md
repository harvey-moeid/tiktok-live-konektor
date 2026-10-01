# TikTok Live Konektor

Realtime TikTok LIVE bridge: Express + React/Vite + Socket.IO + external WebSocket + webhook retry/filter + JWT auth + Render + GitHub Actions.

Run: `npm install && npm run dev`

Production: `npm install && npm run build && npm start`

External WebSocket: `wss://DOMAIN/live?token=YOUR_WS_TOKEN`

TikTok connector is unofficial.

## TikTok signing / free mode

The connector intentionally does **not** send `EULER_API_KEY` and does not enable `enableExtendedGiftInfo`. This keeps the normal connection path on Euler Stream's anonymous/community signing flow and avoids paid Business-only routes.

Do not add an Euler API key to Render unless a paid Euler feature is intentionally required. Euler documents that signature/premium routes can require paid plans, while the TikTok Live Connector documents anonymous/community WebSocket signing with free limits.

Gift events are still received through the LIVE WebSocket. Extended gift-catalog metadata (such as a guaranteed catalog name/image/cost lookup) is intentionally disabled because that lookup can hit a Business-only route.

If anonymous signing itself is rejected by Euler/TikTok, the remaining options are to use a supported paid signing plan or provide a compatible self-hosted/custom signing provider through the connector's route configuration; the project does not attempt to bypass a provider paywall.
