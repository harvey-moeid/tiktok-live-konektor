# TikTok Live Konektor

Realtime TikTok LIVE bridge: Express + React/Vite + Socket.IO + external WebSocket + webhook retry/filter + JWT auth + Render + GitHub Actions.

## Run

Development:

```bash
npm install
npm run dev
```

Production build:

```bash
NODE_ENV=production npm install --include=dev
npm run build
npm start
```

The repository includes a project `.npmrc` with `include=dev` because Vite and the React plugin are build-time dependencies. This prevents hosts such as Render from omitting the Vite toolchain when `NODE_ENV=production` is present during the build phase.

Health check: `GET /api/health`

## Required production environment

- `JWT_SECRET`: random secret, minimum 32 characters.
- `ADMIN_USERNAME`: dashboard username.
- `ADMIN_PASSWORD`: dashboard password used on first startup when no stored password hash exists.
- `WS_TOKEN`: long random token for the external WebSocket.
- `TIKTOK_USERNAME`: default TikTok username.

Optional runtime controls are documented in `.env.example`, including `TIKTOK_ROOM_ID`, `MAX_FEED_EVENTS`, `MAX_EVENT_BYTES`, `TIKTOK_HTTP_TIMEOUT_MS`, `WEBHOOK_TIMEOUT_MS`, `WEBHOOK_RETRIES`, and `TIKTOK_DEBUG`.

Dashboard settings are persisted to `CONFIG_FILE`. If the deployment platform uses an ephemeral filesystem, treat environment variables as the durable baseline or attach persistent storage.

## External WebSocket

Endpoint: `wss://DOMAIN/live`.

Preferred authentication for clients that can set headers:

```text
Authorization: Bearer YOUR_WS_TOKEN
```

For browser WebSocket clients that cannot set an Authorization header, the compatibility form remains available:

```text
wss://DOMAIN/live?token=YOUR_WS_TOKEN
```

Connection attempts are rate-limited and tokens are compared using a timing-safe check.

## Automatic Room ID discovery

When **START LIVE** is requested, the server uses this order:

1. Manual Room ID from the dashboard, when present.
2. `tiktok-live-connector.fetchRoomId()`.
3. Direct fallback to the TikTok `@username/live` page using browser-like headers.
4. `connect(roomId)` after a Room ID is resolved.

If discovery fails, the account may not be LIVE, TikTok may reject the deployment network, or TikTok may have changed the page/handshake behavior. A manual Room ID can still be supplied.

`tiktok-live-connector` is unofficial. The application intentionally does not provide an Euler API key and does not enable extended gift info by default.

## Runtime hardening

- Feed events are normalized and size-bounded before entering in-memory history, Socket.IO, external WebSocket, or webhook delivery.
- `/api/state` does not include the complete event history; history is delivered separately over Socket.IO.
- Webhooks must use public HTTPS URLs, redirects are rejected, and delivery has bounded retry/timeout behavior.
- TikTok HTTP discovery and WebSocket handshake have bounded timeouts.
- High-volume raw/protobuf diagnostic logging is disabled by default. Set `TIKTOK_DEBUG=true` only while troubleshooting.
- Login and external WebSocket connection attempts have dedicated rate limits.
- Graceful shutdown disconnects the TikTok connector before the server exits.

## CI and security

`CI` tests Node 20, 22, and 24, builds the Vite client, and separately reproduces a Render-style build with `NODE_ENV=production`. `Security` runs on pushes, pull requests, manual dispatch, and a weekly schedule. High/critical runtime advisories fail the security job unless they match the single explicitly approved advisory chain in `scripts/security-audit.mjs`.
