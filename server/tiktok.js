import { TikTokLiveConnection, ControlEvent, WebcastEvent } from 'tiktok-live-connector';
import { broadcast } from './ws.js';

function errorDetails(e) {
  const clean = (v) => {
    if (v == null) return null;
    if (typeof v === 'string') return v;
    try {
      return JSON.parse(JSON.stringify(v, (k, x) => (k === 'request' || k === 'response' ? undefined : x)));
    } catch {
      return String(v);
    }
  };
  return {
    message: e?.message || String(e),
    name: e?.name || 'Error',
    code: e?.code || null,
    cause: clean(e?.cause),
    errors: clean(e?.errors) || clean(e?.requestErrs) || null
  };
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
  return String(first(
    d?.uniqueId,
    u?.uniqueId,
    d?.unique_id,
    u?.unique_id,
    d?.username,
    u?.username,
    d?.user?.uniqueId,
    d?.user?.unique_id
  ) || 'unknown');
}

function nicknameOf(d) {
  const u = userOf(d);
  return String(first(d?.nickname, u?.nickname, d?.user?.nickname) || '');
}

function commentOf(d) {
  return String(first(
    d?.comment,
    d?.chatMessage?.comment,
    d?.message,
    d?.text,
    d?.content
  ) || '');
}

function numberOf(...values) {
  for (const value of values) {
    const n = Number(value);
    if (Number.isFinite(n)) return n;
  }
  return 0;
}

async function directHtmlRoomId(username) {
  const url = 'https://www.tiktok.com/@' + encodeURIComponent(username) + '/live';
  const headers = {
    'user-agent': 'Mozilla/5.0 (Linux; Android 14) AppleWebKit/537.36 Chrome/140.0 Mobile Safari/537.36',
    accept: 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
    'accept-language': 'en-US,en;q=0.9'
  };

  for (let attempt = 1; attempt <= 3; attempt++) {
    try {
      const r = await fetch(url, { headers, redirect: 'follow' });
      const html = await r.text();
      if (!r.ok) throw Error('HTTP ' + r.status);

      const patterns = [
        /"roomId"\\s*:\\s*"?(\\d{5,30})"?/g,
        /"room_id"\\s*:\\s*"?(\\d{5,30})"?/g,
        /"roomID"\\s*:\\s*"?(\\d{5,30})"?/g
      ];

      for (const re of patterns) {
        const m = re.exec(html);
        if (m?.[1]) {
          console.log('[TikTok] Direct HTML Room ID found on attempt ' + attempt + ': ' + m[1]);
          return m[1];
        }
      }
      console.log('[TikTok] Direct HTML attempt ' + attempt + ': no Room ID found, status=' + r.status + ' bytes=' + html.length);
    } catch (e) {
      console.warn('[TikTok] Direct HTML attempt ' + attempt + ' failed:', e?.message || String(e));
    }
    if (attempt < 3) await new Promise((r) => setTimeout(r, 1000 * attempt));
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
  }

  emit(type, data) {
    const p = { event: type, timestamp: new Date().toISOString(), data };
    this.emitEvent(p);
    broadcast(p);
  }

  bind(c) {
    c.on(ControlEvent.CONNECTED, (s) => {
      this.setStatus('Connected');
      this.emit('stream', {
        state: 'started',
        roomId: s.roomId || null,
        username: this.username
      });
    });

    c.on(ControlEvent.DISCONNECTED, () => {
      this.setStatus('Disconnected');
      this.emit('stream', { state: 'ended', username: this.username });
    });

    c.on(ControlEvent.ERROR, (e) => {
      this.setStatus('Error', e && e.message || String(e));
    });

    c.on(WebcastEvent.CHAT, (d) => {
      const username = usernameOf(d);
      const nickname = nicknameOf(d);
      const message = commentOf(d);

      this.emit('chat', {
        username,
        nickname,
        message
      });

      if (username === 'unknown' || !message) {
        console.warn('[TikTok] CHAT payload missing normalized fields', {
          username,
          nickname,
          hasMessage: Boolean(message),
          keys: d && typeof d === 'object' ? Object.keys(d).slice(0, 30) : []
        });
      }
    });

    c.on(WebcastEvent.GIFT, (d) => {
      const u = userOf(d);
      const gift = d?.giftDetails || d?.gift || d?.extendedGiftInfo || {};
      const repeatCount = numberOf(d?.repeatCount, d?.repeat_count, 1) || 1;
      const diamondCount = numberOf(
        d?.diamondCount,
        d?.diamond_count,
        gift?.diamondCount,
        gift?.diamond_count,
        d?.extendedGiftInfo?.diamondCount
      );

      this.emit('gift', {
        username: usernameOf(d),
        nickname: nicknameOf(d),
        giftName: String(first(
          d?.giftName,
          gift?.giftName,
          d?.extendedGiftInfo?.name
        ) || 'Unknown'),
        repeatCount,
        totalValue: diamondCount * repeatCount
      });
    });

    c.on(WebcastEvent.LIKE, (d) => {
      this.emit('like', {
        username: usernameOf(d),
        nickname: nicknameOf(d),
        likeCount: numberOf(d?.likeCount, d?.like_count, d?.totalLikeCount, 1) || 1
      });
    });

    c.on(WebcastEvent.ROOM_USER, (d) => {
      this.emit('viewer', {
        viewerCount: numberOf(
          d?.viewerCount,
          d?.viewer_count,
          d?.roomUser?.viewerCount,
          d?.stats?.viewerCount,
          d?.stats?.viewer_count
        )
      });
    });

    c.on(WebcastEvent.MEMBER, (d) => {
      this.emit('member', {
        username: usernameOf(d),
        nickname: nicknameOf(d),
        memberCount: numberOf(d?.memberCount, d?.member_count)
      });
    });

    c.on(WebcastEvent.FOLLOW, (d) => {
      this.emit('follow', {
        username: usernameOf(d),
        nickname: nicknameOf(d)
      });
    });

    c.on(WebcastEvent.SHARE, (d) => {
      this.emit('share', {
        username: usernameOf(d),
        nickname: nicknameOf(d)
      });
    });
  }

  async start(u, roomId = '') {
    if (this.running) await this.stop();

    this.username = String(u || '').replace(/^@/, '').trim();
    let explicitRoomId = String(roomId || '').trim();

    if (!/^[A-Za-z0-9._-]{1,64}$/.test(this.username)) {
      throw Error('Username TikTok tidak valid.');
    }
    if (explicitRoomId && !/^\\d{5,30}$/.test(explicitRoomId)) {
      throw Error('Room ID TikTok harus berupa angka.');
    }

    console.log('[TikTok] START requested for @' + this.username + (explicitRoomId ? ' roomId=' + explicitRoomId : ''));
    this.setStatus('Connecting...');
    this.running = true;

    const connectionOptions = { enableExtendedGiftInfo: false };
    this.connection = new TikTokLiveConnection(this.username, connectionOptions);
    console.log('[TikTok] Euler signing: anonymous/community mode (no paid API key)');
    this.bind(this.connection);

    try {
      if (!explicitRoomId) {
        console.log('[TikTok] Automatic Room ID discovery: connector routes...');
        try {
          explicitRoomId = String(await this.connection.fetchRoomId() || '').trim();
          if (explicitRoomId) console.log('[TikTok] Connector discovered Room ID: ' + explicitRoomId);
        } catch (e) {
          console.warn('[TikTok] Connector Room ID discovery failed:', e?.message || String(e));
        }

        if (!explicitRoomId) {
          console.log('[TikTok] Automatic Room ID discovery: direct TikTok HTML fallback...');
          explicitRoomId = await directHtmlRoomId(this.username);
        }

        if (!explicitRoomId) {
          throw Error('Room ID otomatis tidak ditemukan dari connector maupun fallback HTML TikTok. Pastikan @' + this.username + ' sedang LIVE dan coba lagi.');
        }
      }

      console.log('[TikTok] Connecting to @' + this.username + ' using Room ID ' + explicitRoomId + '...');
      const result = await this.connection.connect(explicitRoomId);
      console.log('[TikTok] CONNECTED @' + this.username + ' roomId=' + (result?.roomId || explicitRoomId));
      return result;
    } catch (e) {
      this.running = false;
      const d = errorDetails(e);
      console.error('[TikTok] CONNECT FAILED @' + this.username, JSON.stringify(d));
      this.setStatus('Error', JSON.stringify(d));
      throw e;
    }
  }

  async stop() {
    const c = this.connection;
    this.running = false;
    this.connection = null;
    if (c) {
      try {
        await c.disconnect();
      } catch {}
    }
    this.setStatus('Disconnected');
  }
}
