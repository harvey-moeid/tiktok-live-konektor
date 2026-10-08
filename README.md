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

## Documentation for integrating other websites

For a complete Indonesian guide to connecting additional websites using REST API, realtime WebSocket, Cloudflare Worker, webhooks and security practices, see **[docs/INTEGRASI_WEBSITE.md](docs/INTEGRASI_WEBSITE.md)**.

> Production note: do not embed a private API key into public frontend code or public WebSocket URLs. The browser sample below is for controlled/test clients; use a backend relay for public websites.

## Webhook settings in the admin dashboard

After logging in as admin, open **Integrasi Webhook** from the dashboard navigation. Add up to 20 HTTPS destinations, enable/disable each target, select event types (empty selection = all events), include optional custom event names, remove destinations, and click **Simpan webhook**. Edits are local drafts until saved; **Batalkan** reverts them. This UI uses the admin-cookie-protected `PUT /api/webhooks` endpoint which changes only `webhooks`, so unsaved LIVE username/Room ID edits will not be overwritten.

The webhook sender currently does **not** sign payloads with HMAC. Use a securely protected receiver and verify each delivery independently. See [docs/INTEGRASI_WEBSITE.md](docs/INTEGRASI_WEBSITE.md) for the full guidance.

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

## Python LIVE fallback (optional)

The primary engine remains Node.js (`tiktok-live-connector`). If **Start LIVE** fails during Room ID discovery or connection, the Node server **automatically tries the separate Python engine** using [TikTokLive](https://pypi.org/project/TikTokLive/) 7.0.1. Once connected, Python's comments, likes, gifts, follows, shares, joins and viewers are normalized into the **same** existing dashboard, webhook, `/api/v1/events`, Socket.IO and `/live` WebSocket pipeline. The UI/API `engine` field is `node`, `python`, or `none`.

This is **an alternative engine, not an unconditional bypass for TikTok restrictions**. Both engines still require the broadcaster to be actively LIVE and may be blocked from the same hosting-provider IP range. Python re-resolves by **username**, even if a manual Node Room ID was entered; it does not reuse potentially stale manual IDs. Failover is performed on manual **Start LIVE**; reconnecting after a successful stream later ends requires starting it again.

### Deployment on Render

1. Sync the updated `render.yaml` Blueprint: it defines two web services in the same repository, `tiktok-live-konektor` (Node) and `tiktok-live-python` (Python). Both are set to free as a development default.
2. The Blueprint generates the secret `PYTHON_BRIDGE_TOKEN` on the Python service and references it in the Node service as `PYTHON_FALLBACK_TOKEN`. It also resolves Python's `RENDER_EXTERNAL_HOSTNAME` into `PYTHON_FALLBACK_HOSTNAME` on Node. **Do not publish tokens.**
3. Render free web services **cannot receive private-network connections**. Node therefore calls Python over `https://<python hostname>` with bearer authentication. A free service may spin down and require extra time to start; for always-on production, consider paid instances.
4. If provisioning services manually, deploy Python with:
   - Runtime Python 3.12; build `pip install -r python_fallback/requirements.txt`
   - Start `uvicorn python_fallback.app:app --host 0.0.0.0 --port $PORT`
   - `PYTHON_BRIDGE_TOKEN` set to a random secret of at least 32 characters
   - Set on Node: `PYTHON_FALLBACK_URL=https://<python-service>.onrender.com` and `PYTHON_FALLBACK_TOKEN` to **the same** token
5. Confirm the Python `/health` endpoint returns `{"ok":true}`. Log into the existing dashboard and click **Start LIVE** while `@jalurtarot` is broadcasting. Check `engine` from `/api/health` or authenticated `/api/v1/status`.

Fallback is disabled unless the URL/hostname **and** token are configured. No Python runtime is required on the existing Node instance. Python control and event endpoints demand bearer authentication; only `/health` is public. Do not put bridge tokens in browser-side code.

### Limitations and observability

- The service buffers up to 2,000 events, retrieving up to 200 per poll and catching up immediately when needed. An overloaded/disconnected poll can lose events; Node logs a buffer-overrun warning.
- If Python disconnects, the bridge reports the disconnected state instead of falsely continuing to show LIVE.
- Both free services can sleep, and a public HTTPS request to a sleeping Python instance may exceed the initial connection timeout. Retrying **Start LIVE** is safe.
- Python fallback is only a secondary source; it does not cure TikTok anti-bot blocks, expired sessions, offline channels, or upstream signing outages.
