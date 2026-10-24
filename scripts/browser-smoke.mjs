import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { mkdtemp, rm } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { chromium } from 'playwright-core';

const executablePath = process.env.CHROMIUM_PATH || ['/usr/bin/chromium', '/usr/bin/google-chrome', '/usr/bin/google-chrome-stable'].find(existsSync);
assert.ok(executablePath, 'Install Chromium or set CHROMIUM_PATH.');
assert.ok(existsSync('client/dist/index.html'), 'Run npm run build first.');
const directory = await mkdtemp(path.join(os.tmpdir(), 'tlk-browser-'));
const password = crypto.randomBytes(20).toString('hex');
const child = spawn(process.execPath, ['server/index.js'], {
  env: { ...process.env, NODE_ENV: 'production', PORT: '0', TRUST_PROXY: '0',
    CONFIG_FILE: path.join(directory, 'config.json'), ADMIN_USERNAME: 'admin', ADMIN_PASSWORD: password,
    JWT_SECRET: crypto.randomBytes(32).toString('hex'), WS_TOKEN: crypto.randomBytes(32).toString('hex'),
    WEBHOOK_SIGNING_SECRET: crypto.randomBytes(32).toString('hex'),
    API_KEY: '', EULER_API_KEY: '', PYTHON_FALLBACK_URL: '', PYTHON_FALLBACK_HOSTNAME: '', PYTHON_FALLBACK_TOKEN: '' },
  stdio: ['ignore', 'pipe', 'pipe']
});
let browser;
const timeout = setTimeout(() => { child.kill('SIGKILL'); process.exitCode = 1; }, 45_000);
try {
  let output = '';
  const port = await new Promise((resolve, reject) => {
    child.stdout.on('data', chunk => { output += chunk; const match = output.match(/listening on (\d+)/); if (match) resolve(Number(match[1])); });
    child.once('error', reject);
    child.once('exit', code => reject(Error('Server exited: ' + code)));
  });
  browser = await chromium.launch({ executablePath, headless: true, args: ['--no-sandbox'] });
  const page = await browser.newPage();
  const errors = [];
  const sockets = [];
  page.on('pageerror', error => errors.push(error.message));
  page.on('websocket', socket => sockets.push(socket.url()));
  page.on('console', message => { if (/Content Security Policy|Refused to/i.test(message.text())) errors.push(message.text()); });
  await page.goto('http://127.0.0.1:' + port);
  await page.getByLabel('Username', { exact: true }).fill('admin');
  await page.getByLabel('Password', { exact: true }).fill('wrong-password');
  await page.getByRole('button', { name: 'Masuk', exact: true }).click();
  await page.getByRole('alert').waitFor();
  await page.getByLabel('Password', { exact: true }).fill(password);
  await page.getByRole('button', { name: 'Masuk', exact: true }).click();
  await page.getByRole('button', { name: 'Logout', exact: true }).waitFor();
  await page.getByText('Disconnected', { exact: true }).waitFor();
  await page.getByRole('tab', { name: /Integrasi Webhook/ }).click();
  await page.getByRole('button', { name: '+ Tambah webhook', exact: true }).click();
  await page.getByLabel('URL endpoint webhook').fill('https://169.254.169.254/hook');
  await page.getByRole('button', { name: 'Simpan webhook', exact: true }).click();
  await page.getByRole('alert').waitFor();
  assert.match(await page.getByRole('alert').textContent(), /HTTPS publik/);
  await page.getByLabel('URL endpoint webhook').fill('https://example.com/hook');
  await page.getByRole('button', { name: 'Simpan webhook', exact: true }).click();
  await page.getByText('Pengaturan webhook berhasil disimpan.', { exact: true }).waitFor();
  await page.reload();
  await page.getByRole('tab', { name: /Integrasi Webhook/ }).click();
  assert.equal(await page.getByLabel('URL endpoint webhook').inputValue(), 'https://example.com/hook');
  await page.getByLabel('URL endpoint webhook').fill('https://example.com/draft');
  await page.getByRole('button', { name: 'Batalkan', exact: true }).click();
  assert.equal(await page.getByLabel('URL endpoint webhook').inputValue(), 'https://example.com/hook');
  await page.setViewportSize({ width: 390, height: 844 });
  assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth), true, 'mobile page must fit viewport');
  await page.getByRole('tab', { name: /Aktivitas LIVE/ }).click();
  await page.getByRole('button', { name: 'Logout', exact: true }).click();
  await page.getByRole('button', { name: 'Masuk', exact: true }).waitFor();
  assert.equal((await page.request.get('http://127.0.0.1:' + port + '/api/state')).status(), 401);
  assert.ok(sockets.some(url => url.includes('/socket.io/')), 'dashboard must open realtime websocket');
  assert.deepEqual(errors, [], 'no browser runtime or CSP errors');
  console.log('Browser smoke passed: login, realtime, webhook validation/save/reload/cancel, mobile layout, logout.');
} finally {
  clearTimeout(timeout);
  await browser?.close();
  if (child.exitCode === null) {
    const exited = once(child, 'exit');
    child.kill('SIGTERM');
    const [code] = await exited;
    assert.equal(code, 0);
  }
  await rm(directory, { recursive: true, force: true });
}
