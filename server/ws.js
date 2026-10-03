import { WebSocketServer } from 'ws';
import { serializeEvent } from './events.js';

let wss;
let getToken = () => '';
const clientsByIp = new Map();

function clientIp(req) {
  return String(req.headers['x-forwarded-for'] || req.socket.remoteAddress || '').split(',')[0].trim();
}

function allowed(req) {
  const ip = clientIp(req);
  const now = Date.now();
  const state = clientsByIp.get(ip) || { count: 0, resetAt: now + 60_000 };
  if (now > state.resetAt) { state.count = 0; state.resetAt = now + 60_000; }
  state.count += 1;
  clientsByIp.set(ip, state);
  return state.count <= 30;
}

export function attachExternalWs(server, tokenProvider) {
  getToken = tokenProvider;
  wss = new WebSocketServer({ noServer: true, maxPayload: 256 * 1024 });

  server.on('upgrade', (req, socket, head) => {
    let u;
    try { u = new URL(req.url, 'http://' + req.headers.host); } catch {
      socket.destroy();
      return;
    }
    if (u.pathname !== '/live') return;

    const authHeader = String(req.headers.authorization || '');
    const bearer = authHeader.match(/^Bearer\s+(.+)$/i)?.[1] || '';
    const supplied = bearer || u.searchParams.get('token') || '';
    if (!supplied || supplied !== getToken() || !allowed(req)) {
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
