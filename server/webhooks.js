import { serializeEvent } from './events.js';

const wait = ms => new Promise(resolve => setTimeout(resolve, ms));
const LOCAL_HOSTS = new Set(['localhost', '127.0.0.1', '::1', '0.0.0.0']);

export function normalizeWebhooks(value) {
  if (!Array.isArray(value)) return [];
  if (value.length > 20) throw Error('Maksimal 20 webhook.');

  return value.map((raw, index) => {
    if (!raw || typeof raw !== 'object') throw Error(`Webhook #${index + 1} tidak valid.`);
    const url = String(raw.url || '').trim();
    if (!url || url.length > 2048) throw Error(`URL webhook #${index + 1} tidak valid.`);
    let parsed;
    try { parsed = new URL(url); } catch { throw Error(`URL webhook #${index + 1} tidak valid.`); }
    const hostname = parsed.hostname.toLowerCase();
    if (parsed.protocol !== 'https:' || parsed.username || parsed.password || LOCAL_HOSTS.has(hostname) || hostname.endsWith('.localhost')) {
      throw Error(`Webhook #${index + 1} wajib memakai HTTPS publik tanpa kredensial di URL.`);
    }
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

  const body = serializeEvent(event);
  await Promise.allSettled(targets.map(async h => {
    const retries = Math.min(Math.max(Number(process.env.WEBHOOK_RETRIES || 3), 0), 5);
    const timeoutMs = Math.min(Math.max(Number(process.env.WEBHOOK_TIMEOUT_MS || 5000), 1000), 15000);

    for (let attempt = 0; attempt <= retries; attempt++) {
      try {
        const controller = new AbortController();
        const timer = setTimeout(() => controller.abort(), timeoutMs);
        try {
          const response = await fetch(String(h.url), {
            method: 'POST',
            headers: {
              'content-type': 'application/json',
              'x-tlk-event-id': String(event.id || ''),
              'x-tlk-event-version': String(event.version || 1)
            },
            body,
            signal: controller.signal,
            redirect: 'error'
          });
          if (!response.ok) throw Error('HTTP ' + response.status);
        } finally {
          clearTimeout(timer);
        }
        return;
      } catch (e) {
        if (attempt === retries) {
          console.warn('[webhook]', h.url, e?.message || String(e));
          return;
        }
        await wait(Math.min(1500 * 2 ** attempt, 6000));
      }
    }
  }));
}
