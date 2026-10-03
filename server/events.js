import crypto from 'node:crypto';

const MAX_SERIALIZED_BYTES = 256 * 1024;

export function safeJsonValue(value, depth = 0, seen = new WeakSet()) {
  if (depth > 10) return '[MaxDepth]';
  if (value === null || typeof value === 'string' || typeof value === 'boolean') return value;
  if (typeof value === 'number') return Number.isFinite(value) ? value : null;
  if (typeof value === 'bigint') return value.toString();
  if (typeof value === 'undefined' || typeof value === 'function' || typeof value === 'symbol') return undefined;
  if (typeof value === 'object') {
    if (seen.has(value)) return '[Circular]';
    seen.add(value);
    if (Array.isArray(value)) return value.slice(0, 1000).map(v => safeJsonValue(v, depth + 1, seen));
    const out = {};
    for (const [key, item] of Object.entries(value).slice(0, 1000)) {
      const safe = safeJsonValue(item, depth + 1, seen);
      if (safe !== undefined) out[key] = safe;
    }
    seen.delete(value);
    return out;
  }
  return String(value);
}

export function serializeEvent(event) {
  const safe = safeJsonValue(event);
  const json = JSON.stringify(safe);
  if (Buffer.byteLength(json, 'utf8') > MAX_SERIALIZED_BYTES) {
    return JSON.stringify({
      id: event?.id || crypto.randomUUID(),
      event: event?.event || 'unknown',
      timestamp: event?.timestamp || new Date().toISOString(),
      data: { truncated: true, reason: 'payload_too_large' }
    });
  }
  return json;
}

export function createEvent(type, data, meta = {}) {
  return {
    id: crypto.randomUUID(),
    event: String(type),
    timestamp: new Date().toISOString(),
    roomId: meta.roomId || null,
    username: meta.username || null,
    version: 1,
    data: safeJsonValue(data)
  };
}
