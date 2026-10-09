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
  const name = String(type || '').replace(/^Webcast/i, '').replace(/Message$/i, '').replace(/^tiktok[._-]/i, '').toLowerCase();
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

// Eulerstream can send bundled or single JSON events. Historical gateway
// releases use `event` rather than `type`, notably for `roomInfo`.
// All event payloads must remain bounded; never relay the raw gateway envelope.
export function extractManagedMessages(raw) {
  if (Buffer.isBuffer(raw) && raw.byteLength > 256 * 1024) return [];
  if (typeof raw === 'string' && Buffer.byteLength(raw) > 256 * 1024) return [];
  let value;
  try { value = JSON.parse(String(raw)); } catch { return []; }
  const result = [];
  const visit = (item, depth = 0) => {
    if (!item || typeof item !== 'object' || depth > 4 || result.length >= 200) return;
    if (Array.isArray(item)) {
      for (const child of item.slice(0, 200)) visit(child, depth + 1);
      return;
    }
    if (Array.isArray(item.messages)) {
      for (const child of item.messages.slice(0, 200)) visit(child, depth + 1);
      return;
    }
    const type = pick(item.type, item.event);
    if (typeof type !== 'string') return;
    const data = item.data && typeof item.data === 'object'
      ? item.data
      : item.payload && typeof item.payload === 'object'
        ? item.payload
        : item;
    result.push({ type, data });
  };
  visit(value);
  return result;
}

function roomIdOf(data) {
  const id = pick(data?.roomId, data?.room_id, data?.room?.roomId, data?.room?.room_id, data?.room?.id,
    data?.roomInfo?.roomId, data?.roomInfo?.id, data?.id);
  return id && /^\\d{5,30}$/.test(String(id)) ? String(id) : '';
}

function safeMessageKinds(messages) {
  return [...new Set(messages.map(m => String(m.type || '').slice(0, 64))
    .filter(t => /^[A-Za-z0-9._-]{1,64}$/.test(t)))].slice(0, 8);
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
    urlFactory = createWebSocketUrl, timeoutMs = 35000 } = {}) {
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
      let socketOpened = false;
      let framesReceived = 0;
      let framesParsed = 0;
      const kinds = new Set();
      const markConnected = (roomId = '') => {
        if (!current()) return;
        if (roomId) this.roomId = roomId;
        this.connected = true;
        finish();
      };
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
      timer = setTimeout(() => {
        const detail = !socketOpened
          ? 'Gateway Eulerstream tidak berhasil membuka koneksi WebSocket.'
          : !framesReceived
            ? 'WebSocket Eulerstream terbuka tetapi tidak menerima pesan LIVE.'
            : 'WebSocket Eulerstream menerima pesan, tetapi tidak menemukan status atau event LIVE yang valid.';
        console.warn('[managed-ws] Handshake diagnostic', JSON.stringify({
          opened: socketOpened, framesReceived, framesParsed, kinds: [...kinds]
        }));
        fail(detail + ' Pastikan akun sedang LIVE dan akses Cloud WebSocket tersedia.');
      }, this.timeoutMs);
      socket.on('open', () => {
        if (current()) {
          socketOpened = true;
          console.info('[managed-ws] Transport opened for @' + clean);
        }
      });
      socket.on('message', (frame) => {
        if (!current()) return;
        framesReceived++;
        const messages = extractManagedMessages(frame);
        framesParsed += messages.length;
        for (const type of safeMessageKinds(messages)) {
          if (kinds.size < 12) kinds.add(type);
        }
        // Metadata only; never log raw frames, actor details or API keys.
        if (framesReceived === 1) {
          console.info('[managed-ws] First frame', JSON.stringify({
            parsed: messages.length, kinds: safeMessageKinds(messages)
          }));
        }
        for (const { type, data } of messages) {
          const eventType = String(type || '').toLowerCase();
          if (eventType === 'room.status' || eventType === 'roomstatus') {
            const state = String(data?.state || '').toLowerCase();
            if (state === 'connected' || state === 'live') {
              markConnected(roomIdOf(data));
              continue;
            }
            if (state === 'ended' || state === 'offline' || state === 'error') {
              fail(String(data?.message || ('TikTok LIVE status: ' + state)).slice(0, 250));
              return;
            }
            continue;
          }
          if (eventType === 'roominfo' || eventType === 'room.info') {
            const roomId = roomIdOf(data);
            if (data?.isLive === false || data?.is_live === false) {
              fail('Gateway Eulerstream menyatakan akun TikTok belum LIVE.');
              return;
            }
            if (roomId) markConnected(roomId);
            continue;
          }
          if (eventType === 'error' || eventType === 'tiktok.error') {
            fail('Gateway Eulerstream mengirim error: ' + String(data?.message || data?.error || 'unknown').slice(0, 160));
            return;
          }
          const normalized = normalizeManagedMessage(type, data, this.giftNames);
          if (!normalized || !STREAM_TYPES.has(normalized.event)) continue;
          // An actual webcast event is stronger proof of an active LIVE session
          // than a transport-level WebSocket 'open' or gateway 'tiktok.connect'.
          if (!this.connected) markConnected(roomIdOf(data));
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
