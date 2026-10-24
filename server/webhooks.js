import { serializeEvent } from './events.js';
import { publicWebhookUrl } from '../client/src/webhook-url.js';
import { sendWebhook } from './webhook-delivery.js';
import { WorkQueue } from './work-queue.js';
import crypto from 'node:crypto';

const deliveryQueue = new WorkQueue();

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

const wait = ms => new Promise(resolve => setTimeout(resolve, ms));

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

  let body;
  try { body = serializeEvent(event); } catch { return; }
  await Promise.allSettled(targets.map(h => deliveryQueue.run(async () => {
    const configuredRetries = Number(process.env.WEBHOOK_RETRIES ?? 3);
    const configuredTimeout = Number(process.env.WEBHOOK_TIMEOUT_MS ?? 5000);
    const retries = Number.isFinite(configuredRetries) ? Math.min(Math.max(Math.trunc(configuredRetries), 0), 5) : 3;
    const timeoutMs = Number.isFinite(configuredTimeout) ? Math.min(Math.max(configuredTimeout, 1000), 15000) : 5000;

    for (let attempt = 0; attempt <= retries; attempt++) {
      try {
        await sendWebhook(String(h.url), body, webhookHeaders(event, body), timeoutMs);
        return;
      } catch (e) {
        if (attempt === retries) {
          console.warn('[webhook]', new URL(h.url).hostname, e?.code || 'delivery failed');
          return;
        }
        await wait(Math.min(1500 * 2 ** attempt, 6000));
      }
    }
  }).then(accepted => {
    if (!accepted) console.warn('[webhook] Queue penuh; event delivery dilewati.');
  })));
}
