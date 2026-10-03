import bcrypt from 'bcryptjs';
import jwt from 'jsonwebtoken';
import crypto from 'node:crypto';
import { getConfig, updateConfig } from './config.js';

const secret = process.env.JWT_SECRET;
const username = process.env.ADMIN_USERNAME || 'admin';

if (process.env.NODE_ENV === 'production' && (!secret || secret.length < 32)) {
  throw Error('JWT_SECRET wajib diisi dan minimal 32 karakter pada production.');
}
const jwtSecret = secret || 'dev-only-secret-change-me';
const envPassword = process.env.ADMIN_PASSWORD || '';
let passwordHash = getConfig().passwordHash || (envPassword ? bcrypt.hashSync(envPassword, 12) : '');

if (!passwordHash) {
  if (process.env.NODE_ENV === 'production') throw Error('ADMIN_PASSWORD wajib diisi pada first startup production.');
  passwordHash = bcrypt.hashSync('change-me-now', 12);
}

export async function setPassword(password) {
  if (typeof password !== 'string' || password.length < 8) throw Error('Password minimal 8 karakter.');
  passwordHash = await bcrypt.hash(password, 12);
  updateConfig({ passwordHash });
}

export async function login(u, p) {
  if (!u || !p || u !== username || !(await bcrypt.compare(p, passwordHash))) return null;
  return jwt.sign({ sub: username, jti: crypto.randomUUID() }, jwtSecret, { expiresIn: '12h' });
}

export function verify(token) {
  if (!token) throw Error('Missing token');
  return jwt.verify(token, jwtSecret);
}
