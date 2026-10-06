import crypto from 'node:crypto';
import { WebSocketServer } from 'ws';
import { serializeEvent } from './events.js';

let wss;
let getTokens = () => [];
let isOriginAllowed = () => true;
const clientsByIp = new Map();
const WINDOW_MS = 60_000;
const MAX_ATTEMPTS_PER_WINDOW = 30;
const MAX_TRACKED_IPS = 10_000;

function clientIp(req) {
  return String(req.headers['x-forwarded-for'] || req.socket.remoteAddress || '').split(',')[0].trim() || 'unknown';
}

function pruneExpired(now) {
  for (const [ip, state] of clientsByIp) {
    if (now > state.resetAt) clientsByIp.delete(ip);
  }
  if (clientsByIp.size <= MAX_TRACKED_IPS) return;
  for (const ip of clientsByIp.keys()) {
    clientsByIp.delete(ip);
    if (clientsByIp.size <= MAX_TRACKED_IPS) break;
  }
}

function allowed(req) {
  const ip = clientIp(req);
  const now = Date.now();
  if (clientsByIp.size >= MAX_TRACKED_IPS) pruneExpired(now);
  let state = clientsByIp.get(ip);
  if (!state || now > state.resetAt) state = { count: 0, resetAt: now + WINDOW_MS };
  state.count += 1;
  clientsByIp.set(ip, state);
  return state.count <= MAX_ATTEMPTS_PER_WINDOW;
}

function sameToken(a, b) {
  const left = Buffer.from(String(a || ''));
  const right = Buffer.from(String(b || ''));
  return left.length > 0 && left.length === right.length && crypto.timingSafeEqual(left, right);
}

export function attachExternalWs(server, tokenProvider, originProvider = () => true) {
  getTokens = tokenProvider;
  isOriginAllowed = originProvider;
  wss = new WebSocketServer({ noServer: true, maxPayload: 256 * 1024 });

  server.on('upgrade', (req, socket, head) => {
    let u;
    try { u = new URL(req.url, 'http://' + req.headers.host); } catch {
      socket.destroy();
      return;
    }
    if (u.pathname !== '/live') return;

    const origin = String(req.headers.origin || '');
    if (!isOriginAllowed(origin)) {
      socket.write('HTTP/1.1 403 Forbidden\r\nConnection: close\r\n\r\n');
      socket.destroy();
      return;
    }

    if (!allowed(req)) {
      socket.write('HTTP/1.1 429 Too Many Requests\r\nConnection: close\r\nRetry-After: 60\r\n\r\n');
      socket.destroy();
      return;
    }

    const authHeader = String(req.headers.authorization || '');
    const bearer = authHeader.match(/^Bearer\s+(.+)$/i)?.[1] || '';
    const supplied = bearer || u.searchParams.get('token') || u.searchParams.get('key') || '';
    const expected = (Array.isArray(getTokens()) ? getTokens() : [getTokens()])
      .map(x => String(x || ''))
      .filter(Boolean);
    if (!expected.some(token => sameToken(supplied, token))) {
      socket.write('HTTP/1.1 401 Unauthorized\r\nConnection: close\r\n\r\n');
      socket.destroy();
      return;
    }

    wss.handleUpgrade(req, socket, head, ws => {
      ws.isAlive = true;
      ws.on('pong', () => { ws.isAlive = true; });
      wss.emit('connection', ws, req);
    });
  });

  const heartbeat = setInterval(() => {
    for (const ws of wss.clients) {
      if (!ws.isAlive) { ws.terminate(); continue; }
      ws.isAlive = false;
      ws.ping();
    }
    pruneExpired(Date.now());
  }, 30_000);
  heartbeat.unref?.();

  return wss;
}

export function broadcast(event) {
  if (!wss) return;
  let message;
  try { message = serializeEvent(event); } catch (e) {
    console.warn('[ws] Serialization failed:', e?.message || String(e));
    return;
  }
  for (const client of wss.clients) {
    if (client.readyState === 1) {
      try { client.send(message); } catch (e) { console.warn('[ws] Send failed:', e?.message || String(e)); }
    }
  }
}
