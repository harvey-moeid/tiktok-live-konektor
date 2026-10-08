import { createEvent } from './events.js';

export function pythonFallbackConfig(env = process.env) {
  const hostname = String(env.PYTHON_FALLBACK_HOSTNAME || '').trim();
  const explicit = String(env.PYTHON_FALLBACK_URL || '').trim();
  const endpoint = explicit || (hostname ? 'https://' + hostname : '');
  const token = String(env.PYTHON_FALLBACK_TOKEN || '').trim();
  if (!endpoint || token.length < 32) return null;
  const url = new URL(endpoint);
  if (url.protocol !== 'https:' || url.username || url.password || url.search || url.hash || url.pathname !== '/') {
    throw Error('PYTHON_FALLBACK_URL harus URL HTTPS origin tanpa path atau credentials.');
  }
  return { endpoint: url.origin, token };
}

export class PythonLiveFallback {
  constructor({ config = pythonFallbackConfig(), fetchImpl = globalThis.fetch, emitEvent = () => {}, setStatus = () => {}, pollIntervalMs = 1200 } = {}) {
    this.config = config;
    this.fetchImpl = fetchImpl;
    this.emitEvent = emitEvent;
    this.setStatus = setStatus;
    this.pollIntervalMs = pollIntervalMs;
    this.active = false;
    this.cursor = 0;
    this.failures = 0;
    this.timer = null;
    this.generation = 0;
    this.roomId = '';
    this.username = '';
  }

  get enabled() { return !!this.config; }

  async request(path, { method = 'GET', body, timeoutMs = 10000 } = {}) {
    if (!this.enabled) throw Error('Python fallback belum dikonfigurasi.');
    const response = await this.fetchImpl(this.config.endpoint + path, {
      method,
      headers: {
        Authorization: 'Bearer ' + this.config.token,
        ...(body ? { 'Content-Type': 'application/json' } : {})
      },
      ...(body ? { body: JSON.stringify(body) } : {}),
      signal: AbortSignal.timeout(timeoutMs)
    });
    const data = await response.json().catch(() => ({}));
    if (!response.ok || !data || data.ok === false) {
      const detail = data?.error || (typeof data?.detail === 'string' ? data.detail : null);
      throw Error(String(detail || 'Python fallback HTTP ' + response.status).slice(0, 500));
    }
    return data;
  }

  async start(username, roomId = '') {
    if (!this.enabled) throw Error('Python fallback belum dikonfigurasi.');
    this.generation++;
    const generation = this.generation;
    clearTimeout(this.timer);
    this.active = false;
    this.cursor = 0;
    this.failures = 0;
    this.username = username;
    this.roomId = roomId;
    // Python deliberately resolves the username independently. A stale manual Room ID
    // from the Node engine must not be trusted by the second engine.
    const result = await this.request('/start', {
      method: 'POST', body: { username }, timeoutMs: 35000
    });
    if (generation !== this.generation) throw Error('Python fallback dibatalkan.');
    if (result.status !== 'connected') throw Error('Python fallback belum berhasil tersambung.');
    this.roomId = String(result.roomId || roomId || '');
    this.active = true;
    this.timer = setTimeout(() => { void this.poll(generation); }, 0);
    return { roomId: this.roomId };
  }

  async poll(generation = this.generation) {
    if (!this.active || generation !== this.generation) return;
    let delayMs = this.pollIntervalMs;
    try {
      const result = await this.request('/events?after=' + this.cursor, { timeoutMs: 8000 });
      if (!this.active || generation !== this.generation) return;
      if (result.status !== 'connected') {
        this.active = false;
        this.setStatus(result.status === 'error' ? 'Error' : 'Disconnected', result.error || null);
        return;
      }
      if (result.dropped) console.warn('[python-fallback] Event buffer overrun; some events were lost.');
      for (const item of result.events || []) {
        if (!Number.isSafeInteger(item?.seq) || item.seq <= this.cursor) continue;
        this.cursor = item.seq;
        if (!['chat', 'like', 'gift', 'follow', 'share', 'member', 'viewer'].includes(item.event)) continue;
        this.emitEvent(createEvent(item.event, item.data || {}, {
          username: this.username, roomId: this.roomId || result.roomId || null
        }));
      }
      this.failures = 0;
      if (Number(result.latestSeq) > this.cursor) delayMs = 0;
    } catch (err) {
      if (!this.active || generation !== this.generation) return;
      this.failures++;
      console.warn('[python-fallback] Poll failed (' + this.failures + '):', err.message);
      if (this.failures >= 3) {
        this.active = false;
        this.setStatus('Error', 'Python fallback kehilangan koneksi: ' + err.message);
        return;
      }
      delayMs = 2000;
    }
    if (this.active && generation === this.generation) {
      this.timer = setTimeout(() => { void this.poll(generation); }, delayMs);
    }
  }

  async stop() {
    this.generation++;
    this.active = false;
    clearTimeout(this.timer);
    if (!this.enabled) return;
    try { await this.request('/stop', { method: 'POST', timeoutMs: 7000 }); }
    catch (err) { console.warn('[python-fallback] Stop warning:', err.message); }
  }
}
