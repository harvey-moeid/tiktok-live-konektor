// Shared, side-effect-free draft helpers for the admin webhook editor.
export const MAX_WEBHOOKS = 20;
export const WEBHOOK_EVENT_OPTIONS = [
  ['chat', 'Komentar'],
  ['like', 'Like'],
  ['gift', 'Gift'],
  ['follow', 'Follow'],
  ['share', 'Share'],
  ['member', 'Masuk'],
  ['viewer', 'Viewer'],
  ['stream', 'Status LIVE']
];
export const KNOWN_WEBHOOK_EVENTS = new Set(WEBHOOK_EVENT_OPTIONS.map(([id]) => id));
const EVENT_PATTERN = /^[A-Za-z0-9._:-]{1,64}$/;

export function copyWebhookRows(source) {
  if (!Array.isArray(source)) return [];
  return source.map(row => ({
    url: String(row?.url || ''),
    enabled: row?.enabled !== false,
    events: Array.isArray(row?.events) ? row.events.map(String) : []
  }));
}

export function toggleWebhookEvent(events, event) {
  if (!EVENT_PATTERN.test(event)) return Array.isArray(events) ? [...events] : [];
  if (!Array.isArray(events) || events.length === 0) return [event]; // [] means all
  return events.includes(event) ? events.filter(type => type !== event) : [...events, event];
}

export function parseCustomWebhookEvents(text) {
  const names = String(text || '').split(',').map(value => value.trim()).filter(Boolean);
  if (!names.length) return { events: [], error: 'Masukkan minimal satu nama event.' };
  if (names.some(name => !EVENT_PATTERN.test(name))) {
    return { events: [], error: 'Nama event hanya boleh huruf, angka, titik, garis bawah, titik dua, atau tanda minus (maks. 64 karakter).' };
  }
  return { events: [...new Set(names)], error: null };
}

export function validateWebhookRows(rows) {
  if (!Array.isArray(rows)) return 'Daftar webhook tidak valid.';
  if (rows.length > MAX_WEBHOOKS) return 'Maksimal 20 webhook.';
  const seen = new Set();
  for (let index = 0; index < rows.length; index++) {
    const number = index + 1;
    const row = rows[index];
    const value = String(row?.url || '').trim();
    if (!value || value.length > 2048) return 'Webhook #' + number + ': URL wajib diisi dan maksimal 2048 karakter.';
    let url;
    try { url = new URL(value); } catch { return 'Webhook #' + number + ': format URL tidak valid.'; }
    const hostname = url.hostname.toLowerCase();
    if (url.protocol !== 'https:' || url.username || url.password ||
      ['localhost', '127.0.0.1', '::1', '0.0.0.0'].includes(hostname) ||
      hostname.endsWith('.localhost')) {
      return 'Webhook #' + number + ': gunakan HTTPS publik tanpa username/password.';
    }
    if (seen.has(url.toString())) return 'URL webhook duplikat: hapus salah satu agar event tidak terkirim dua kali.';
    seen.add(url.toString());
    if (!Array.isArray(row.events) || row.events.length > 50 ||
      row.events.some(event => typeof event !== 'string' || !EVENT_PATTERN.test(event))) {
      return 'Webhook #' + number + ': event tidak valid atau lebih dari 50 jenis.';
    }
  }
  return null;
}
