# TikTok Live Konektor

Realtime TikTok LIVE bridge: Express + React/Vite + Socket.IO + external WebSocket + webhook retry/filter + JWT auth + Render + GitHub Actions.

## Run

Development:

```bash
npm ci
npm run dev
```

Production build:

```bash
NODE_ENV=production npm ci --include=dev
npm run build
npm start
```

The repository includes a project `.npmrc` with `include=dev` because Vite and the React plugin are build-time dependencies. This prevents hosts such as Render from omitting the Vite toolchain when `NODE_ENV=production` is present during the build phase.

Health check: `GET /api/health`

## Required production environment

- `JWT_SECRET`: random secret, minimum 32 characters; placeholder values are rejected.
- `ADMIN_USERNAME`: dashboard username.
- `ADMIN_PASSWORD`: first-startup dashboard password, minimum 12 characters and maximum 72 UTF-8 bytes; placeholder values are rejected.
- `WS_TOKEN`: independent random token, minimum 32 characters, for the external WebSocket.
- `TIKTOK_USERNAME`: default TikTok username.
- `EULER_API_KEY`: server-side Eulerstream API key. A Community key does NOT authorize Business signing, but can be used for the separate managed Cloud WebSocket fallback implemented here. Actual access and quotas depend on your Eulerstream account.

Optional runtime controls are documented in `.env.example`, including `TIKTOK_ROOM_ID`, `MAX_FEED_EVENTS`, `MAX_EVENT_BYTES`, `TIKTOK_HTTP_TIMEOUT_MS`, `WEBHOOK_TIMEOUT_MS`, `WEBHOOK_RETRIES`, and `TIKTOK_DEBUG`.

Dashboard settings are persisted to `CONFIG_FILE`. If the deployment platform uses an ephemeral filesystem, treat environment variables as the durable baseline or attach persistent storage.

## Documentation for integrating other websites

For a complete Indonesian guide to connecting additional websites using REST API, realtime WebSocket, Cloudflare Worker, webhooks and security practices, see **[docs/INTEGRASI_WEBSITE.md](docs/INTEGRASI_WEBSITE.md)**.

> Production note: do not embed a private API key into public frontend code or public WebSocket URLs. The browser sample below is for controlled/test clients; use a backend relay for public websites.

## Webhook settings in the admin dashboard

After logging in as admin, open **Integrasi Webhook** from the dashboard navigation. Add up to 20 HTTPS destinations, enable/disable each target, select event types (empty selection = all events), include optional custom event names, remove destinations, and click **Simpan webhook**. Edits are local drafts until saved; **Batalkan** reverts them. This UI uses the admin-cookie-protected `PUT /api/webhooks` endpoint which changes only `webhooks`, so unsaved LIVE username/Room ID edits will not be overwritten.

Production webhook delivery requires `WEBHOOK_SIGNING_SECRET` (32+ characters) and includes HMAC-SHA256 over `timestamp.rawBody`. The receiver must verify the signature, check timestamp freshness, and deduplicate event IDs. See [docs/INTEGRASI_WEBSITE.md](docs/INTEGRASI_WEBSITE.md) for the full guidance.

## Menghapus riwayat Aktivitas LIVE (admin)

Pada tab **Aktivitas LIVE**, gunakan tombol **🗑 Hapus** untuk satu event atau **🗑 Hapus Semua** untuk seluruh riwayat, termasuk event yang saat ini tersembunyi oleh filter. Browser meminta konfirmasi sebelum melakukan penghapusan. Semua perubahan tersinkron ke dashboard admin lain melalui Socket.IO, termasuk setelah reconnect.

- `DELETE /api/events/:id` — hapus satu aktivitas berdasarkan ID. Respons 400 bila ID tidak valid dan 404 bila sudah tidak ada.
- `DELETE /api/events` — hapus seluruh riwayat; respons berisi jumlah event yang dihapus.
- Kedua endpoint membutuhkan sesi login admin (`tlk_session`). API publik `/api/v1` tetap **read-only**.
- Penghapusan hanya memengaruhi feed yang disimpan sementara **di memori server**; tidak mengubah statistik LIVE, koneksi, penghitung gift, atau pengiriman webhook yang sudah terjadi. Event LIVE baru akan tetap masuk seperti biasa. Tidak ada penyimpanan riwayat permanen: restart proses server juga mengosongkan feed.

## External API v1

The service exposes a read-only API for other websites/applications. Dashboard authentication remains separate and LIVE start/stop/configuration are not exposed through this API.

Set these production variables:

- `API_KEY`: a dedicated random API key, minimum 32 characters. Keep it separate from `JWT_SECRET` and `WS_TOKEN`.
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

If `EULER_API_KEY` is configured, it is passed as `signApiKey` to the connector. On datacenter/cloud IPs, TikTok may still block or omit LIVE metadata. A current manual Room ID can help with *discovery*, but it **cannot** replace WebSocket signing or override an Eulerstream Business-plan requirement.

\`tiktok-live-connector\` is unofficial. Extended gift info is **enabled** by default in the Node engine to fetch names, coin values and other gift metadata. TikTok may still omit metadata or block the room's gift catalogue; enrichment is best-effort and does not guarantee names for every gift.

### Error: `fetchWebcastSignatureFromEulerRoute` requires a Business plan

If the LIVE dashboard shows `This endpoint requires a Business plan`, Eulerstream has **denied signature access** to the API key/route used by the Node connector. This is **not** an incorrect TikTok username, gift name, Room ID or webhook error, and it is not resolved by repeatedly restarting the app. This connector currently uses a signed WebSocket route; it does not implement an unsigned HTTP polling transport.

- **Paid path:** confirm the Eulerstream account has access to TikTok LIVE Signature routes (see [Eulerstream pricing](https://www.eulerstream.com/pricing)); use a properly entitled API key server-side.
- **Alternative path:** configure `PYTHON_FALLBACK_URL` and `PYTHON_FALLBACK_TOKEN` and deploy the separate Python bridge below. Node automatically attempts Python if signing fails; Python uses its own TikTokLive connection machinery, **but is not guaranteed to bypass signer entitlements or TikTok restrictions**.
- **Community managed WebSockets:** Eulerstream lists hosted Cloud WebSockets separately from its Business-only signature route. The connector now **automatically tries this separate Cloud WebSocket when the Node signer returns the Business-plan error and `EULER_API_KEY` is configured**. This is not an override of the signing endpoint, and connection success still depends on the Cloud WebSocket service accepting your API key and TikTok LIVE being active.

The dashboard distinguishes entitlement errors from Room ID resolution errors. The connection sequence is **Node → Cloud WebSocket on Business-plan errors → optional Python fallback**. The status API returns `engine: managed` when the Cloud WebSocket connects, and the normalized event shape remains unchanged. If all sources fail, the connector cannot receive LIVE events until a working authorized connection method is configured.

The managed gateway may send a `room.status` confirmation, a `roomInfo` envelope, or real webcast events without an explicit status handshake. All three are now supported as evidence of an active LIVE session. A bare WebSocket `open` or gateway `tiktok.connect` message is **not** enough to mark a TikTok stream LIVE. On timeout, Render logs a sanitized handshake diagnostic (`opened`, number of frames, parsed event kinds) without recording API keys, raw frames, or viewer messages. These diagnostics distinguish a network handshake failure from a connected-but-silent stream or an unrecognized gateway payload. Check the account is actively broadcasting and Eulerstream Cloud WebSocket permissions if it still fails. Normalized webhook/event contracts remain unchanged.

### Resolving LIVE gift names

Gift events always include \`data.giftName\` and now also include \`data.giftId\` (string or null). Existing webhook, dashboard, WebSocket and overlay consumers can continue using the same \`giftName\` field. The Node engine checks current/legacy fields such as \`giftName\`, \`giftDetails.giftName\`, \`gift.name\` and \`extendedGiftInfo.name\`, then remembers confirmed names by gift ID for the current connection. The Python fallback reads its gift name/ID fields independently.

When TikTok supplies a gift ID but no name, the connector reports \`Gift #5953\` (using the actual ID). When neither is present, it reports \`Gift tidak dikenal\`. It **does not invent a gift name**; if an overlay requires a specific named gift, trigger rules should also support stable gift IDs. Existing event keys including \`repeatCount\`, \`repeatEnd\`, \`giftType\`, \`diamondCount\` and \`totalValue\` are preserved.

## Runtime hardening

- Feed events are normalized and size-bounded before entering in-memory history, Socket.IO, external WebSocket, or webhook delivery.
- `/api/state` does not include the complete event history; history is delivered separately over Socket.IO.
- Webhooks must use public HTTPS URLs, redirects are rejected, and delivery has bounded retry/timeout behavior.
- TikTok HTTP discovery and WebSocket handshake have bounded timeouts.
- High-volume raw/protobuf diagnostic logging is disabled by default. Set `TIKTOK_DEBUG=true` only while troubleshooting.
- Login and external WebSocket connection attempts have dedicated rate limits.
- Graceful shutdown disconnects the TikTok connector before the server exits.

## CI and security

`CI` tests Node 24, builds the Vite client, and separately reproduces a Render-style build with `NODE_ENV=production`. `Security` runs on pushes, pull requests, manual dispatch, and a weekly schedule. High/critical runtime advisories fail the security job.

## Python LIVE fallback (optional)

The primary engine remains Node.js (`tiktok-live-connector`). If **Start LIVE** fails during Room ID discovery or connection, the Node server **automatically tries the separate Python engine** using [TikTokLive](https://pypi.org/project/TikTokLive/) 7.0.1. Once connected, Python's comments, likes, gifts, follows, shares, joins and viewers are normalized into the **same** existing dashboard, webhook, `/api/v1/events`, Socket.IO and `/live` WebSocket pipeline. The UI/API `engine` field is `node`, `python`, or `none`.

This is **an alternative engine, not an unconditional bypass for TikTok restrictions**. Both engines still require the broadcaster to be actively LIVE and may be blocked from the same hosting-provider IP range. Python re-resolves by **username**, even if a manual Node Room ID was entered; it does not reuse potentially stale manual IDs. Failover is performed on manual **Start LIVE**; reconnecting after a successful stream later ends requires starting it again.

### Deployment on Render

1. Deploy `render.yaml` for the primary Node service. It uses a paid Starter instance and persistent configuration disk. Deploy the separate optional `render-python.yaml` Blueprint only if Python fallback is needed; it also uses a paid Starter instance.
2. The Python Blueprint generates `PYTHON_BRIDGE_TOKEN`. Set Node's `PYTHON_FALLBACK_TOKEN` to the same value securely in Render settings, and `PYTHON_FALLBACK_URL` to Python's public HTTPS origin. These separate Blueprints do not wire the services automatically. **Do not publish tokens.**
3. Node calls the optional Python bridge over `https://<python hostname>` with bearer authentication. A free service may spin down and require extra time to start; for always-on production, consider paid instances.
4. If provisioning services manually, deploy Python with:
   - Runtime Python 3.12; build `pip install -r python_fallback/requirements.lock`
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

## Production deployment and audit

See [production audit and deployment checks](docs/PRODUCTION_AUDIT.md). Run a single Node instance: LIVE state, session socket tracking, rate limits and event history are process-local. Keep `CONFIG_FILE` on durable storage for password changes, logout revocations and webhook settings. `TRUST_PROXY=1` assumes one trusted reverse proxy that overwrites forwarding headers; use `0` when serving directly. Production requires HTTPS.

Dashboard requests and Socket.IO handshakes must come from the same origin. Logout revokes the current session; password changes revoke all sessions. JWT expiration is rechecked on Socket.IO connections every 30 seconds. Config writes are atomic and errors are reported. Webhooks require public HTTPS DNS names; private, local and IP-literal targets are rejected, DNS answers are validated and pinned for each connection, redirects are rejected. Delivery is bounded to four concurrent jobs and 200 waiting jobs; overflow is logged and dropped.
