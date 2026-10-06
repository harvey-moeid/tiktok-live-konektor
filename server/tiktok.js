import { TikTokLiveConnection, ControlEvent, WebcastEvent } from 'tiktok-live-connector';
import { broadcast } from './ws.js';
import { createEvent, safeJsonValue } from './events.js';

const debugEnabled = /^(1|true|yes|on)$/i.test(String(process.env.TIKTOK_DEBUG || ''));
const eulerApiKey = String(process.env.EULER_API_KEY || '').trim();
function debug(...args) { if (debugEnabled) console.log(...args); }
function requestTimeoutMs() {
  const value = Number(process.env.TIKTOK_HTTP_TIMEOUT_MS || 10_000);
  return Number.isFinite(value) ? Math.min(Math.max(Math.trunc(value), 3000), 30_000) : 10_000;
}
function errorDetails(e) {
  const clean = v => {
    if (v == null) return null;
    if (typeof v === 'string') return v;
    try { return JSON.parse(JSON.stringify(v, (k, x) => (k === 'request' || k === 'response' ? undefined : x))); }
    catch { return String(v); }
  };
  const wrapped = e && typeof e === 'object' ? e : {};
  const source = wrapped.exception || wrapped.error || e;
  const info = clean(wrapped.info);
  const message = source?.message || (typeof wrapped.info === 'string' ? wrapped.info : '') || (typeof e === 'string' ? e : '') || 'Unknown TikTok connector error';
  return {
    message,
    name: source?.name || e?.name || 'Error',
    code: source?.code || e?.code || null,
    info,
    cause: clean(source?.cause || e?.cause),
    errors: clean(source?.errors || source?.requestErrs || e?.errors || e?.requestErrs)
  };
}
function first(...values) { return values.find(v => v !== undefined && v !== null && String(v).trim() !== ''); }
function userOf(d) { return d?.user || d?.memberMessage?.user || d?.chatMessage?.user || d?.likeMessage?.user || d?.giftMessage?.user || d?.followMessage?.user || d?.shareMessage?.user || {}; }
function usernameOf(d) {
  const u = userOf(d);
  return String(first(
    d?.uniqueId, u?.uniqueId, d?.unique_id, u?.unique_id,
    d?.username, u?.username, d?.userName, u?.userName,
    d?.nickname, u?.nickname, d?.user?.nickname
  ) || 'Penonton TikTok');
}
function nicknameOf(d) { const u = userOf(d); return String(first(d?.nickname, u?.nickname, d?.user?.nickname) || ''); }
function commentOf(d) { return String(first(d?.comment, d?.chatMessage?.comment, d?.message, d?.text, d?.content) || ''); }
function numberOf(...values) { for (const value of values) { const n = Number(value); if (Number.isFinite(n)) return n; } return 0; }

export function extractRoomIdFromHtml(html) {
  const raw = String(html || '');
  const sources = [
    raw,
    raw.replace(/\\u0022/gi, '"').replace(/\\\"/g, '"').replace(/&quot;/gi, '"')
  ];
  const patterns = [
    /["']roomId["']\s*[:=]\s*["']?(\d{5,30})["']?/gi,
    /["']room_id["']\s*[:=]\s*["']?(\d{5,30})["']?/gi,
    /["']roomID["']\s*[:=]\s*["']?(\d{5,30})["']?/gi,
    /["']liveRoomId["']\s*[:=]\s*["']?(\d{5,30})["']?/gi
  ];
  for (const source of sources) {
    for (const pattern of patterns) {
      const re = new RegExp(pattern.source, pattern.flags);
      const m = re.exec(source);
      if (m?.[1]) return m[1];
    }
  }
  return '';
}

async function directHtmlRoomId(username) {
  const url = 'https://www.tiktok.com/@' + encodeURIComponent(username) + '/live';
  const headers = {
    'user-agent': 'Mozilla/5.0 (Linux; Android 14) AppleWebKit/537.36 Chrome/140.0 Mobile Safari/537.36',
    accept: 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
    'accept-language': 'en-US,en;q=0.9',
    'cache-control': 'no-cache'
  };
  for (let attempt = 1; attempt <= 2; attempt++) {
    try {
      const response = await fetch(url, { headers, redirect: 'follow', signal: AbortSignal.timeout(requestTimeoutMs()) });
      const html = await response.text();
      debug('[TikTok] HTML probe status=' + response.status + ' bytes=' + html.length + ' url=' + url);
      if (!response.ok) throw Error('HTTP ' + response.status);
      const roomId = extractRoomIdFromHtml(html);
      if (roomId) {
        console.warn('[TikTok] Using strict HTML fallback Room ID=' + roomId);
        return roomId;
      }
    } catch (e) {
      console.warn('[TikTok] HTML probe failed:', e?.message || String(e));
    }
    if (attempt < 2) await new Promise(r => setTimeout(r, 1000 * attempt));
  }
  return '';
}

export class TikTokService {
  constructor({ emitEvent, setStatus }) {
    this.emitEvent = emitEvent;
    this.setStatus = setStatus;
    this.connection = null;
    this.running = false;
    this.username = '';
    this.roomId = '';
    this.streamActive = false;
  }

  emit(type, data) {
    const event = createEvent(type, data, { username: this.username, roomId: this.roomId });
    debug('[TikTok] Event=' + type + ' room=' + (this.roomId || 'unknown'));
    this.emitEvent(event);
    broadcast(event);
  }

  emitStreamEnded() {
    if (!this.streamActive) return;
    this.streamActive = false;
    this.emit('stream', { state: 'ended', username: this.username });
  }

  bind(c) {
    const on = (name, handler) => c.on(name, handler);

    on(ControlEvent.CONNECTED, s => {
      this.roomId = String(s?.roomId || c?.roomId || this.roomId || '');
      this.running = true;
      this.streamActive = true;
      console.log('[TikTok] Connected @' + this.username + ' roomId=' + (this.roomId || 'unknown'));
      this.setStatus('Connected');
      this.emit('stream', { state: 'started', roomId: this.roomId || null, username: this.username });
    });
    on(ControlEvent.DISCONNECTED, detail => {
      this.running = false;
      if (this.connection === c) this.connection = null;
      console.warn('[TikTok] Disconnected', JSON.stringify(safeJsonValue(detail)));
      this.setStatus('Disconnected');
      this.emitStreamEnded();
    });
    on(ControlEvent.ERROR, e => {
      const d = errorDetails(e);
      console.error('[TikTok] Connector ERROR', JSON.stringify(d));
      if (!c?.isConnected) this.setStatus('Error', d.message);
    });
    on(ControlEvent.ENTER_ROOM, d => debug('[TikTok] ENTER_ROOM room=' + String(d?.roomId || d?.room?.roomId || 'unknown')));
    on(ControlEvent.STREAM_END, () => {
      this.running = false;
      this.setStatus('Disconnected');
      this.emitStreamEnded();
    });

    on(WebcastEvent.CHAT, d => this.emit('chat', {
      username: usernameOf(d),
      nickname: nicknameOf(d),
      message: commentOf(d)
    }));
    on(WebcastEvent.GIFT, d => {
      const gift = d?.giftDetails || d?.gift || d?.extendedGiftInfo || {};
      const repeatCount = numberOf(d?.repeatCount, d?.repeat_count, 1) || 1;
      const diamondCount = numberOf(d?.diamondCount, d?.diamond_count, gift?.diamondCount, gift?.diamond_count);
      const giftType = numberOf(d?.giftType, d?.gift_type, gift?.giftType, gift?.gift_type);
      this.emit('gift', {
        username: usernameOf(d), nickname: nicknameOf(d),
        giftName: String(first(d?.giftName, gift?.giftName, d?.extendedGiftInfo?.name) || 'Unknown'),
        repeatCount,
        repeatEnd: Boolean(d?.repeatEnd ?? d?.repeat_end),
        giftType,
        streakable: giftType === 1,
        diamondCount,
        totalValue: diamondCount * repeatCount
      });
    });
    on(WebcastEvent.LIKE, d => this.emit('like', {
      username: usernameOf(d),
      nickname: nicknameOf(d),
      likeCount: Math.max(numberOf(d?.likeCount, d?.like_count, 1) || 1, 1),
      totalLikeCount: numberOf(d?.totalLikeCount, d?.total_like_count)
    }));
    on(WebcastEvent.ROOM_USER, d => this.emit('viewer', {
      viewerCount: numberOf(d?.viewerCount, d?.viewer_count, d?.roomUser?.viewerCount, d?.stats?.viewerCount, d?.stats?.viewer_count)
    }));
    on(WebcastEvent.MEMBER, d => this.emit('member', {
      username: usernameOf(d),
      nickname: nicknameOf(d),
      memberCount: numberOf(d?.memberCount, d?.member_count)
    }));
    for (const eventName of ['emote', 'envelope', 'questionNew', 'linkMicBattle', 'linkMicArmies', 'liveIntro', 'subscribe', 'goalUpdate', 'roomMessage', 'captionMessage', 'imDelete', 'inRoomBanner', 'rankUpdate', 'pollMessage', 'rankText']) {
      on(eventName, d => this.emit(eventName, safeJsonValue(d)));
    }
    on(WebcastEvent.SOCIAL, d => {
      const action = String(first(d?.displayType, d?.action, d?.socialType, '') || '').toLowerCase();
      if (action.includes('follow')) this.emit('follow', { username: usernameOf(d), nickname: nicknameOf(d) });
      else if (action.includes('share')) this.emit('share', { username: usernameOf(d), nickname: nicknameOf(d) });
      else this.emit('social', { username: usernameOf(d), nickname: nicknameOf(d), action });
    });

    if (debugEnabled) {
      if (ControlEvent.RAW_DATA) on(ControlEvent.RAW_DATA, (messageTypeName, binary) => {
        console.log('[TikTok] Raw Webcast message=' + String(messageTypeName) + ' bytes=' + (binary?.byteLength ?? binary?.length ?? 0));
      });
      if (ControlEvent.DECODED_DATA) on(ControlEvent.DECODED_DATA, (eventName, decodedData) => {
        console.log('[TikTok] Decoded event=' + String(eventName) + ' keys=' + (decodedData && typeof decodedData === 'object' ? Object.keys(decodedData).slice(0, 20).join(',') : typeof decodedData));
      });
      if (ControlEvent.WEBSOCKET_CONNECTED) on(ControlEvent.WEBSOCKET_CONNECTED, client => {
        console.log('[TikTok] WebSocket transport connected');
        if (!client?.on) return;
        client.on('messageDecodingFailed', err => console.error('[TikTok] PROTOBUF DECODE FAILED:', JSON.stringify(errorDetails(err))));
        client.on('protoMessageFetchResult', result => {
          const messages = Array.isArray(result?.messages) ? result.messages : Array.isArray(result) ? result : [];
          const summary = messages.map(m => ({
            type: m?.method || m?.type || 'unknown',
            hasDecodedData: !!m?.decodedData,
            decodeError: m?.decodeError ? String(m.decodeError?.message || m.decodeError) : null,
            payloadBytes: m?.payload?.byteLength ?? m?.payload?.length ?? 0
          }));
          console.log('[TikTok] Proto message result count=' + messages.length + ' details=' + JSON.stringify(summary).slice(0, 4000));
        });
      });
    }
  }

  async start(username, roomId = '') {
    if (this.running || this.connection) await this.stop();
    this.username = String(username || '').replace(/^@/, '').trim();
    let explicitRoomId = String(roomId || '').trim();
    if (!/^[A-Za-z0-9._-]{1,64}$/.test(this.username)) throw Error('Username TikTok tidak valid.');
    if (explicitRoomId && !/^\d{5,30}$/.test(explicitRoomId)) throw Error('Room ID TikTok harus berupa angka.');

    this.setStatus('Connecting...');
    this.running = true;
    const timeoutMs = requestTimeoutMs();
    this.connection = new TikTokLiveConnection(this.username, {
      enableExtendedGiftInfo: false,
      processInitialData: true,
      fetchRoomInfoOnConnect: true,
      authenticateWs: false,
      signApiKey: eulerApiKey || undefined,
      webClientOptions: { cache: false, timeout: { request: timeoutMs } },
      wsClientOptions: { handshakeTimeout: timeoutMs }
    });
    this.bind(this.connection);

    try {
      if (!explicitRoomId) {
        try {
          explicitRoomId = String(await this.connection.fetchRoomId() || '').trim();
          if (explicitRoomId) {
            console.log('[TikTok] Native resolver Room ID=' + explicitRoomId +
              ' euler=' + (eulerApiKey ? 'configured' : 'anonymous'));
          }
        } catch (resolveError) {
          console.warn('[TikTok] Native Room ID discovery failed:', JSON.stringify(errorDetails(resolveError)));
        }

        if (!explicitRoomId) {
          explicitRoomId = await directHtmlRoomId(this.username);
        }

        if (!explicitRoomId) {
          throw Error(
            'Room ID LIVE @' + this.username +
            ' tidak dapat ditemukan otomatis. Pastikan akun sedang LIVE; jika discovery TikTok diblokir di server cloud, gunakan EULER_API_KEY atau isi Room ID LIVE manual.'
          );
        }
      }

      this.roomId = explicitRoomId;
      console.log('[TikTok] Connecting @' + this.username +
        ' roomId=' + explicitRoomId +
        ' source=' + (roomId ? 'manual' : 'resolved') +
        ' euler=' + (eulerApiKey ? 'configured' : 'anonymous'));
      const state = await this.connection.connect(explicitRoomId);
      this.roomId = String(state?.roomId || this.connection?.roomId || explicitRoomId || '');
      return state;
    } catch (e) {
      const failedConnection = this.connection;
      this.running = false;
      this.connection = null;
      if (failedConnection) try { await failedConnection.disconnect(); } catch {}
      const d = errorDetails(e);
      console.error('[TikTok] CONNECT FAILED @' + this.username, JSON.stringify(d));
      const diagnostics = JSON.stringify({
        message: d.message,
        info: d.info,
        cause: d.cause,
        errors: d.errors
      });
      const roomResolutionFailed = /room.?id|retrieve.?room|all sources|fetchroomid|user_not_found|19881007|404000/i.test(diagnostics);
      const publicMessage = roomResolutionFailed && !eulerApiKey
        ? 'Resolver TikTok native dan fallback HTML gagal dari server cloud. Pastikan @' + this.username +
          ' sedang LIVE; jika masih gagal, tambahkan EULER_API_KEY atau masukkan Room ID LIVE manual.'
        : d.message;
      this.setStatus('Error', publicMessage);
      if (publicMessage !== d.message) throw Error(publicMessage, { cause: e });
      throw e;
    }
  }

  async stop() {
    const c = this.connection;
    this.running = false;
    this.connection = null;
    if (c) try { await c.disconnect(); } catch (e) { debug('[TikTok] Disconnect warning:', e?.message || String(e)); }
    this.setStatus('Disconnected');
  }
}
