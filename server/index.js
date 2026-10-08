import http from 'node:http';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import express from 'express';
import helmet from 'helmet';
import cookieParser from 'cookie-parser';
import rateLimit from 'express-rate-limit';
import { Server as SocketIO } from 'socket.io';
import { getConfig, getSafeConfig, updateConfig } from './config.js';
import { login, verify, setPassword } from './auth.js';
import { dispatchWebhook, normalizeWebhooks } from './webhooks.js';
import { attachExternalWs } from './ws.js';
import { TikTokService } from './tiktok.js';
import { normalizeEvent, createEvent } from './events.js';
import { broadcast } from './ws.js';
import { PythonLiveFallback } from './python-fallback.js';
import { apiAuth, externalCors, isAllowedWsOrigin } from './api-auth.js';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const dist = path.join(root, 'client', 'dist');
const app = express();
app.set('trust proxy', 1);
const server = http.createServer(app);
const io = new SocketIO(server, { path: '/socket.io', maxHttpBufferSize: 256 * 1024 });

app.use(helmet({ crossOriginEmbedderPolicy: false }));
app.use(express.json({ limit: '64kb' }));
app.use(cookieParser());
app.use(rateLimit({ windowMs: 60_000, limit: 120, standardHeaders: true, legacyHeaders: false }));
const loginLimiter = rateLimit({
  windowMs: 15 * 60_000,
  limit: 10,
  standardHeaders: true,
  legacyHeaders: false,
  skipSuccessfulRequests: true,
  message: { error: 'Terlalu banyak percobaan login. Coba lagi beberapa saat.' }
});

const state = {
  status: 'Disconnected',
  error: null,
  roomId: null,
  lastEventAt: null,
  events: [],
  stats: { chat: 0, gifts: 0, giftCoins: 0, likes: 0, follows: 0, peakViewers: 0, viewerCount: 0, topGifter: [] }
};
const giftStreaks = new Map();
let operation = Promise.resolve();
let activeEngine = 'none';

function auth(req, res, next) {
  try { req.user = verify(req.cookies.tlk_session); next(); }
  catch { res.status(401).json({ error: 'Unauthorized' }); }
}
function safe() {
  const { events: _events, ...snapshot } = state;
  return {
    ...snapshot,
    username: getConfig().tiktokUsername,
    roomId: state.roomId || getConfig().tiktokRoomId || null,
    engine: activeEngine,
    pythonFallbackAvailable: python.enabled,
    running: ['Connected', 'Connecting...'].includes(state.status)
  };
}
function setStatus(status, error = null) {
  state.status = status;
  state.error = error;
  io.emit('status', safe());
}
function resetStats() {
  state.stats = { chat: 0, gifts: 0, giftCoins: 0, likes: 0, follows: 0, peakViewers: 0, viewerCount: 0, topGifter: [] };
  giftStreaks.clear();
}
function addGift(d) {
  const username = String(d.username || 'unknown');
  const giftName = String(d.giftName || 'Unknown');
  const key = username + '|' + giftName;
  const repeatCount = Math.max(Number(d.repeatCount) || 1, 1);
  const previous = giftStreaks.get(key) || 0;
  const delta = Math.max(repeatCount - previous, 0);
  giftStreaks.set(key, repeatCount);
  if (d.repeatEnd) giftStreaks.delete(key);
  const unitCoins = Number(d.diamondCount) || Number(d.totalValue) / repeatCount || 0;
  state.stats.gifts += delta;
  state.stats.giftCoins += unitCoins * delta;
  let top = state.stats.topGifter.find(x => x.username === username);
  if (top) top.coins += unitCoins * delta;
  else state.stats.topGifter.push({ username, coins: unitCoins * delta });
  state.stats.topGifter.sort((a, b) => b.coins - a.coins);
  state.stats.topGifter = state.stats.topGifter.slice(0, 10);
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
  if (p.event === 'stream' && p.data?.state === 'started') resetStats();
  if (p.event === 'stream' && p.data?.state === 'ended') state.roomId = null;
  if (p.event === 'chat') state.stats.chat++;
  if (p.event === 'gift') addGift(p.data || {});
  if (p.event === 'like') state.stats.likes += Math.max(Number(p.data?.likeCount) || 1, 1);
  if (p.event === 'follow') state.stats.follows++;
  if (p.event === 'viewer') {
    state.stats.viewerCount = Number(p.data?.viewerCount) || 0;
    state.stats.peakViewers = Math.max(state.stats.peakViewers, state.stats.viewerCount);
  }
  state.events.push(p);
  const maxEvents = Math.min(Math.max(Number(getConfig().maxFeedEvents || 500), 50), 2000);
  state.events = state.events.slice(-maxEvents);
  io.emit('event', p);
  io.emit('stats', state.stats);
  void dispatchWebhook(p, getConfig().webhooks);
}

const tiktok = new TikTokService({ emitEvent: handle, setStatus });
const python = new PythonLiveFallback({
  emitEvent: event => {
    if (activeEngine !== 'python') return;
    handle(event);
    broadcast(event);
  },
  setStatus: (status, error) => {
    if (activeEngine !== 'python') return;
    setStatus(status, error);
    if (status !== 'Connected') {
      const ended = createEvent('stream', { state: 'ended' }, {
        username: getConfig().tiktokUsername, roomId: state.roomId
      });
      handle(ended);
      broadcast(ended);
      activeEngine = 'none';
    }
  }
});
attachExternalWs(server, () => [process.env.API_KEY || '', getConfig().wsToken], isAllowedWsOrigin);

app.get('/api/health', (_, res) => res.json({ ok: true, status: state.status, engine: activeEngine }));

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
    running: snapshot.running,
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
  username: getConfig().tiktokUsername,
  roomId: state.roomId || getConfig().tiktokRoomId || null,
  stats: state.stats
}));
app.post('/api/auth/login', loginLimiter, async (req, res) => {
  const token = await login(String(req.body?.username || ''), String(req.body?.password || ''));
  if (!token) return res.status(401).json({ error: 'Username atau password salah.' });
  res.cookie('tlk_session', token, { httpOnly: true, sameSite: 'lax', secure: process.env.NODE_ENV === 'production', maxAge: 43_200_000, path: '/' });
  res.json({ ok: true });
});
app.post('/api/auth/logout', auth, (_, res) => {
  res.clearCookie('tlk_session', { httpOnly: true, sameSite: 'lax', secure: process.env.NODE_ENV === 'production', path: '/' });
  res.json({ ok: true });
});
app.get('/api/auth/me', auth, (_, res) => res.json({ ok: true }));
app.get('/api/state', auth, (_, res) => res.json(safe()));
app.get('/api/config', auth, (_, res) => res.json(getSafeConfig()));
// Webhook-specific admin endpoint avoids overwriting LIVE username/room settings
// when destinations are edited independently in the dashboard.
app.put('/api/webhooks', auth, (req, res) => {
  if (!Array.isArray(req.body?.webhooks)) return res.status(400).json({ error: 'Daftar webhook harus berupa array.' });
  try {
    const webhooks = normalizeWebhooks(req.body.webhooks);
    updateConfig({ webhooks });
    return res.json({ ok: true, webhooks });
  } catch (error) {
    return res.status(400).json({ error: error.message });
  }
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
  return res.json(getSafeConfig());
});
app.post('/api/auth/password', auth, async (req, res) => {
  try { await setPassword(String(req.body?.password || '')); res.json({ ok: true }); }
  catch (e) { res.status(400).json({ error: e.message }); }
});
app.post('/api/live/start', auth, async (req, res) => {
  const username = String(req.body?.username || getConfig().tiktokUsername || '').replace(/^@/, '').trim();
  const roomId = String(req.body?.roomId || getConfig().tiktokRoomId || '').trim();
  if (!username || !/^[A-Za-z0-9._-]{1,64}$/.test(username)) return res.status(400).json({ error: 'Username TikTok tidak valid.' });
  if (roomId && !/^\d{5,30}$/.test(roomId)) return res.status(400).json({ error: 'Room ID TikTok harus berupa angka.' });
  const run = operation.then(async () => {
    if (['Connecting...', 'Connected', 'Stopping'].includes(state.status)) throw Error('LIVE sedang berjalan atau sedang diproses.');
    updateConfig({ tiktokUsername: username, tiktokRoomId: roomId });
    try {
      await tiktok.start(username, roomId);
      activeEngine = 'node';
      io.emit('status', safe());
      return safe();
    } catch (nativeError) {
      if (!python.enabled) throw nativeError;
      console.warn('[live] Node TikTok failed; trying Python fallback:', nativeError.message);
      activeEngine = 'python';
      state.roomId = null;
      setStatus('Connecting...');
      try {
        const connected = await python.start(username, roomId);
        state.roomId = connected.roomId || null;
        const started = createEvent('stream', { state: 'started', username }, {
          username, roomId: state.roomId
        });
        handle(started);
        broadcast(started);
        setStatus('Connected');
        return safe();
      } catch (pythonError) {
        activeEngine = 'none';
        const combined = new Error(
          'Node: ' + String(nativeError.message || 'failed').slice(0,250) +
          ' | Python: ' + String(pythonError.message || 'failed').slice(0,250)
        );
        setStatus('Error', combined.message);
        throw combined;
      }
    }
  });
  operation = run.catch(() => undefined);
  try { res.json(await run); }
  catch (e) { res.status(502).json({ error: e.message, details: e?.errors || e?.cause || null }); }
});
app.post('/api/live/stop', auth, async (_, res) => {
  const run = operation.then(async () => {
    if (state.status === 'Disconnected') return safe();
    setStatus('Stopping');
    if (activeEngine === 'python') {
      await python.stop();
      const ended = createEvent('stream', { state: 'ended' }, { username: getConfig().tiktokUsername, roomId: state.roomId });
      handle(ended);
      broadcast(ended);
    } else {
      await tiktok.stop();
    }
    activeEngine = 'none';
    state.roomId = null;
    setStatus('Disconnected');
    return safe();
  });
  operation = run.catch(() => undefined);
  try { res.json(await run); } catch (e) { res.status(500).json({ error: e.message }); }
});

io.use((socket, next) => {
  try {
    const cookie = String(socket.handshake.headers.cookie || '').match(/(?:^|;\s*)tlk_session=([^;]+)/)?.[1];
    verify(cookie);
    next();
  } catch { next(Error('Unauthorized')); }
});
io.on('connection', socket => {
  socket.emit('state', safe());
  socket.emit('history', state.events);
});

app.use('/api', (_, res) => res.status(404).json({ error: 'API endpoint tidak ditemukan.' }));
app.use(express.static(dist));
app.get(/.*/, (req, res) => res.sendFile(path.join(dist, 'index.html')));

const port = Number(process.env.PORT || 10000);
server.listen(port, '0.0.0.0', () => console.log(`TikTok Live Konektor listening on ${port}`));

let shuttingDown = false;
async function shutdown(signal) {
  if (shuttingDown) return;
  shuttingDown = true;
  console.log(`[shutdown] ${signal}`);
  try { await python.stop(); } catch (e) { console.warn('[shutdown] Python disconnect failed:', e?.message || String(e)); }
  try { await tiktok.stop(); } catch (e) { console.warn('[shutdown] TikTok disconnect failed:', e?.message || String(e)); }
  server.close(() => process.exit(0));
  const timer = setTimeout(() => process.exit(1), 10_000);
  timer.unref?.();
}
process.once('SIGTERM', () => { void shutdown('SIGTERM'); });
process.once('SIGINT', () => { void shutdown('SIGINT'); });
