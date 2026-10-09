import WebSocket from 'ws';
import { createWebSocketUrl } from '@eulerstream/euler-websocket-sdk';
import { createEvent } from './events.js';
import { normalizeGiftData } from './gifts.js';

const STREAM_TYPES = new Set(['chat', 'like', 'gift', 'follow', 'share', 'member', 'viewer']);
const pick = (...v) => v.find(x => x !== undefined && x !== null && String(x).trim() !== '');
const count = (...v) => {
  for (const n of v) if (n !== undefined && n !== null && n !== '' && Number.isFinite(Number(n))) return Number(n);
  return 0;
};

function actor(data) {
  const u = data.user || data.sender || {};
  return {
    username: String(pick(u.uniqueId, u.unique_id, u.displayId, data.uniqueId, data.username, u.nickname, 'Penonton TikTok')),
    nickname: String(pick(u.nickname, data.nickname, ''))
  };
}

// Managed gateway emits JSON Webcast events; its message names are not the
// shorthand event types exposed to webhook/overlay clients by this app.
export function normalizeManagedMessage(type, data, giftNames = new Map()) {
  if (!data || typeof data !== 'object' || Array.isArray(data)) return null;
  const name = String(type || '').replace(/^Webcast/, '').replace(/Message$/, '').toLowerCase();
  const person = actor(data);
  switch (name) {
    case 'chat':
      return { event: 'chat', data: { ...person, message: String(pick(data.comment, data.content, data.message, data.text, '')) } };
    case 'gift': {
      const gift = normalizeGiftData(data, giftNames);
      return { event: 'gift', data: { ...person, ...gift } };
    }
    case 'like':
      return { event: 'like', data: { ...person,
        likeCount: Math.max(1, count(data.likeCount, data.count, data.like_count, 1)),
        totalLikeCount: count(data.totalLikeCount, data.total, data.total_like_count) } };
    case 'member':
      return { event: 'member', data: { ...person, memberCount: count(data.memberCount, data.member_count) } };
    case 'roomuserseq':
    case 'roomuser':
      return { event: 'viewer', data: { viewerCount: count(data.viewerCount, data.total, data.totalUser, data.onlineUserCount) } };
    case 'follow':
      return { event: 'follow', data: person };
    case 'share':
      return { event: 'share', data: person };
    case 'social': {
      const action = String(pick(data.displayType, data.action, data.socialType, '')).toLowerCase();
      if (action.includes('follow')) return { event: 'follow', data: person };
      if (action.includes('share')) return { event: 'share', data: person };
      return null;
    }
    default:
      return null;
  }
}

// Accept the gateway's bundled {messages:[{type,data}]} and unbundled shapes.
// Ignore unsupported metadata events; never broadcast untrusted raw frames.
export function extractManagedMessages(raw) {
  if (Buffer.isBuffer(raw) && raw.byteLength > 256 * 1024) return [];
  let value;
  try { value = JSON.parse(String(raw)); } catch { return []; }
  const result = [];
  const visit = (item) => {
    if (!item || typeof item !== 'object' || result.length >= 200) return;
    if (Array.isArray(item)) { for (const x of item.slice(0, 200)) visit(x); return; }
    if (Array.isArray(item.messages)) { for (const x of item.messages.slice(0, 200)) visit(x); return; }
    if (typeof item.type === 'string') result.push({ type: item.type, data: item.data });
  };
  visit(value);
  return result;
}

const CLOSED = new Map([
  [4400, 'Konfigurasi Cloud WebSocket Eulerstream tidak valid.'],
  [4401, 'API key Cloud WebSocket Eulerstream tidak diterima.'],
  [4403, 'Akun Eulerstream tidak memiliki izin Cloud WebSocket.'],
  [4404, 'Akun TikTok belum LIVE atau LIVE tidak publik.'],
  [4429, 'Batas koneksi Cloud WebSocket Eulerstream tercapai.'],
  [4556, 'Gateway Eulerstream gagal mengambil data LIVE dari TikTok.'],
  [4557, 'Gateway Eulerstream gagal mengambil informasi ruangan LIVE.']
]);

export function managedCloseReason(code, reason = '') {
  return CLOSED.get(Number(code)) || String(reason || ('Koneksi Cloud WebSocket ditutup (kode ' + code + ')')).slice(0, 250);
}

export class ManagedLiveConnection {
  constructor({ apiKey = process.env.EULER_API_KEY, emitEvent = () => {}, setStatus = () => {},
    socketFactory = (url, options) => new WebSocket(url, options),
    urlFactory = createWebSocketUrl, timeoutMs = 25000 } = {}) {
    this.apiKey = String(apiKey || '').trim();
    this.emitEvent = emitEvent;
    this.setStatus = setStatus;
    this.socketFactory = socketFactory;
    this.urlFactory = urlFactory;
    this.timeoutMs = timeoutMs;
    this.socket = null;
    this.active = false;
    this.connected = false;
    this.generation = 0;
    this.username = '';
    this.roomId = '';
    this.giftNames = new Map();
  }

  get enabled() { return !!this.apiKey; }

  async start(username) {
    if (!this.enabled) throw Error('EULER_API_KEY belum dikonfigurasi untuk Cloud WebSocket.');
    const clean = String(username || '').replace(/^@/, '').trim();
    if (!/^[A-Za-z0-9._-]{1,64}$/.test(clean)) throw Error('Username TikTok tidak valid.');
    this.stop();
    const generation = ++this.generation;
    this.username = clean;
    this.roomId = '';
    this.giftNames.clear();
    this.active = true;
    this.connected = false;
    // API key remains server-side; never log this URL (it includes credentials).
    const url = this.urlFactory({ uniqueId: '@' + clean, apiKey: this.apiKey,
      features: { bundleEvents: true, rawMessages: false, schemaVersion: 'v2' } });
    return new Promise((resolve, reject) => {
      let settled = false;
      let timer;
      const finish = (error) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        if (error) reject(error);
        else resolve({ roomId: this.roomId });
      };
      let socket;
      try { socket = this.socketFactory(url, { handshakeTimeout: this.timeoutMs, maxPayload: 256 * 1024 }); }
      catch (error) { this.active = false; finish(error); return; }
      this.socket = socket;
      const current = () => this.active && generation === this.generation && this.socket === socket;
      const fail = (msg) => {
        if (!current()) return;
        const wasConnected = this.connected;
        this.active = false;
        this.connected = false;
        if (!settled) finish(Error(msg));
        else if (wasConnected) this.setStatus('Error', msg);
        try { socket.close(); } catch {}
      };
      timer = setTimeout(() => fail('Cloud WebSocket tidak mengonfirmasi status LIVE dalam batas waktu.'), this.timeoutMs);
      socket.on('message', (frame) => {
        if (!current()) return;
        for (const { type, data } of extractManagedMessages(frame)) {
          if (type === 'room.status') {
            const state = String(data?.state || '').toLowerCase();
            if (state === 'connected') {
              this.roomId = String(data?.roomId || this.roomId || '');
              this.connected = true;
              finish();
              continue;
            }
            if (state === 'ended' || state === 'offline' || state === 'error') {
              fail(String(data?.message || ('TikTok LIVE status: ' + state)).slice(0, 250));
              return;
            }
            continue;
          }
          if (!this.connected) continue;
          const normalized = normalizeManagedMessage(type, data, this.giftNames);
          if (!normalized || !STREAM_TYPES.has(normalized.event)) continue;
          this.emitEvent(createEvent(normalized.event, normalized.data, { username: clean, roomId: this.roomId }));
        }
      });
      socket.on('error', (err) => {
        if (current()) fail('Cloud WebSocket: ' + String(err?.message || 'connection error').slice(0, 180));
      });
      socket.on('close', (code, rawReason) => {
        if (!current()) return;
        const wasConnected = this.connected;
        this.active = false;
        this.connected = false;
        const msg = managedCloseReason(code, Buffer.isBuffer(rawReason) ? rawReason.toString('utf8') : rawReason);
        if (!settled) finish(Error(msg));
        else if (wasConnected) this.setStatus(code === 4005 || code === 1000 || code === 4404 ? 'Disconnected' : 'Error', msg);
      });
    });
  }

  stop() {
    this.generation++;
    this.active = false;
    this.connected = false;
    const socket = this.socket;
    this.socket = null;
    if (!socket) return;
    socket.removeAllListeners?.();
    try { socket.close(); } catch {}
  }
}
