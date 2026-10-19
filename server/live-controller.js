import { createEvent } from './events.js';
import { isEulerBusinessPlanError } from './signing-error.js';
import { redactText } from './diagnostics.js';

const validUsername = value => /^[A-Za-z0-9._-]{1,64}$/.test(value);
// Room ID discovery can fail on a cloud IP even while the broadcaster is LIVE.
// Managed Cloud WebSocket resolves by username and must not depend on Node's
// discovery or on a Business-only signing error.
export function isNativeRoomDiscoveryError(error) {
  const message = String(error?.message || error || '');
  return /failed to retrieve room id from all sources|room id live @.+ tidak dapat ditemukan otomatis|native room id discovery failed/i.test(message);
}
const canTryManaged = error => isEulerBusinessPlanError(error) || isNativeRoomDiscoveryError(error);
const permanentError = error => isEulerBusinessPlanError(error) || /API key .*tidak (?:diterima|valid)|tidak memiliki izin Cloud WebSocket|Konfigurasi Cloud WebSocket .*tidak valid/i.test(String(error?.message || error));

// Owns the desired state, session boundaries, event ordering and retry policy.
// Engines only own their transports. All operations use one serialized queue.
export class LiveController {
  constructor({ engines, emitEvent, onStatus = () => {}, persistDesired = () => {}, desired = {},
    autoReconnect = true, baseDelayMs = 2000, maxDelayMs = 60_000, maxAttempts = 10,
    now = Date.now, random = Math.random, setTimer = setTimeout, clearTimer = clearTimeout } = {}) {
    Object.assign(this, { engines, emitEvent, onStatus, persistDesired, autoReconnect,
      baseDelayMs, maxDelayMs, maxAttempts, now, random, setTimer, clearTimer });
    desired = desired && typeof desired === 'object' && !Array.isArray(desired) ? desired : {};
    this.desired = desired.running === true && validUsername(String(desired.username || '')) &&
      (!desired.roomId || /^\d{5,30}$/.test(String(desired.roomId)))
      ? { running: true, username: desired.username, roomId: desired.roomId || '' } : { running: false };
    this.status = 'Disconnected'; this.error = null; this.engine = 'none'; this.roomId = null;
    this.lastRoomId = null; this.attempts = 0; this.nextRetryAt = null; this.exhausted = false;
    this.operation = Promise.resolve(); this.generation = 0; this.connecting = false;
    this.closed = false; this.timer = null; this.pending = []; this.connectedAt = null;
    this.seen = new Map();
    this.startedEngines = new Set();
    this.nodeSignerBlocked = false;
  }

  snapshot() {
    return { status: this.status, error: this.error, engine: this.engine,
      username: this.desired.username || null, roomId: this.roomId,
      running: ['Connected', 'Connecting...'].includes(this.status), desiredRunning: this.desired.running === true,
      reconnectAttempts: this.attempts, nextRetryAt: this.nextRetryAt, recoveryExhausted: this.exhausted };
  }

  publish(status, error = null) {
    this.status = status;
    this.error = error ? redactText(error.message || error) : null;
    this.onStatus(this.snapshot());
  }

  enqueue(work) {
    const run = this.operation.then(work);
    this.operation = run.catch(() => {});
    return run;
  }

  cancelRetry() {
    this.clearTimer(this.timer); this.timer = null; this.nextRetryAt = null;
  }

  start(username, roomId = '') {
    username = String(username || '').replace(/^@/, '').trim();
    roomId = String(roomId || '').trim();
    if (!validUsername(username) || (roomId && !/^\d{5,30}$/.test(roomId))) return Promise.reject(Object.assign(Error('Akun atau Room ID TikTok tidak valid.'), { status: 400 }));
    if (this.closed || this.connecting || ['Connected', 'Connecting...', 'Reconnecting...', 'Stopping'].includes(this.status)) return Promise.reject(Object.assign(Error('LIVE sedang berjalan atau sedang diproses.'), { status: 409 }));
    const desired = { running: true, username, roomId };
    // Persist before acknowledging intent; failed writes never change runtime state.
    this.persistDesired(desired);
    this.desired = desired; this.attempts = 0; this.exhausted = false;
    // A new operator Start may follow an account upgrade; retry Node once.
    this.nodeSignerBlocked = false;
    this.seen.clear();
    this.cancelRetry(); const generation = ++this.generation;
    this.publish('Connecting...');
    return this.enqueue(() => this.connect(generation, false));
  }

  resume() {
    if (this.closed || !this.desired.running) return this.operation;
    const generation = ++this.generation;
    this.publish('Connecting...');
    return this.enqueue(() => this.connect(generation, true));
  }

  current(generation) { return generation === this.generation && !this.closed && this.desired.running; }

  async connect(generation, recovering) {
    if (!this.current(generation)) return this.snapshot();
    this.connecting = true;
    let failure;
    const choices = ['node', 'managed', 'python'];
    try {
      for (const name of choices) {
        const engine = this.engines[name];
        if (!engine || (name !== 'node' && !engine.enabled)) continue;
        if (name === 'node' && this.nodeSignerBlocked &&
            (this.engines.managed?.enabled || this.engines.python?.enabled)) continue;
        if (name === 'managed' && !this.nodeSignerBlocked && !canTryManaged(failure)) continue;
        this.engine = name; this.pending = []; this.startFailure = null;
        this.publish('Connecting...');
        try {
          this.startedEngines.add(name);
          const result = await engine.start(this.desired.username, this.desired.roomId);
          if (!this.current(generation)) { await engine.stop(); return this.snapshot(); }
          if (this.startFailure) throw this.startFailure;
          this.roomId = String(result?.roomId || engine.roomId || '') || null;
          const resumed = !!(recovering && this.roomId && this.roomId === this.lastRoomId);
          if (!resumed) this.seen.clear();
          this.lastRoomId = this.roomId;
          this.connecting = false; this.connectedAt = this.now();
          this.emitEvent(createEvent('stream', { state: 'started', username: this.desired.username, resumed }, this.meta()));
          // Native initial data and managed buffered data are always announced
          // after started, so session reset cannot erase already-counted events.
          const pending = this.pending.splice(0);
          for (const event of pending) this.deliver(event);
          engine.flushPendingEvents?.();
          this.publish('Connected');
          return this.snapshot();
        } catch (error) {
          failure = error;
          if (name === 'node' && isEulerBusinessPlanError(error)) {
            // Do not spend every reconnect attempt on an entitlement denied
            // by Eulerstream. Fall back to the managed/bridge transport.
            this.nodeSignerBlocked = true;
          }
          await Promise.resolve().then(() => engine.stop()).catch(() => {});
          this.startedEngines.delete(name);
          if (!this.current(generation)) return this.snapshot();
        }
      }
      throw failure || Error('Tidak ada engine LIVE yang tersedia.');
    } catch (error) {
      this.engine = 'none'; this.roomId = null; this.connecting = false; this.pending = [];
      if (this.current(generation)) { this.publish('Error', error); this.scheduleRetry(error); }
      throw error;
    } finally {
      this.connecting = false;
    }
  }

  meta() { return { username: this.desired.username, roomId: this.roomId }; }
  deliver(event) {
    if (!this.roomId && event.roomId) {
      this.roomId = String(event.roomId); this.lastRoomId = this.roomId;
      this.onStatus(this.snapshot());
    }
    const now = this.now();
    if (event.id && this.seen.has(event.id) && now - this.seen.get(event.id) < 600_000) return;
    if (event.id) {
      this.seen.delete(event.id); this.seen.set(event.id, now);
      while (this.seen.size > 10_000) this.seen.delete(this.seen.keys().next().value);
    }
    this.emitEvent({ ...event, username: this.desired.username, roomId: event.roomId || this.roomId });
  }

  onEngineEvent(name, event) {
    if (name !== this.engine || !this.desired.running || this.closed || this.status === 'Stopping') return;
    // Controller emits one lifecycle pair per connection; native also reports
    // lifecycle events internally, which must not reset totals a second time.
    if (event.event === 'stream') return;
    if (this.connecting) {
      if (this.pending.length >= 2000) this.startFailure = Error('Buffer awal LIVE penuh.');
      else this.pending.push(event);
    } else this.deliver(event);
  }

  onEngineStatus(name, status, error) {
    if (name !== this.engine || this.closed || !this.desired.running || this.status === 'Stopping') return;
    if (this.connecting) {
      if (status === 'Error' || status === 'Disconnected') this.startFailure = Error(error || 'Koneksi LIVE berakhir sebelum siap.');
      return;
    }
    if (status !== 'Error' && status !== 'Disconnected') return;
    this.emitEvent(createEvent('stream', { state: 'ended', reason: 'transport_closed' }, this.meta()));
    if (this.connectedAt !== null && this.now() - this.connectedAt >= 30_000) this.attempts = 0;
    const retired = this.engine;
    this.roomId = null; this.engine = 'none';
    // A lost polling link does not prove the remote Python bridge has stopped.
    // Retire it before starting another engine, so unused upstreams don't leak.
    void this.enqueue(async () => {
      try { await this.engines[retired]?.stop(); }
      finally { this.startedEngines.delete(retired); }
    }).catch(() => {});
    this.publish(status, error);
    this.scheduleRetry(error);
  }

  scheduleRetry(error) {
    if (this.closed || !this.desired.running || this.timer) return;
    if (!this.autoReconnect || this.attempts >= this.maxAttempts || permanentError(error)) {
      this.exhausted = true; this.publish(this.status, error); return;
    }
    const delay = Math.min(this.maxDelayMs, this.baseDelayMs * 2 ** Math.min(this.attempts, 16) * (0.8 + this.random() * 0.4));
    this.attempts++; this.nextRetryAt = this.now() + Math.round(delay);
    const generation = this.generation;
    this.timer = this.setTimer(() => {
      this.timer = null; this.nextRetryAt = null;
      if (!this.current(generation)) return;
      void this.enqueue(() => this.connect(generation, true)).catch(() => {});
    }, delay);
    this.timer?.unref?.();
    this.publish('Reconnecting...', error);
  }

  stop({ shutdown = false } = {}) {
    if (!shutdown) {
      this.persistDesired({ ...this.desired, running: false });
      this.desired = { ...this.desired, running: false };
    } else this.closed = true; // Keep persisted intent so process restart resumes.
    this.cancelRetry(); this.generation++; this.publish('Stopping');
    return this.enqueue(async () => {
      await Promise.allSettled([...this.startedEngines].map(name => this.engines[name]?.stop()));
      this.startedEngines.clear();
      if (this.roomId) this.emitEvent(createEvent('stream', { state: 'ended', reason: shutdown ? 'shutdown' : 'stopped' }, this.meta()));
      this.engine = 'none'; this.roomId = null; this.pending = []; this.exhausted = false;
      this.publish('Disconnected'); return this.snapshot();
    });
  }
}
