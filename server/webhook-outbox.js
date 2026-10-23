import { DatabaseSync } from 'node:sqlite';
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';

// Single-process durable outbox. A successful enqueue commits all destinations
// before delivery. A crash after the receiver accepts but before DELETE may
// replay the same event ID: consumers must be idempotent.
export class WebhookOutbox {
  constructor({ file, deliver, concurrency = 4, capacity = 10_000, maxBytes = 100 * 1024 * 1024,
    maxAttempts = 4, retryDelay = attempt => Math.min(1500 * 2 ** (attempt - 1), 60_000),
    now = Date.now, onError = () => {}, autoStart = true } = {}) {
    Object.assign(this, { deliver, concurrency, capacity, maxBytes, maxAttempts, retryDelay, now, onError });
    this.active = new Map(); this.closing = false; this.timer = null;
    this.rejected = 0; this.storageErrors = 0; this.lastError = null; this.started = false;
    this.allowedUrls = null;
    this.acknowledgedRejected = 0; this.acknowledgedStorageErrors = 0;
    fs.mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 });
    this.db = new DatabaseSync(file);
    fs.chmodSync(file, 0o600);
    this.db.exec(`PRAGMA journal_mode=WAL; PRAGMA synchronous=FULL; PRAGMA busy_timeout=5000;
      CREATE TABLE IF NOT EXISTS deliveries (
        id TEXT PRIMARY KEY, url TEXT NOT NULL, event_id TEXT NOT NULL,
        version INTEGER NOT NULL, body TEXT NOT NULL, bytes INTEGER NOT NULL,
        state TEXT NOT NULL DEFAULT 'pending', attempts INTEGER NOT NULL DEFAULT 0,
        next_at INTEGER NOT NULL, created_at INTEGER NOT NULL, last_error TEXT);
      CREATE INDEX IF NOT EXISTS deliveries_due ON deliveries(state, next_at);`);
    // Bound the database in addition to the logical payload budget. WAL is
    // checkpointed by SQLite; do not copy a live database without its WAL.
    this.db.exec(`PRAGMA max_page_count=${Math.max(256, Math.ceil(maxBytes * 1.5 / 4096))};`);
    this.refreshSize();
    if (autoStart) this.start();
  }

  refreshSize() {
    const row = this.db.prepare('SELECT count(*) AS count, coalesce(sum(bytes), 0) AS bytes FROM deliveries').get();
    this.count = row.count; this.bytes = row.bytes;
  }

  recordError(error) {
    this.lastError = String(error?.code || 'outbox_error').slice(0, 80);
    this.onError(this.lastError);
  }

  enqueue(event, body, urls) {
    if (this.closing) throw Error('Webhook outbox sedang ditutup.');
    const now = this.now();
    const jobs = [...new Set(urls)].map(url => ({
      id: crypto.createHash('sha256').update(JSON.stringify([String(event.id), url])).digest('hex'),
      url, bytes: Buffer.byteLength(body) + Buffer.byteLength(url) + 512
    })).filter(job => !this.db.prepare('SELECT 1 FROM deliveries WHERE id = ?').get(job.id));
    if (!jobs.length) return 0;
    const bytes = jobs.reduce((sum, x) => sum + x.bytes, 0);
    if (this.count + jobs.length > this.capacity || this.bytes + bytes > this.maxBytes) {
      this.rejected += jobs.length;
      const error = Object.assign(Error('Kapasitas webhook outbox penuh.'), { code: 'OUTBOX_FULL' });
      this.recordError(error); throw error;
    }
    try {
      this.db.exec('BEGIN IMMEDIATE');
      const insert = this.db.prepare('INSERT INTO deliveries(id, url, event_id, version, body, bytes, next_at, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)');
      for (const job of jobs) insert.run(job.id, job.url, String(event.id), Number(event.version) || 1, body, job.bytes, now, now);
      this.db.exec('COMMIT');
    } catch (error) {
      try { this.db.exec('ROLLBACK'); } catch {}
      this.storageErrors++; this.recordError(error); throw error;
    }
    this.count += jobs.length; this.bytes += bytes;
    if (this.started) this.drain();
    return jobs.length;
  }

  start() {
    if (this.started || this.closing) return;
    this.started = true; this.drain();
  }

  nextJob() {
    const ids = [...this.active.keys()];
    return this.db.prepare(`SELECT * FROM deliveries WHERE state = 'pending'
      ${ids.length ? `AND id NOT IN (${ids.map(() => '?').join(',')})` : ''}
      ORDER BY next_at, created_at, id LIMIT 1`).get(...ids);
  }

  drain() {
    clearTimeout(this.timer); this.timer = null;
    if (this.closing || !this.started || !this.db) return;
    try {
      while (this.active.size < this.concurrency) {
        const job = this.nextJob();
        if (!job) return;
        if (job.next_at > this.now()) {
          this.timer = setTimeout(() => this.drain(), Math.max(1, job.next_at - this.now()));
          this.timer.unref?.(); return;
        }
        const controller = new AbortController();
        const active = { controller, promise: null, url: job.url };
        this.active.set(job.id, active);
        active.promise = this.attempt(job, controller.signal).catch(error => {
          this.storageErrors++; this.recordError(error);
          // Storage failure keeps the original job on disk. Avoid spinning on
          // a broken disk; an operator can see it in delivery diagnostics.
          this.started = false;
        }).finally(() => { this.active.delete(job.id); this.drain(); });
      }
    } catch (error) {
      this.storageErrors++; this.recordError(error); this.started = false;
    }
  }

  async attempt(job, signal) {
    if (this.allowedUrls && !this.allowedUrls.has(job.url)) {
      this.started = false;
      this.recordError({ code: 'OUTBOX_DESTINATION_DISABLED' });
      return;
    }
    const attempts = job.attempts + 1;
    this.db.prepare('UPDATE deliveries SET attempts = ? WHERE id = ?').run(attempts, job.id);
    try {
      await this.deliver(job, signal);
    } catch (error) {
      if (!this.db || this.closing || signal.aborted) return; // Leave job for restart.
      const code = String(error?.code || 'delivery_failed').slice(0, 80);
      this.db.prepare('UPDATE deliveries SET state = ?, next_at = ?, last_error = ? WHERE id = ?')
        .run(attempts >= this.maxAttempts ? 'failed' : 'pending', this.now() + this.retryDelay(attempts), code, job.id);
      if (attempts >= this.maxAttempts) this.recordError(Object.assign(Error(code), { code }));
      return;
    }
    if (!this.db) return;
    const removed = this.db.prepare('DELETE FROM deliveries WHERE id = ?').run(job.id).changes;
    if (removed) { this.count--; this.bytes -= job.bytes; }
  }

  reconcile(urls) {
    const allowed = new Set(urls);
    this.allowedUrls = allowed;
    for (const active of this.active.values()) if (!allowed.has(active.url)) active.controller.abort();
    try {
      this.db.prepare(`DELETE FROM deliveries ${allowed.size ? `WHERE url NOT IN (${[...allowed].map(() => '?').join(',')})` : ''}`).run(...allowed);
      this.refreshSize();
    } catch (error) {
      this.started = false; this.storageErrors++; this.recordError(error); throw error;
    }
  }

  retryFailed() {
    if (this.closing) throw Error('Webhook outbox sedang ditutup.');
    const result = this.db.prepare("UPDATE deliveries SET state='pending', attempts=0, next_at=?, last_error=NULL WHERE state='failed'").run(this.now());
    // The successful write above verifies storage before acknowledging the incident.
    this.acknowledgedRejected = this.rejected;
    this.acknowledgedStorageErrors = this.storageErrors;
    this.lastError = null; this.started = true; this.drain();
    return result.changes;
  }

  snapshot() {
    const pending = this.db.prepare("SELECT count(*) AS count, min(created_at) AS oldest FROM deliveries WHERE state='pending'").get();
    const failed = this.db.prepare("SELECT count(*) AS count FROM deliveries WHERE state='failed'").get();
    return { pending: pending.count, failed: failed.count, active: this.active.size,
      bytes: this.bytes, capacity: this.capacity, maxBytes: this.maxBytes,
      oldestPendingAt: pending.oldest ? new Date(pending.oldest).toISOString() : null,
      rejected: this.rejected, storageErrors: this.storageErrors, lastError: this.lastError,
      needsAttention: this.rejected > this.acknowledgedRejected || this.storageErrors > this.acknowledgedStorageErrors,
      paused: !this.started && !this.closing };
  }

  async close({ timeoutMs = 5000 } = {}) {
    this.closing = true; clearTimeout(this.timer);
    let timer;
    await Promise.race([
      Promise.allSettled([...this.active.values()].map(x => x.promise)),
      new Promise(resolve => { timer = setTimeout(resolve, timeoutMs); })
    ]);
    clearTimeout(timer);
    for (const active of this.active.values()) active.controller.abort();
    this.db.close(); this.db = null;
  }
}
