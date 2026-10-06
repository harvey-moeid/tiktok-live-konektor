import crypto from 'node:crypto';
import { getConfig } from './config.js';

function parseOrigins() {
  return String(process.env.API_ALLOWED_ORIGINS || '')
    .split(',')
    .map(x => x.trim())
    .filter(Boolean);
}

export function apiKey() {
  return String(process.env.API_KEY || getConfig().wsToken || '').trim();
}

export function allowedOrigins() {
  return parseOrigins();
}

function sameSecret(a, b) {
  const left = Buffer.from(String(a || ''));
  const right = Buffer.from(String(b || ''));
  return left.length > 0 && left.length === right.length && crypto.timingSafeEqual(left, right);
}

export function apiAuth(req, res, next) {
  const expected = apiKey();
  const auth = String(req.headers.authorization || '');
  const bearer = auth.match(/^Bearer\s+(.+)$/i)?.[1] || '';
  const supplied = bearer || String(req.headers['x-api-key'] || '');
  if (!sameSecret(supplied, expected)) return res.status(401).json({ error: 'API key tidak valid.' });
  next();
}

export function externalCors(req, res, next) {
  const origin = String(req.headers.origin || '');
  const allowed = allowedOrigins();

  if (!origin) return next();
  if (!allowed.includes(origin)) return res.status(403).json({ error: 'Origin tidak diizinkan.' });

  res.setHeader('Access-Control-Allow-Origin', origin);
  res.setHeader('Vary', 'Origin');
  res.setHeader('Access-Control-Allow-Headers', 'Authorization, X-API-Key, Content-Type');
  res.setHeader('Access-Control-Allow-Methods', 'GET, OPTIONS');
  res.setHeader('Access-Control-Max-Age', '86400');

  if (req.method === 'OPTIONS') return res.status(204).end();
  next();
}

export function isAllowedWsOrigin(origin) {
  const allowed = allowedOrigins();
  if (!origin) return true;
  return allowed.includes(String(origin));
}
