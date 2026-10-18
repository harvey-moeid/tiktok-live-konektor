import http from 'node:http';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import express from 'express';
import helmet from 'helmet';
import cookieParser from 'cookie-parser';
import rateLimit from 'express-rate-limit';
import { Server as SocketIO } from 'socket.io';
import { getConfig, getSafeConfig, updateConfig } from './config.js';
import { login, verify, setPassword, revokeSession } from './auth.js';
import { dispatchWebhook, normalizeWebhooks, initializeWebhooks, reconcileWebhooks, webhookStatus, retryWebhooks, closeWebhooks } from './webhooks.js';
import { attachExternalWs, closeExternalWs } from './ws.js';
import { TikTokService } from './tiktok.js';
import { ManagedLiveConnection } from './managed-live.js';
import { LiveController } from './live-controller.js';
import { LiveStats } from './stats.js';
import { normalizeEvent } from './events.js';
import { removeHistoryEvent } from './history.js';
import { broadcast } from './ws.js';
import { PythonLiveFallback } from './python-fallback.js';
import { apiAuth, externalCors, isAllowedWsOrigin } from './api-auth.js';
import { sameOrigin, protectAdminOrigin, trustProxy } from './security.js';
import { redactText } from './diagnostics.js';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
if (process.env.NODE_ENV === 'production') normalizeWebhooks(getConfig().webhooks);
const dist = path.join(root, 'client', 'dist');
const app = express();
app.set('trust proxy', trustProxy());
const server = http.createServer(app);
const io = new SocketIO(server, {
  path: '/socket.io', maxHttpBufferSize: 256 * 1024,
  allowRequest: (req, done) => done(null, sameOrigin(req))
});
function disconnectSessions(predicate) {
  for (const socket of io.sockets.sockets.values()) {
    if (predicate(socket.data.claims)) socket.disconnect(true);
  }
}

app.use(helmet({ crossOriginEmbedderPolicy: false }));
app.use(express.json({ limit: '64kb' }));
app.use(cookieParser());
app.use('/api', (_req, res, next) => { res.setHeader('Cache-Control', 'no-store'); next(); });
for (const route of ['/api/auth', '/api/config', '/api/webhooks', '/api/events', '/api/live', '/api/state']) {
  app.use(route, protectAdminOrigin);
}
app.use(rateLimit({ windowMs: 60_000, limit: 120, standardHeaders: true, legacyHeaders: false,
  skip: req => ['/api/health', '/api/ready'].includes(req.path) }));
const loginLimiter = rateLimit({
  windowMs: 15 * 60_000,
  limit: 10,
  standardHeaders: true,
  legacyHeaders: false,
  skipSuccessfulRequests: false,
  message: { error: 'Terlalu banyak percobaan login. Coba lagi beberapa saat.' }
});

const stats = new LiveStats();
let live;
let shuttingDown = false;
const state = {
  status: 'Disconnected',
  error: null,
  roomId: null,
  lastEventAt: null,
  events: [],
  stats: stats.value
};

function auth(req, res, next) {
  try { req.user = verify(req.cookies.tlk_session); next(); }
  catch { res.status(401).json({ error: 'Unauthorized' }); }
}
function safe() {
  const { events: _events, ...snapshot } = state;
  const session = live?.snapshot() || { engine: 'none', running: false };
  return {
    ...snapshot, ...session,
    username: session.desiredRunning ? session.username : getConfig().tiktokUsername,
    pythonFallbackAvailable: python.enabled,
    managedWebSocketAvailable: managed.enabled
  };
}
function envNumber(name, fallback, min, max) {
  const n = Number(process.env[name] ?? fallback);
  return Number.isFinite(n) ? Math.max(min, Math.min(max, Math.trunc(n))) : fallback;
}
function handle(event) {
  let p;
  try { p = normalizeEvent(event); }
  catch (e) {
    console.warn('[event] Dropped invalid event:', e?.message || String(e));
    return;
  }
  if (!p || typeof p !== 'object') return;
  if (p.roomId) state.roomId = p.roomId;
  state.lastEventAt = p.timestamp || new Date().toISOString();
  state.stats = stats.consume(p);
  state.events.push(p);
  const maxEvents = Math.min(Math.max(Number(getConfig().maxFeedEvents || 500), 50), 2000);
  state.events = state.events.slice(-maxEvents);
  io.emit('event', p);
  io.emit('stats', state.stats);
  broadcast(p);
  void dispatchWebhook(p, getConfig().webhooks).catch(error => {
    console.error('[webhook] Event not queued:', p.id, error.code || 'outbox_error');
  });
}

const tiktok = new TikTokService({
  emitEvent: event => live.onEngineEvent('node', event),
  setStatus: (status, error) => live.onEngineStatus('node', status, error)
});
const managed = new ManagedLiveConnection({
  emitEvent: event => live.onEngineEvent('managed', event),
  setStatus: (status, error) => live.onEngineStatus('managed', status, error)
});
const python = new PythonLiveFallback({
  emitEvent: event => live.onEngineEvent('python', event),
  setStatus: (status, error) => live.onEngineStatus('python', status, error)
});
live = new LiveController({
  engines: { node: tiktok, managed, python }, emitEvent: handle,
  desired: getConfig().liveDesired,
  autoReconnect: !/^(0|false|no|off)$/i.test(process.env.LIVE_AUTO_RECONNECT || ''),
  baseDelayMs: envNumber('LIVE_RECONNECT_BASE_MS', 2000, 500, 60_000),
  maxDelayMs: envNumber('LIVE_RECONNECT_MAX_MS', 60_000, 2000, 300_000),
  maxAttempts: envNumber('LIVE_RECONNECT_ATTEMPTS', 10, 0, 100),
  persistDesired: desired => updateConfig({ liveDesired: desired,
    ...(desired.running ? { tiktokUsername: desired.username, tiktokRoomId: desired.roomId } : {}) }),
  onStatus: snapshot => {
    state.status = snapshot.status; state.error = snapshot.error;
    io.emit('status', safe());
  }
});
initializeWebhooks(getConfig().webhooks);
attachExternalWs(server, () => [process.env.API_KEY || '', getConfig().wsToken], isAllowedWsOrigin);

app.get('/api/health', (_, res) => res.status(shuttingDown ? 503 : 200).json({ ok: !shuttingDown, status: state.status, engine: live.engine }));
app.get('/api/ready', (_, res) => {
  const delivery = webhookStatus();
  const session = live.snapshot();
  const ready = !shuttingDown && (!session.desiredRunning || session.status === 'Connected') &&
    !delivery.paused && !delivery.failed && !delivery.rejected && !delivery.storageErrors;
  res.status(ready ? 200 : 503).json({ ok: ready, liveExpected: session.desiredRunning,
    liveConnected: session.status === 'Connected', recoveryExhausted: session.recoveryExhausted,
    webhookPending: delivery.pending, webhookFailed: delivery.failed });
});

// External read-only API for other applications.
app.use('/api/v1', externalCors);
app.options('/api/v1/*splat', externalCors);
app.get('/api/v1/status', apiAuth, (req, res) => {
  const snapshot = safe();
  res.json({
    ok: true,
    status: snapshot.status,
    engine: snapshot.engine,
    pythonFallbackAvailable: snapshot.pythonFallbackAvailable,
    managedWebSocketAvailable: snapshot.managedWebSocketAvailable,
    running: snapshot.running,
    desiredRunning: snapshot.desiredRunning,
    reconnectAttempts: snapshot.reconnectAttempts,
    nextRetryAt: snapshot.nextRetryAt,
    recoveryExhausted: snapshot.recoveryExhausted,
    username: snapshot.username,
    roomId: snapshot.roomId,
    lastEventAt: state.lastEventAt,
    stats: snapshot.stats
  });
});
app.get('/api/v1/events', apiAuth, (req, res) => {
  const allowedTypes = new Set(['chat','like','gift','follow','share','member','viewer','stream']);
  const requested = String(req.query.type || '').split(',').map(x => x.trim()).filter(Boolean);
  const types = requested.length ? new Set(requested.filter(x => allowedTypes.has(x))) : allowedTypes;
  const limit = Math.min(Math.max(Number(req.query.limit) || 50, 1), 200);
  const before = String(req.query.before || '').trim();
  let items = state.events.filter(x => types.has(x.event));
  if (before) {
    const cutoff = Date.parse(before);
    if (Number.isFinite(cutoff)) items = items.filter(x => Date.parse(x.timestamp) < cutoff);
  }
  res.json({
    ok: true,
    count: Math.min(items.length, limit),
    events: items.slice(-limit).reverse()
  });
});
app.get('/api/v1/stats', apiAuth, (req, res) => res.json({
  ok: true,
  username: safe().username,
  roomId: live.roomId,
  stats: state.stats
}));
app.post('/api/auth/login', loginLimiter, async (req, res) => {
  const token = await login(String(req.body?.username || ''), String(req.body?.password || ''));
  if (!token) return res.status(401).json({ error: 'Username atau password salah.' });
  res.cookie('tlk_session', token, { httpOnly: true, sameSite: 'lax', secure: process.env.NODE_ENV === 'production', maxAge: 43_200_000, path: '/' });
  res.json({ ok: true });
});
app.post('/api/auth/logout', auth, (_, res) => {
  revokeSession(_.user);
  disconnectSessions(claims => claims?.jti === _.user.jti);
  res.clearCookie('tlk_session', { httpOnly: true, sameSite: 'lax', secure: process.env.NODE_ENV === 'production', path: '/' });
  res.json({ ok: true });
});
app.get('/api/auth/me', auth, (_, res) => res.json({ ok: true }));
app.get('/api/state', auth, (_, res) => res.json(safe()));
app.get('/api/config', auth, (_, res) => res.json(getSafeConfig()));

// History is a volatile dashboard feed. Never undo counters or re-send webhooks.
app.delete('/api/events/:id', auth, (req, res) => {
  const result = removeHistoryEvent(state.events, req.params.id);
  if (result.status === 'invalid') return res.status(400).json({ error: 'ID aktivitas tidak valid.' });
  if (result.status === 'missing') return res.status(404).json({ error: 'Aktivitas tidak ditemukan atau sudah dihapus.' });
  state.events = result.events;
  io.emit('history:removed', { id: req.params.id });
  return res.json({ ok: true, id: req.params.id });
});

app.delete('/api/events', auth, (_, res) => {
  const removed = state.events.length;
  state.events = [];
  io.emit('history:cleared');
  return res.json({ ok: true, removed });
});
// Webhook-specific admin endpoint avoids overwriting LIVE username/room settings
// when destinations are edited independently in the dashboard.
app.get('/api/webhooks/status', auth, (_, res) => res.json(webhookStatus()));
app.post('/api/webhooks/retry', auth, (_, res) => res.json({ ok: true, retried: retryWebhooks() }));
app.put('/api/webhooks', auth, (req, res) => {
  if (!Array.isArray(req.body?.webhooks)) return res.status(400).json({ error: 'Daftar webhook harus berupa array.' });
  let webhooks;
  try {
    webhooks = normalizeWebhooks(req.body.webhooks);
  } catch (error) {
    return res.status(400).json({ error: error.message });
  }
  updateConfig({ webhooks });
  reconcileWebhooks(webhooks);
  return res.json({ ok: true, webhooks });
});
app.put('/api/config', auth, (req, res) => {
  const body = req.body || {};
  const username = String(body.tiktokUsername || '').replace(/^@/, '').trim();
  const roomId = String(body.tiktokRoomId || '').trim();
  if (username && !/^[A-Za-z0-9._-]{1,64}$/.test(username)) return res.status(400).json({ error: 'Username TikTok tidak valid.' });
  if (roomId && !/^\d{5,30}$/.test(roomId)) return res.status(400).json({ error: 'Room ID TikTok harus berupa angka.' });
  let webhooks = getConfig().webhooks;
  if (Object.hasOwn(body, 'webhooks')) {
    try { webhooks = normalizeWebhooks(body.webhooks); }
    catch (e) { return res.status(400).json({ error: e.message }); }
  }
  updateConfig({ tiktokUsername: username, tiktokRoomId: roomId, webhooks });
  reconcileWebhooks(webhooks);
  return res.json(getSafeConfig());
});
app.post('/api/auth/password', auth, async (req, res) => {
  try {
    await setPassword(String(req.body?.password || ''));
    disconnectSessions(() => true);
    res.clearCookie('tlk_session', { httpOnly: true, sameSite: 'lax', secure: process.env.NODE_ENV === 'production', path: '/' });
    res.json({ ok: true });
  }
  catch (e) { res.status(400).json({ error: e.message }); }
});
app.post('/api/live/start', auth, async (req, res) => {
  const body = req.body || {};
  const username = String(Object.hasOwn(body, 'username') ? body.username || '' : getConfig().tiktokUsername || '').replace(/^@/, '').trim();
  const roomId = String(Object.hasOwn(body, 'roomId') ? body.roomId || '' : getConfig().tiktokRoomId || '').trim();
  if (!username || !/^[A-Za-z0-9._-]{1,64}$/.test(username)) return res.status(400).json({ error: 'Username TikTok tidak valid.' });
  if (roomId && !/^\d{5,30}$/.test(roomId)) return res.status(400).json({ error: 'Room ID TikTok harus berupa angka.' });
  try { await live.start(username, roomId); res.json(safe()); }
  catch (e) { res.status(e.status === 409 ? 409 : 502).json({ error: redactText(e.message || 'LIVE connection failed').slice(0, 750) }); }
});
app.post('/api/live/stop', auth, async (_, res) => {
  try { await live.stop(); res.json(safe()); }
  catch (e) { res.status(500).json({ error: redactText(e.message) }); }
});

io.use((socket, next) => {
  try {
    const cookie = String(socket.handshake.headers.cookie || '').match(/(?:^|;\s*)tlk_session=([^;]+)/)?.[1];
    socket.data.token = cookie;
    socket.data.claims = verify(cookie);
    next();
  } catch { next(Error('Unauthorized')); }
});
io.on('connection', socket => {
  socket.emit('state', safe());
  socket.emit('history', state.events);
});
const sessionCheck = setInterval(() => {
  for (const socket of io.sockets.sockets.values()) {
    try { verify(socket.data.token); } catch { socket.disconnect(true); }
  }
}, 30_000);
sessionCheck.unref();

app.use('/api', (_, res) => res.status(404).json({ error: 'API endpoint tidak ditemukan.' }));
app.use('/assets', express.static(path.join(dist, 'assets'), { immutable: true, maxAge: '1y' }));
app.use(express.static(dist, { maxAge: 0 }));
app.get(/.*/, (req, res) => res.sendFile(path.join(dist, 'index.html')));
app.use((error, _req, res, _next) => {
  const status = error.status === 400 ? 400 : error.status === 413 ? 413 : 500;
  console.warn('[http]', status, error.code || error.type || 'request failed');
  res.status(status).json({ error: status === 413 ? 'Payload terlalu besar.' : status === 400 ? 'JSON tidak valid.' : 'Permintaan gagal diproses.' });
});

const port = Number(process.env.PORT || 10000);
server.listen(port, '0.0.0.0', () => {
  console.log(`TikTok Live Konektor listening on ${server.address().port}`);
  void live.resume().catch(error => console.warn('[live] Startup recovery:', redactText(error.message)));
});
async function shutdown(signal) {
  if (shuttingDown) return;
  shuttingDown = true;
  console.log(`[shutdown] ${signal}`);
  const timer = setTimeout(() => process.exit(1), 25_000);
  timer.unref();
  clearInterval(sessionCheck);
  closeExternalWs();
  io.disconnectSockets(true);
  const closed = new Promise(resolve => server.close(resolve));
  try { await live.stop({ shutdown: true }); } catch (e) { console.warn('[shutdown]', redactText(e.message)); }
  await closeWebhooks();
  await closed;
  clearTimeout(timer);
  process.exit(0);
}
process.once('SIGTERM', () => { void shutdown('SIGTERM'); });
process.once('SIGINT', () => { void shutdown('SIGINT'); });
