import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';

const filePath = path.resolve(process.env.CONFIG_FILE || './data/config.json');
const defaultConfig = {
  tiktokUsername: process.env.TIKTOK_USERNAME || '',
  tiktokRoomId: process.env.TIKTOK_ROOM_ID || '',
  webhooks: [],
  wsToken: process.env.WS_TOKEN || crypto.randomBytes(24).toString('hex'),
  maxFeedEvents: Number(process.env.MAX_FEED_EVENTS || 500),
  passwordHash: ''
};
let config = { ...defaultConfig };

try {
  if (fs.existsSync(filePath)) config = { ...config, ...JSON.parse(fs.readFileSync(filePath, 'utf8')) };
} catch (e) {
  if (process.env.NODE_ENV === 'production') throw Error('CONFIG_FILE tidak dapat dibaca: ' + e.message);
  console.warn('[config] Could not load config file:', e?.message || String(e));
}

// Deployment environment is the durable baseline. A stale runtime config must not
// silently override the configured default LIVE account after a redeploy.
if (String(process.env.TIKTOK_USERNAME || '').trim()) {
  config.tiktokUsername = String(process.env.TIKTOK_USERNAME).replace(/^@/, '').trim();
}
if (String(process.env.TIKTOK_ROOM_ID || '').trim()) {
  config.tiktokRoomId = String(process.env.TIKTOK_ROOM_ID).trim();
}

export function getConfig() { return structuredClone(config); }

if (process.env.WS_TOKEN) config.wsToken = process.env.WS_TOKEN;

export function updateConfig(patch) {
  const next = { ...config, ...patch };
  const temporary = filePath + '.' + crypto.randomUUID() + '.tmp';
  try {
    fs.mkdirSync(path.dirname(filePath), { recursive: true, mode: 0o700 });
    fs.writeFileSync(temporary, JSON.stringify(next, null, 2), { mode: 0o600 });
    fs.renameSync(temporary, filePath);
  } catch (e) {
    try { fs.unlinkSync(temporary); } catch {}
    console.warn('[config] Could not persist config:', e.code || 'write failed');
    throw Error('Konfigurasi tidak dapat disimpan.');
  }
  config = next;
  return getConfig();
}

export function getSafeConfig() {
  const c = getConfig();
  delete c.wsToken;
  delete c.passwordHash;
  delete c.revokedSessions;
  c.webhookSigningEnabled = Boolean(process.env.WEBHOOK_SIGNING_SECRET);
  return c;
}
