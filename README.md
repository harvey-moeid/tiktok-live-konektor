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

## External API v1

The service exposes a read-only API for other websites/applications. Dashboard authentication remains separate and LIVE start/stop/configuration are not exposed through this API.

Set these production variables:

- `API_KEY`: a dedicated random API key. Keep it separate from `JWT_SECRET` and `WS_TOKEN`.
- `API_ALLOWED_ORIGINS`: comma-separated browser origins allowed to call the REST API or open the realtime WebSocket, for example `https://app.example.com,https://www.example.com`.

Server-to-server requests do not send a browser `Origin` header, so they can use the API key without `API_ALLOWED_ORIGINS`.

### Authentication

Preferred:

```http
Authorization: Bearer YOUR_API_KEY
```

Also supported for REST:

```http
X-API-Key: YOUR_API_KEY
```

### GET /api/v1/status

Returns LIVE connection status, resolved room ID, last event time and current stats.

```js
const response = await fetch('https://tiktok-live-konektor.onrender.com/api/v1/status', {
  headers: { Authorization: 'Bearer YOUR_API_KEY' }
});
const live = await response.json();
```

### GET /api/v1/stats

Returns current chat, likes, gifts, coins, follows and viewer counters.

### GET /api/v1/events

Returns recent normalized events. Query parameters:

- `type`: comma-separated event types such as `chat,like,gift`.
- `limit`: 1-200, default 50.
- `before`: optional ISO timestamp for pagination.

Example:

```text
GET /api/v1/events?type=chat,like&limit=20
```

Example event:

```json
{
  "id": "event-uuid",
  "event": "chat",
  "timestamp": "2026-10-06T16:32:13.282Z",
  "roomId": "7693584931198438164",
  "username": "leviailabs",
  "data": {
    "username": "viewer",
    "nickname": "Viewer Name",
    "message": "halo"
  }
}
```

### Realtime chat, like, and gift

For a consumer that only needs the three main interaction events, filter the WebSocket connection:

```text
wss://tiktok-live-konektor.onrender.com/live?key=YOUR_API_KEY&events=chat,like,gift
```

Browser example:

```js
const ws = new WebSocket(
  'wss://tiktok-live-konektor.onrender.com/live?key=YOUR_API_KEY&events=chat,like,gift'
);

ws.onmessage = ({ data }) => {
  const event = JSON.parse(data);

  if (event.event === 'chat') {
    console.log(event.data.nickname, event.data.message);
  }

  if (event.event === 'like') {
    console.log(event.data.nickname, event.data.likeCount);
  }

  if (event.event === 'gift') {
    console.log(
      event.data.nickname,
      event.data.giftName,
      event.data.repeatCount,
      event.data.totalValue
    );
  }
};

ws.onclose = () => {
  console.log('TikTok realtime connection closed');
};
```

The `events` query can contain any supported public event type. If omitted, the connection remains backward-compatible and receives all normalized external events.

For public browser applications, do not treat a key embedded in frontend JavaScript as a secret. Prefer a backend/BFF in the consuming website that connects to this service and relays only the data the browser needs. `API_ALLOWED_ORIGINS` still restricts browser-origin WebSocket connections.

### Realtime WebSocket

Use:

```text
wss://tiktok-live-konektor.onrender.com/live?key=YOUR_API_KEY
```

Each message is the same normalized JSON event format returned by `/api/v1/events`.

For browser apps, configure the exact website origin in `API_ALLOWED_ORIGINS`. Do not embed a private production API key in public frontend JavaScript when the website is accessible to untrusted users; prefer calling this API from your own backend/proxy. The WebSocket query-key mode is intended for controlled clients and read-only integrations.

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

When **START LIVE** is requested, the server uses a layered resolver:

1. A manual Room ID from the dashboard is used when present.
2. Otherwise `fetchRoomId()` runs the connector's native composite resolver (TikTok HTML/API and Euler fallback when available).
3. If the native resolver still fails, the service performs a strict direct `@username/live` HTML probe with browser-like headers and parses only known LIVE Room ID fields, including escaped JSON/HTML-entity variants.
4. Once a Room ID is resolved, `connect(roomId)` is used so the connection does not repeat Room ID discovery.
5. `fetchRoomInfoOnConnect` remains enabled so the resolved room is still validated as a LIVE room.

If `EULER_API_KEY` is configured, it is passed as `signApiKey` to the connector. On datacenter/cloud IPs, TikTok may still block or omit LIVE metadata; in that case Euler or a current manual Room ID can be used without weakening the strict Room ID validation.

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
