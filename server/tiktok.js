import { TikTokLiveConnection, ControlEvent, WebcastEvent } from 'tiktok-live-connector';
import { broadcast } from './ws.js';

function errorDetails(e) {
  const clean = (v) => {
    if (v == null) return null;
    if (typeof v === 'string') return v;
    try { return JSON.parse(JSON.stringify(v, (k, x) => (k === 'request' || k === 'response' ? undefined : x))); }
    catch { return String(v); }
  };
  return { message: e?.message || String(e), name: e?.name || 'Error', code: e?.code || null, cause: clean(e?.cause), errors: clean(e?.errors) || clean(e?.requestErrs) || null };
}

function first(...values) {
  return values.find((v) => v !== undefined && v !== null && String(v).trim() !== '');
}
function userOf(d) {
  return d?.user || d?.memberMessage?.user || d?.chatMessage?.user || d?.likeMessage?.user ||
    d?.giftMessage?.user || d?.followMessage?.user || d?.shareMessage?.user || {};
}
function usernameOf(d) {
  const u = userOf(d);
  return String(first(d?.uniqueId, u?.uniqueId, d?.unique_id, u?.unique_id, d?.username, u?.username) || 'unknown');
}
function nicknameOf(d) {
  const u = userOf(d);
  return String(first(d?.nickname, u?.nickname, d?.user?.nickname) || '');
}
function commentOf(d) {
  return String(first(d?.comment, d?.chatMessage?.comment, d?.message, d?.text, d?.content) || '');
}
function numberOf(...values) {
  for (const value of values) {
    const n = Number(value);
    if (Number.isFinite(n)) return n;
  }
  return 0;
}

function findRoomIdInObject(value, depth = 0) {
  if (depth > 12 || value == null) return '';
  if (typeof value === 'string') {
    if (/^\d{5,30}$/.test(value)) return value;
    return '';
  }
  if (Array.isArray(value)) {
    for (const item of value) {
      const found = findRoomIdInObject(item, depth + 1);
      if (found) return found;
    }
    return '';
  }
  if (typeof value === 'object') {
    for (const [key, item] of Object.entries(value)) {
      if (/^(roomId|room_id|roomID|liveRoomId|live_room_id|room_id_str)$/i.test(key)) {
        const s = String(item ?? '').trim();
        if (/^\d{5,30}$/.test(s)) return s;
      }
      const found = findRoomIdInObject(item, depth + 1);
      if (found) return found;
    }
  }
  return '';
}

function extractRoomIdFromHtml(html) {
  // Direct JSON/key matches. Do NOT over-escape these regexes.
  const patterns = [
    /["']roomId["']\s*[:=]\s*["']?(\d{5,30})["']?/gi,
    /["']room_id["']\s*[:=]\s*["']?(\d{5,30})["']?/gi,
    /["']roomID["']\s*[:=]\s*["']?(\d{5,30})["']?/gi,
    /["']liveRoomId["']\s*[:=]\s*["']?(\d{5,30})["']?/gi,
    /"id"\s*:\s*"?(\d{12,30})"?/gi
  ];
  for (const re of patterns) {
    const m = re.exec(html);
    if (m?.[1]) return m[1];
  }

  // TikTok commonly embeds serialized state in script tags.
  const scriptRe = /<script[^>]*>([\s\S]*?)<\/script>/gi;
  let match;
  while ((match = scriptRe.exec(html))) {
    const body = match[1];
    if (!/(roomId|room_id|liveRoom|live_room)/i.test(body)) continue;

    // Try raw JSON first.
    try {
      const parsed = JSON.parse(body);
      const found = findRoomIdInObject(parsed);
      if (found) return found;
    } catch {}

    // Then try JSON-looking fragments inside the script.
    const nestedPatterns = [
      /["']roomId["']\s*:\s*["']?(\d{5,30})["']?/i,
      /["']room_id["']\s*:\s*["']?(\d{5,30})["']?/i,
      /["']liveRoomId["']\s*:\s*["']?(\d{5,30})["']?/i
    ];
    for (const re of nestedPatterns) {
      const m = re.exec(body);
      if (m?.[1]) return m[1];
    }
  }

  return '';
}

async function directHtmlRoomId(username) {
  const urls = [
    'https://www.tiktok.com/@' + encodeURIComponent(username) + '/live',
    'https://www.tiktok.com/@' + encodeURIComponent(username)
  ];
  const headers = {
    'user-agent': 'Mozilla/5.0 (Linux; Android 14) AppleWebKit/537.36 Chrome/140.0 Mobile Safari/537.36',
    accept: 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
    'accept-language': 'en-US,en;q=0.9',
    'cache-control': 'no-cache'
  };

  for (const url of urls) {
    for (let attempt = 1; attempt <= 2; attempt++) {
      try {
        const r = await fetch(url, { headers, redirect: 'follow' });
        const html = await r.text();
        console.log('[TikTok] HTML probe status=' + r.status + ' bytes=' + html.length + ' url=' + url);

        if (!r.ok) throw Error('HTTP ' + r.status);
        const roomId = extractRoomIdFromHtml(html);
        if (roomId) {
          console.log('[TikTok] HTML Room ID found: ' + roomId);
          return roomId;
        }
      } catch (e) {
        console.warn('[TikTok] HTML probe failed:', e?.message || String(e));
      }
      if (attempt < 2) await new Promise((r) => setTimeout(r, 1000 * attempt));
    }
  }
  return '';
}

export class TikTokService {
  constructor({ emitEvent, setStatus }) {
    this.emitEvent = emitEvent; this.setStatus = setStatus;
    this.connection = null; this.running = false; this.username = '';
  }

  emit(type, data) {
    const p = { event: type, timestamp: new Date().toISOString(), data };
    this.emitEvent(p); broadcast(p);
  }

  bind(c) {
    // v2.5.0 documents these Webcast event names as stable string identifiers.
    // Use the literal names so an enum/export change cannot silently disable handlers.
    const on = (name, handler) => c.on(name, handler);

    this._debug = { websocketData: 0, decodedData: 0, lastDecoded: null };

    on(ControlEvent.CONNECTED, (s) => {
      this.setStatus('Connected');
      this.emit('stream', { state: 'started', roomId: s.roomId || null, username: this.username });
    });
    c.on(ControlEvent.DISCONNECTED, () => {
      this.setStatus('Disconnected');
      this.emit('stream', { state: 'ended', username: this.username });
    });
    c.on(ControlEvent.ERROR, (e) => {
      const d = errorDetails(e);
      console.error('[TikTok] Connector ERROR', JSON.stringify(d));
      this.setStatus('Error', d.message);
    });
    on(ControlEvent.ENTER_ROOM, (d) => {
      console.log('[TikTok] ENTER_ROOM received room=' + String(d?.roomId || d?.room?.roomId || 'unknown'));
    });

    on('chat', (d) => this.emit('chat', {
      username: usernameOf(d), nickname: nicknameOf(d), message: commentOf(d)
    }));
    on('gift', (d) => {
      const gift = d?.giftDetails || d?.gift || d?.extendedGiftInfo || {};
      const repeatCount = numberOf(d?.repeatCount, d?.repeat_count, 1) || 1;
      const diamondCount = numberOf(d?.diamondCount, d?.diamond_count, gift?.diamondCount, gift?.diamond_count);
      this.emit('gift', {
        username: usernameOf(d), nickname: nicknameOf(d),
        giftName: String(first(d?.giftName, gift?.giftName, d?.extendedGiftInfo?.name) || 'Unknown'),
        repeatCount, totalValue: diamondCount * repeatCount
      });
    });
    on('like', (d) => this.emit('like', {
      username: usernameOf(d), nickname: nicknameOf(d),
      likeCount: numberOf(d?.likeCount, d?.like_count, d?.totalLikeCount, 1) || 1
    }));
    on('roomUser', (d) => this.emit('viewer', {
      viewerCount: numberOf(d?.viewerCount, d?.viewer_count, d?.roomUser?.viewerCount, d?.stats?.viewerCount, d?.stats?.viewer_count)
    }));
    on('member', (d) => this.emit('member', {
      username: usernameOf(d), nickname: nicknameOf(d), memberCount: numberOf(d?.memberCount, d?.member_count)
    }));
    // TikTok connector exposes follow/share through the "social" message event.
    on('social', (d) => {
      const action = String(first(d?.displayType, d?.action, d?.socialType, '') || '').toLowerCase();
      if (action.includes('follow')) this.emit('follow', { username: usernameOf(d), nickname: nicknameOf(d) });
      else if (action.includes('share')) this.emit('share', { username: usernameOf(d), nickname: nicknameOf(d) });
      else this.emit('social', { username: usernameOf(d), nickname: nicknameOf(d), action });
    });

    // Diagnostics: prove whether the WebSocket is receiving and decoding Webcast frames.
    // Never forward raw frames to clients because they can be very large.
    on('websocketConnected', () => {
      console.log('[TikTok] WebSocket connected');
    });
    on('websocketData', (data) => {
      this._debug.websocketData++;
      const bytes = data?.byteLength ?? data?.length ?? 0;
      console.log('[TikTok] WebSocket frame #' + this._debug.websocketData + ' bytes=' + bytes);
    });
    on(ControlEvent.RAW_DATA, (messageTypeName, binary) => {
      console.log('[TikTok] Raw Webcast message=' + String(messageTypeName) + ' bytes=' + (binary?.byteLength ?? binary?.length ?? 0));
    });
    on(ControlEvent.DECODED_DATA, (eventName, decodedData) => {
      this._debug.decodedData++;
      const keys = decodedData && typeof decodedData === 'object'
        ? Object.keys(decodedData).slice(0, 20).join(',')
        : typeof decodedData;
      console.log('[TikTok] Decoded event=' + String(eventName) + ' keys=' + keys);
    });

    // The underlying WebSocket client exposes the actual protobuf decode failure.
    // Attach to it once the connection creates the websocket client.
    on(ControlEvent.WEBSOCKET_CONNECTED, (client) => {
      if (client?.on) {
        client.on('messageDecodingFailed', (err) => {
          console.error('[TikTok] PROTOBUF DECODE FAILED:', errorDetails(err));
        });
        client.on('protoMessageFetchResult', (result) => {
          const count = Array.isArray(result?.messages)
            ? result.messages.length
            : Array.isArray(result) ? result.length : null;
          console.log('[TikTok] Proto message result count=' + String(count ?? 'unknown'));
        });
        client.on('imEnteredRoom', (room) => {
          console.log('[TikTok] WebSocket imEnteredRoom room=' + String(room?.roomId || 'unknown'));
        });
      }
    });
  }

  async start(u, roomId = '') {
    if (this.running) await this.stop();
    this.username = String(u || '').replace(/^@/, '').trim();
    let explicitRoomId = String(roomId || '').trim();

    if (!/^[A-Za-z0-9._-]{1,64}$/.test(this.username)) throw Error('Username TikTok tidak valid.');
    if (explicitRoomId && !/^\d{5,30}$/.test(explicitRoomId)) throw Error('Room ID TikTok harus berupa angka.');

    console.log('[TikTok] START requested for @' + this.username + (explicitRoomId ? ' roomId=' + explicitRoomId : ''));
    this.setStatus('Connecting...'); this.running = true;
    this.connection = new TikTokLiveConnection(this.username, { enableExtendedGiftInfo: false });
    console.log('[TikTok] Euler signing: anonymous/community mode (no paid API key)');
    this.bind(this.connection);

    try {
      if (!explicitRoomId) {
        try {
          explicitRoomId = String(await this.connection.fetchRoomId() || '').trim();
          if (explicitRoomId) console.log('[TikTok] Connector discovered Room ID: ' + explicitRoomId);
        } catch (e) {
          console.warn('[TikTok] Connector Room ID discovery failed:', e?.message || String(e));
        }
        if (!explicitRoomId) explicitRoomId = await directHtmlRoomId(this.username);
        if (!explicitRoomId) throw Error('Room ID otomatis tidak ditemukan. TikTok mungkin sedang memblokir discovery dari server ini. Coba START lagi atau masukkan Room ID manual.');
      }

      console.log('[TikTok] Connecting to @' + this.username + ' using Room ID ' + explicitRoomId + '...');
      return await this.connection.connect(explicitRoomId);
    } catch (e) {
      this.running = false;
      const d = errorDetails(e);
      console.error('[TikTok] CONNECT FAILED @' + this.username, JSON.stringify(d));
      this.setStatus('Error', JSON.stringify(d));
      throw e;
    }
  }

  async stop() {
    const c = this.connection; this.running = false; this.connection = null;
    if (c) try { await c.disconnect(); } catch {}
    this.setStatus('Disconnected');
  }
}