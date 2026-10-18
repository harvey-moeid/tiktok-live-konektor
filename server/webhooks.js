import { serializeEvent } from './events.js';
import { publicWebhookUrl } from '../client/src/webhook-url.js';
import { sendWebhook } from './webhook-delivery.js';
import { WebhookOutbox } from './webhook-outbox.js';
import crypto from 'node:crypto';
import path from 'node:path';

let outbox;

function setting(name, fallback, min, max) {
  const value = Number(process.env[name] ?? fallback);
  return Number.isFinite(value) ? Math.min(max, Math.max(min, Math.trunc(value))) : fallback;
}

export function initializeWebhooks(webhooks = []) {
  if (outbox) return;
  const directory = path.dirname(path.resolve(process.env.CONFIG_FILE || './data/config.json'));
  outbox = new WebhookOutbox({
    file: path.resolve(process.env.WEBHOOK_OUTBOX_FILE || path.join(directory, 'webhook-outbox.sqlite')),
    capacity: setting('WEBHOOK_QUEUE_CAPACITY', 10_000, 20, 100_000),
    maxBytes: setting('WEBHOOK_QUEUE_MAX_BYTES', 100 * 1024 * 1024, 1024 * 1024, 1024 * 1024 * 1024),
    maxAttempts: setting('WEBHOOK_RETRIES', 3, 0, 20) + 1,
    autoStart: false,
    onError: code => console.warn('[webhook-outbox]', code),
    deliver: (job, signal) => sendWebhook(job.url, job.body,
      webhookHeaders({ id: job.event_id, version: job.version }, job.body),
      setting('WEBHOOK_TIMEOUT_MS', 5000, 1000, 15000), signal)
  });
  reconcileWebhooks(webhooks);
  outbox.start();
}

export function reconcileWebhooks(webhooks) {
  outbox?.reconcile(webhooks.filter(h => h.enabled !== false).map(h => h.url));
}
export function webhookStatus() { return outbox?.snapshot() || { pending: 0, failed: 0, active: 0, rejected: 0, storageErrors: 0, paused: false }; }
export function retryWebhooks() { return outbox?.retryFailed() || 0; }
export async function closeWebhooks() { if (outbox) await outbox.close(); }

export function webhookHeaders(event, body, secret = process.env.WEBHOOK_SIGNING_SECRET || '') {
  const headers = {
    'content-type': 'application/json',
    'x-tlk-event-id': String(event.id || ''),
    'x-tlk-event-version': String(event.version || 1)
  };
  if (secret) {
    const timestamp = String(Math.floor(Date.now() / 1000));
    headers['x-tlk-timestamp'] = timestamp;
    headers['x-tlk-signature'] = 'sha256=' + crypto.createHmac('sha256', secret).update(timestamp + '.' + body).digest('hex');
  }
  return headers;
}

export function normalizeWebhooks(value) {
  if (!Array.isArray(value)) return [];
  if (value.length > 20) throw Error('Maksimal 20 webhook.');
  const seen = new Set();

  return value.map((raw, index) => {
    if (!raw || typeof raw !== 'object') throw Error(`Webhook #${index + 1} tidak valid.`);
    if (process.env.NODE_ENV === 'production' && raw.enabled !== false && !process.env.WEBHOOK_SIGNING_SECRET) {
      throw Error('WEBHOOK_SIGNING_SECRET wajib diisi sebelum mengaktifkan webhook produksi.');
    }
    const url = String(raw.url || '').trim();
    if (!url || url.length > 2048) throw Error(`URL webhook #${index + 1} tidak valid.`);
    let parsed;
    try { parsed = publicWebhookUrl(url); } catch { throw Error(`Webhook #${index + 1} wajib memakai HTTPS publik tanpa kredensial atau alamat IP.`); }
    if (seen.has(parsed.toString())) throw Error('URL webhook duplikat.');
    seen.add(parsed.toString());
    const events = Array.isArray(raw.events)
      ? [...new Set(raw.events.map(x => String(x).trim()).filter(x => /^[A-Za-z0-9._:-]{1,64}$/.test(x)))].slice(0, 50)
      : [];
    return { url: parsed.toString(), enabled: raw.enabled !== false, events };
  });
}

export async function dispatchWebhook(event, webhooks) {
  const targets = (webhooks || []).filter(h =>
    h && h.enabled !== false && /^https:\/\//i.test(String(h.url || '')) &&
    (!Array.isArray(h.events) || !h.events.length || h.events.includes(event.event))
  );
  if (!targets.length) return;

  if (!outbox) initializeWebhooks(webhooks);
  const body = serializeEvent(event);
  // Resolves after the durable commit, not after network delivery.
  return outbox.enqueue(event, body, targets.map(h => h.url));
}
