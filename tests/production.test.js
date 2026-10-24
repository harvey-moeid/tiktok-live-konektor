import test from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import { spawn } from 'node:child_process';
import { mkdtemp, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { once } from 'node:events';
import { io } from 'socket.io-client';
import WebSocket from 'ws';

test('production auth, API, Socket.IO, persistence, and graceful shutdown', { timeout: 30000 }, async t => {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'tlk-production-'));
  const password = crypto.randomBytes(20).toString('hex');
  const env = {
    ...process.env, NODE_ENV: 'production', PORT: '0', TRUST_PROXY: '0',
    CONFIG_FILE: path.join(directory, 'config.json'), ADMIN_USERNAME: 'admin',
    ADMIN_PASSWORD: password, JWT_SECRET: crypto.randomBytes(32).toString('hex'),
    WS_TOKEN: crypto.randomBytes(32).toString('hex'), API_KEY: crypto.randomBytes(32).toString('hex'),
    EULER_API_KEY: '', PYTHON_FALLBACK_URL: '', PYTHON_FALLBACK_HOSTNAME: '', PYTHON_FALLBACK_TOKEN: ''
  };
  let child;
  let base;
  const sockets = [];
  async function start() {
    child = spawn(process.execPath, ['server/index.js'], { cwd: new URL('..', import.meta.url), env, stdio: ['ignore', 'pipe', 'pipe'] });
    let output = '';
    const port = await new Promise((resolve, reject) => {
      child.stdout.on('data', chunk => {
        output += chunk;
        const match = output.match(/listening on (\d+)/);
        if (match) resolve(Number(match[1]));
      });
      child.once('error', reject);
      child.once('exit', code => reject(Error('Server exited before ready: ' + code)));
    });
    base = 'http://127.0.0.1:' + port;
  }
  async function stop() {
    const exited = once(child, 'exit');
    child.kill('SIGTERM');
    const [code] = await exited;
    assert.equal(code, 0, 'shutdown must complete with open sockets');
  }
  t.after(async () => {
    for (const socket of sockets) socket.close();
    if (child?.exitCode === null) { child.kill('SIGKILL'); await once(child, 'exit'); }
    await rm(directory, { recursive: true, force: true });
  });
  const request = (route, options = {}) => fetch(base + route, options);
  async function login(secret = password) {
    const response = await request('/api/auth/login', {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ username: 'admin', password: secret })
    });
    assert.equal(response.status, 200);
    assert.match(response.headers.get('set-cookie'), /HttpOnly/);
    assert.match(response.headers.get('set-cookie'), /Secure/);
    return response.headers.get('set-cookie').split(';')[0];
  }
  async function connect(cookie) {
    const socket = io(base, { transports: ['websocket'], reconnection: false, extraHeaders: { Cookie: cookie } });
    sockets.push(socket);
    await new Promise((resolve, reject) => { socket.once('connect', resolve); socket.once('connect_error', reject); });
    return socket;
  }
  await start();
  assert.equal((await (await request('/api/health')).json()).ok, true);
  assert.equal((await request('/api/state')).status, 401);
  const foreign = await request('/api/auth/login', { method: 'POST', headers: { origin: 'https://evil.example', 'content-type': 'application/json' }, body: '{}' });
  assert.equal(foreign.status, 403);
  const malformed = await request('/api/auth/login', { method: 'POST', headers: { 'content-type': 'application/json' }, body: '{' });
  assert.equal(malformed.status, 400);
  assert.equal((await malformed.json()).error, 'JSON tidak valid.');
  assert.equal((await request('/api/v1/status', { headers: { authorization: 'Bearer bad' } })).status, 401);
  const publicStatus = await request('/api/v1/status', { headers: { authorization: 'Bearer ' + env.API_KEY } });
  assert.equal(publicStatus.status, 200);
  assert.equal(publicStatus.headers.get('cache-control'), 'no-store');

  const cookie = await login();
  const socket = await connect(cookie);
  const forbidden = await request('/api/config', { method: 'PUT', headers: { cookie, origin: 'https://evil.example', 'content-type': 'application/json' }, body: '{}' });
  assert.equal(forbidden.status, 403);
  const privateHook = await request('/api/webhooks', { method: 'PUT', headers: { cookie, 'content-type': 'application/json' }, body: JSON.stringify({ webhooks: [{ url: 'https://169.254.169.254/' }] }) });
  assert.equal(privateHook.status, 400);
  const config = await (await request('/api/config', { headers: { cookie } })).json();
  assert.equal('passwordHash' in config, false);
  assert.equal('wsToken' in config, false);
  const disconnected = once(socket, 'disconnect');
  assert.equal((await request('/api/auth/logout', { method: 'POST', headers: { cookie } })).status, 200);
  await disconnected;
  assert.equal((await request('/api/state', { headers: { cookie } })).status, 401);
  const survivingCookie = await login();
  const survivingSocket = await connect(survivingCookie);
  // Include the external websocket in shutdown validation.
  const external = new WebSocket(base.replace('http:', 'ws:') + '/live', { headers: { authorization: 'Bearer ' + env.WS_TOKEN } });
  sockets.push(external);
  await once(external, 'open');
  const oversizedClosed = once(external, 'close');
  external.send('x'.repeat(300 * 1024));
  await oversizedClosed;
  assert.equal((await request('/api/health')).status, 200, 'oversized WS payload must not crash server');
  const shutdownWs = new WebSocket(base.replace('http:', 'ws:') + '/live', { headers: { authorization: 'Bearer ' + env.WS_TOKEN } });
  sockets.push(shutdownWs);
  await once(shutdownWs, 'open');
  await stop();
  assert.equal(survivingSocket.connected, false);
  await start();
  assert.equal((await request('/api/state', { headers: { cookie } })).status, 401, 'logout revocation survives restart');
  assert.equal((await request('/api/state', { headers: { cookie: survivingCookie } })).status, 200, 'valid sessions survive restart');
  const newPassword = crypto.randomBytes(20).toString('hex');
  const changed = await request('/api/auth/password', { method: 'POST', headers: { cookie: survivingCookie, 'content-type': 'application/json' }, body: JSON.stringify({ password: newPassword }) });
  assert.equal(changed.status, 200);
  assert.equal((await request('/api/state', { headers: { cookie: survivingCookie } })).status, 401);
  const newCookie = await login(newPassword);
  assert.equal((await request('/api/state', { headers: { cookie: newCookie } })).status, 200);
  await stop();
});
