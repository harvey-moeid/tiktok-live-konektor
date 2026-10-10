import proxyaddr from 'proxy-addr';

// Render terminates HTTPS at one reverse proxy. Direct deployments should use 0.
export function trustProxy(env = process.env) {
  const value = env.TRUST_PROXY ?? (env.NODE_ENV === 'production' ? '1' : '0');
  if (!/^\d+$/.test(value) || Number(value) > 10) throw Error('TRUST_PROXY harus 0–10.');
  return Number(value);
}

export function clientIp(req, hops = trustProxy()) {
  return proxyaddr(req, (_address, index) => index < hops);
}

export function sameOrigin(req) {
  if (req.headers['sec-fetch-site'] === 'cross-site') return false;
  const origin = req.headers.origin;
  if (!origin) return true;
  try {
    const url = new URL(origin);
    return ['http:', 'https:'].includes(url.protocol) && url.host === req.headers.host;
  } catch { return false; }
}

export function protectAdminOrigin(req, res, next) {
  if (!sameOrigin(req)) return res.status(403).json({ error: 'Origin dashboard tidak diizinkan.' });
  next();
}

export function validPassword(value, minimum = 12) {
  return typeof value === 'string' && value.length >= minimum && Buffer.byteLength(value, 'utf8') <= 72 &&
    !/^(change-me|change-this|password|temporary-test)/i.test(value);
}

export function validateProduction(env = process.env) {
  trustProxy(env);
  if (env.NODE_ENV !== 'production') return;
  for (const name of ['JWT_SECRET', 'WS_TOKEN']) {
    const value = env[name] || '';
    if (value.length < 32 || /^(change-me|change-this|temporary-test)/i.test(value)) {
      throw Error(name + ' wajib berupa secret produksi minimal 32 karakter.');
    }
  }
  if (!env.ADMIN_USERNAME?.trim()) throw Error('ADMIN_USERNAME wajib diisi pada production.');
  if (env.ADMIN_PASSWORD && !validPassword(env.ADMIN_PASSWORD)) throw Error('ADMIN_PASSWORD wajib 12+ karakter, maksimal 72 byte, tanpa placeholder.');
  if (env.API_KEY && (env.API_KEY.length < 32 || /^(change-me|change-this)/i.test(env.API_KEY))) {
    throw Error('API_KEY wajib minimal 32 karakter tanpa placeholder.');
  }
  if (env.WEBHOOK_SIGNING_SECRET && env.WEBHOOK_SIGNING_SECRET.length < 32) throw Error('WEBHOOK_SIGNING_SECRET wajib minimal 32 karakter.');
  const secrets = [env.JWT_SECRET, env.WS_TOKEN, env.API_KEY].filter(Boolean);
  if (new Set(secrets).size !== secrets.length) throw Error('JWT_SECRET, WS_TOKEN, dan API_KEY harus berbeda.');
}
