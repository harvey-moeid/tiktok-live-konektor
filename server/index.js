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
import { dispatchWebhook } from './webhooks.js';
import { attachExternalWs } from './ws.js';
import { TikTokService } from './tiktok.js';
import { safeJsonValue } from './events.js';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const dist = path.join(root, 'client', 'dist');
const app = express();
const server = http.createServer(app);
const io = new SocketIO(server, { path: '/socket.io', maxHttpBufferSize: 256 * 1024 });

app.use(helmet({ crossOriginEmbedderPolicy: false }));
app.use(express.json({ limit: '64kb' }));
app.use(cookieParser());
app.use(rateLimit({ windowMs: 60_000, limit: 120, standardHeaders: true, legacyHeaders: false }));

const state = {
  status: 'Disconnected',
  error: null,
  events: [],
  stats: { chat: 0, gifts: 0, giftCoins: 0, likes: 0, follows: 0, peakViewers: 0, viewerCount: 0, topGifter: [] }
};
const giftStreaks = new Map();
let operation = Promise.resolve();

function auth(req, res, next) {
  try { req.user = verify(req.cookies.tlk_session); next(); }
  catch { res.status(401).json({ error: 'Unauthorized' }); }
}
function safe() {
  return {
    ...state,
    username: getConfig().tiktokUsername,
    roomId: getConfig().tiktokRoomId || null,
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
  const p = safeJsonValue(event);
  if (!p || typeof p !== 'object') return;
  if (p.event === 'stream' && p.data?.state === 'started') resetStats();
  if (p.event === 'chat') state.stats.chat++;
  if (p.event === 'gift') addGift(p.data || {});
  if (p.event === 'like') state.stats.likes += Number(p.data?.likeCount) || 1;
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
attachExternalWs(server, () => getConfig().wsToken);

app.get('/api/health', (_, res) => res.json({ ok: true, status: state.status }));
app.post('/api/auth/login', async (req, res) => {
  const token = await login(String(req.body?.username || ''), String(req.body?.password || ''));
  if (!token) return res.status(401).json({ error: 'Username atau password salah.' });
  res.cookie('tlk_session', token, { httpOnly: true, sameSite: 'lax', secure: process.env.NODE_ENV === 'production', maxAge: 43_200_000, path: '/' });
  res.json({ ok: true });
});
app.post('/api/auth/logout', auth, (_, res) => { res.clearCookie('tlk_session', { path: '/' }); res.json({ ok: true }); });
app.get('/api/auth/me', auth, (_, res) => res.json({ ok: true }));
app.get('/api/state', auth, (_, res) => res.json(safe()));
app.get('/api/config', auth, (_, res) => res.json(getSafeConfig()));
app.put('/api/config', auth, (req, res) => {
  const body = req.body || {};
  const username = String(body.tiktokUsername || '').replace(/^@/, '').trim();
  const roomId = String(body.tiktokRoomId || '').trim();
  if (username && !/^[A-Za-z0-9._-]{1,64}$/.test(username)) return res.status(400).json({ error: 'Username TikTok tidak valid.' });
  if (roomId && !/^\d{5,30}$/.test(roomId)) return res.status(400).json({ error: 'Room ID TikTok harus berupa angka.' });
  if (Array.isArray(body.webhooks) && body.webhooks.length > 20) return res.status(400).json({ error: 'Maksimal 20 webhook.' });
  const webhooks = Array.isArray(body.webhooks) ? body.webhooks.slice(0, 20) : getConfig().webhooks;
  return res.json(getSafeConfig(updateConfig({ tiktokUsername: username, tiktokRoomId: roomId, webhooks })));
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
    await tiktok.start(username, roomId);
    return safe();
  });
  operation = run.catch(() => undefined);
  try { res.json(await run); }
  catch (e) { res.status(502).json({ error: e.message, details: e?.errors || e?.cause || null }); }
});
app.post('/api/live/stop', auth, async (_, res) => {
  const run = operation.then(async () => {
    if (state.status === 'Disconnected') return safe();
    setStatus('Stopping');
    await tiktok.stop();
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
app.use(express.static(dist));
app.get(/.*/, (req, res) => res.sendFile(path.join(dist, 'index.html')));
server.listen(Number(process.env.PORT || 10000), '0.0.0.0', () => console.log('TikTok Live Konektor listening'));
