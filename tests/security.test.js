import test from 'node:test';
import assert from 'node:assert/strict';
import { sameOrigin, clientIp, validPassword, validateProduction } from '../server/security.js';
import { normalizeWebhooks, webhookHeaders } from '../server/webhooks.js';
import crypto from 'node:crypto';
import { isPublicAddress, resolvePublicAddress } from '../server/webhook-delivery.js';
import { WorkQueue } from '../server/work-queue.js';
import { redactDiagnostic } from '../server/diagnostics.js';

test('admin origin blocks foreign origins and cross-site fetches', () => {
  assert.equal(sameOrigin({ headers: { host: 'app.example', origin: 'https://app.example' } }), true);
  assert.equal(sameOrigin({ headers: { host: 'app.example', origin: 'https://evil.example' } }), false);
  assert.equal(sameOrigin({ headers: { host: 'app.example', 'sec-fetch-site': 'cross-site' } }), false);
});

test('upstream diagnostics remove credentials from nested objects and URLs', () => {
  const output = JSON.stringify(redactDiagnostic({
    message: 'failed https://upstream.example/?token=private-token&key=abc',
    cause: { headers: { authorization: 'Bearer abc' }, message: 'secret-content' }
  }, ['secret-content']));
  assert.equal(output.includes('private-token'), false);
  assert.equal(output.includes('secret-content'), false);
  assert.equal(output.includes('Bearer abc'), false);
});

test('IP limits ignore forged forwarding chains beyond trusted hops', () => {
  const req = { headers: { 'x-forwarded-for': '192.0.2.1, 198.51.100.2' }, socket: { remoteAddress: '127.0.0.1' } };
  assert.equal(clientIp(req, 0), '127.0.0.1');
  assert.equal(clientIp(req, 1), '198.51.100.2');
});

test('production rejects example credentials, shared secrets, and oversized bcrypt passwords', () => {
  const env = { NODE_ENV: 'production', JWT_SECRET: 'a'.repeat(40), WS_TOKEN: 'b'.repeat(40), ADMIN_USERNAME: 'admin', ADMIN_PASSWORD: 'Safe-admin-example-0123' };
  assert.doesNotThrow(() => validateProduction(env));
  assert.throws(() => validateProduction({ ...env, JWT_SECRET: 'change-this-to-at-least-32-characters' }), /JWT_SECRET/);
  assert.throws(() => validateProduction({ ...env, WS_TOKEN: env.JWT_SECRET }), /berbeda/);
  assert.equal(validPassword('😀'.repeat(20)), false);
  assert.equal(validPassword('change-me-now'), false);
});

test('webhook destinations reject private IPs, metadata, IPv6 literals and local names', () => {
  for (const host of ['127.0.0.1', '127.1', '0x7f000001', '10.1.2.3', '169.254.169.254', '[::1]', '[::ffff:127.0.0.1]', 'host.local', 'service.internal']) {
    assert.throws(() => normalizeWebhooks([{ url: 'https://' + host + '/hook' }]), /HTTPS publik/);
  }
  for (const ip of ['10.1.2.3', '127.0.0.1', '169.254.169.254', '100.64.0.1', '192.168.1.1', '::1', 'fc00::1', 'fe80::1', '::ffff:127.0.0.1', '2001:db8::1']) {
    assert.equal(isPublicAddress(ip), false, ip);
  }
  assert.equal(isPublicAddress('8.8.8.8'), true);
  assert.equal(isPublicAddress('2606:4700:4700::1111'), true);
});

test('DNS validation blocks mixed private answers and pins a verified public answer', async () => {
  await assert.rejects(resolvePublicAddress('receiver.example', async () => [
    { address: '8.8.8.8', family: 4 }, { address: '127.0.0.1', family: 4 }
  ]), /alamat publik/);
  const record = { address: '8.8.8.8', family: 4 };
  assert.deepEqual(await resolvePublicAddress('receiver.example', async () => [record]), record);
});

test('webhook HMAC binds timestamp and exact serialized body', () => {
  const body = '{"event":"chat"}';
  const headers = webhookHeaders({ id: 'event-id', version: 1 }, body, 'secret-for-test');
  const expected = crypto.createHmac('sha256', 'secret-for-test').update(headers['x-tlk-timestamp'] + '.' + body).digest('hex');
  assert.equal(headers['x-tlk-signature'], 'sha256=' + expected);
  assert.equal(headers['x-tlk-event-id'], 'event-id');
  assert.equal('x-tlk-signature' in webhookHeaders({}, body, ''), false);
});

test('webhook work queue bounds concurrency and pending work, then recovers', async () => {
  const queue = new WorkQueue(1, 1);
  let release;
  const first = queue.run(() => new Promise(resolve => { release = resolve; }));
  const second = queue.run(async () => {});
  assert.equal(await queue.run(async () => assert.fail('overflow executed')), false);
  release();
  assert.equal(await first, true);
  assert.equal(await second, true);
  assert.equal(await queue.run(async () => {}), true);
});
