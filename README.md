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
- `EULER_API_KEY`: strongly recommended on cloud hosts for reliable Room ID resolution/signing; a Community key is sufficient for normal use.

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

When **START LIVE** is requested, the server delegates discovery to `tiktok-live-connector` v2.5:

1. A manual Room ID from the dashboard is used when present.
2. Otherwise `connect()` resolves the Room ID from the TikTok username using the connector's composite resolver.
3. If `EULER_API_KEY` is configured, it is passed as `signApiKey` so the connector can use Euler Stream for reliable cloud-hosted resolution/signing.
4. `fetchRoomInfoOnConnect` remains enabled so a connection is accepted only for a valid LIVE room.

On datacenter/cloud IPs, TikTok HTML/API discovery can return a normal page without usable LIVE metadata. In that case configure `EULER_API_KEY` rather than guessing a generic numeric TikTok ID.

`tiktok-live-connector` is unofficial. Extended gift info remains disabled by default.

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
