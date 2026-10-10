import bcrypt from 'bcryptjs';
import jwt from 'jsonwebtoken';
import crypto from 'node:crypto';
import { getConfig, updateConfig } from './config.js';
import { validPassword, validateProduction } from './security.js';

validateProduction();

const secret = process.env.JWT_SECRET;
const username = process.env.ADMIN_USERNAME || 'admin';

if (process.env.NODE_ENV === 'production' && (!secret || secret.length < 32)) {
  throw Error('JWT_SECRET wajib diisi dan minimal 32 karakter pada production.');
}
const jwtSecret = secret || 'dev-only-secret-change-me';
const envPassword = process.env.ADMIN_PASSWORD || '';
const revoked = new Map(getConfig().revokedSessions || []);
function passwordVersion() {
  return crypto.createHash('sha256').update(passwordHash).digest('hex');
}
let passwordHash = getConfig().passwordHash || (envPassword ? bcrypt.hashSync(envPassword, 12) : '');

if (!passwordHash) {
  if (process.env.NODE_ENV === 'production') throw Error('ADMIN_PASSWORD wajib diisi pada first startup production.');
  passwordHash = bcrypt.hashSync('change-me-now', 12);
}
if (envPassword && !getConfig().passwordHash) updateConfig({ passwordHash });

export async function setPassword(password) {
  if (!validPassword(password)) throw Error('Password minimal 12 karakter dan maksimal 72 byte, tanpa placeholder.');
  const nextHash = await bcrypt.hash(password, 12);
  updateConfig({ passwordHash: nextHash });
  passwordHash = nextHash;
}

export async function login(u, p) {
  if (!u || !p || Buffer.byteLength(p, 'utf8') > 72 || u !== username || !(await bcrypt.compare(p, passwordHash))) return null;
  return jwt.sign({ sub: username, jti: crypto.randomUUID(), pv: passwordVersion() }, jwtSecret, { expiresIn: '12h', algorithm: 'HS256' });
}

export function verify(token) {
  if (!token) throw Error('Missing token');
  const claims = jwt.verify(token, jwtSecret, { algorithms: ['HS256'] });
  if (claims.sub !== username || claims.pv !== passwordVersion() || revoked.has(claims.jti)) throw Error('Session tidak berlaku.');
  return claims;
}

export function revokeSession(claims) {
  const now = Math.floor(Date.now() / 1000);
  for (const [id, expires] of revoked) if (expires <= now) revoked.delete(id);
  const next = new Map(revoked);
  next.set(claims.jti, claims.exp);
  updateConfig({ revokedSessions: [...next] });
  revoked.set(claims.jti, claims.exp);
}
