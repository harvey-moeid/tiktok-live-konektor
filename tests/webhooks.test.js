import test from 'node:test';
import assert from 'node:assert/strict';
import { normalizeWebhooks } from '../server/webhooks.js';

test('normalizeWebhooks accepts public HTTPS targets and normalizes events', () => {
  const [hook] = normalizeWebhooks([{ url: 'https://example.com/hook', enabled: true, events: ['chat', 'chat', 'gift', 'bad space'] }]);
  assert.equal(hook.url, 'https://example.com/hook');
  assert.deepEqual(hook.events, ['chat', 'gift']);
  assert.equal(hook.enabled, true);
});

test('normalizeWebhooks rejects non-HTTPS and local targets', () => {
  assert.throws(() => normalizeWebhooks([{ url: 'http://example.com/hook' }]), /HTTPS publik/);
  assert.throws(() => normalizeWebhooks([{ url: 'https://localhost/hook' }]), /HTTPS publik/);
});

test('normalizeWebhooks limits target count', () => {
  const many = Array.from({ length: 21 }, (_, i) => ({ url: `https://example.com/${i}` }));
  assert.throws(() => normalizeWebhooks(many), /Maksimal 20 webhook/);
});

test('normalizeWebhooks preserves unrelated event filters and disabled state', () => {
  const [target] = normalizeWebhooks([{ url: 'https://receiver.example/webhook', enabled: false, events: ['chat', 'subscribe', 'emote'] }]);
  assert.equal(target.enabled, false);
  assert.deepEqual(target.events, ['chat', 'subscribe', 'emote']);
});

test('normalizeWebhooks permits zero destinations to disable delivery', () => {
  assert.deepEqual(normalizeWebhooks([]), []);
});
