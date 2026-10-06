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

export function updateConfig(patch) {
  config = { ...config, ...patch };
  try {
    fs.mkdirSync(path.dirname(filePath), { recursive: true });
    fs.writeFileSync(filePath, JSON.stringify(config, null, 2), { mode: 0o600 });
  } catch (e) {
    console.warn('[config] Could not persist config:', e?.message || String(e));
  }
  return getConfig();
}

export function getSafeConfig() {
  const c = getConfig();
  delete c.wsToken;
  delete c.passwordHash;
  return c;
}
