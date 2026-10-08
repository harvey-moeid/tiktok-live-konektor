import test from 'node:test';
import assert from 'node:assert/strict';
import {
  copyWebhookRows, toggleWebhookEvent, parseCustomWebhookEvents,
  validateWebhookRows, MAX_WEBHOOKS
} from '../client/src/webhook-utils.js';

test('webhook editor retains unknown event names and does not mutate server config', () => {
  const input = [{ url: 'https://example.com/hook', events: ['chat', 'emote'], enabled: false }];
  const rows = copyWebhookRows(input);
  rows[0].events.push('gift');
  assert.deepEqual(input[0].events, ['chat', 'emote']);
  assert.deepEqual(rows[0].events, ['chat', 'emote', 'gift']);
  assert.equal(rows[0].enabled, false);
});

test('event selection is explicit, and empty array means all events', () => {
  assert.deepEqual(toggleWebhookEvent([], 'chat'), ['chat']);
  assert.deepEqual(toggleWebhookEvent(['chat'], 'gift'), ['chat', 'gift']);
  assert.deepEqual(toggleWebhookEvent(['chat'], 'chat'), []);
  assert.deepEqual(toggleWebhookEvent(['subscribe'], 'chat'), ['subscribe', 'chat']);
});

test('custom event validation preserves distinct event types', () => {
  assert.deepEqual(parseCustomWebhookEvents('subscribe, emote,subscribe'), { events: ['subscribe', 'emote'], error: null });
  assert.match(parseCustomWebhookEvents('bad event').error, /Nama event/);
  assert.match(parseCustomWebhookEvents('').error, /minimal satu/);
});

test('webhook editor validates URLs, credentials, duplicates, and max count', () => {
  assert.equal(validateWebhookRows([]), null);
  const good = { url: 'https://example.com/hook', enabled: true, events: ['gift'] };
  assert.equal(validateWebhookRows([good]), null);
  assert.match(validateWebhookRows([{ ...good, url: 'http://example.com' }]), /HTTPS publik/);
  assert.match(validateWebhookRows([{ ...good, url: 'https://localhost/hook' }]), /HTTPS publik/);
  assert.match(validateWebhookRows([{ ...good, url: 'https://alice:secret@example.com' }]), /HTTPS publik/);
  assert.match(validateWebhookRows([{ ...good, url: '' }]), /wajib diisi/);
  assert.match(validateWebhookRows([good, good]), /duplikat/);
  assert.match(validateWebhookRows([{ ...good, events: ['bad event'] }]), /event tidak valid/);
  assert.match(validateWebhookRows(Array.from({ length: MAX_WEBHOOKS + 1 }, (_, i) => ({
    ...good, url: 'https://example.com/' + i
  }))), /Maksimal 20 webhook/);
});
