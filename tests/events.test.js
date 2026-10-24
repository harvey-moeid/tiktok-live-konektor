import test from 'node:test';
import assert from 'node:assert/strict';
import { safeJsonValue, serializeEvent, normalizeEvent, createEvent } from '../server/events.js';

test('safeJsonValue handles bigint and circular objects', () => {
  const value = { n: 12n };
  value.self = value;
  assert.deepEqual(safeJsonValue(value), { n: '12', self: '[Circular]' });
});

test('safeJsonValue does not mark repeated non-circular references as circular', () => {
  const shared = { ok: true };
  assert.deepEqual(safeJsonValue({ a: shared, b: shared }), { a: { ok: true }, b: { ok: true } });
});

test('serializeEvent returns valid JSON for normal events', () => {
  const event = createEvent('chat', { message: 'hello' });
  const parsed = JSON.parse(serializeEvent(event));
  assert.equal(parsed.event, 'chat');
  assert.equal(parsed.data.message, 'hello');
  assert.ok(parsed.id);
});

test('serializeEvent truncates oversized payloads', () => {
  const event = createEvent('x', { value: 'a'.repeat(300_000) });
  const parsed = JSON.parse(serializeEvent(event));
  assert.equal(parsed.data.truncated, true);
  assert.equal(parsed.data.reason, 'payload_too_large');
  assert.ok(parsed.data.originalBytes > 0);
});

test('normalizeEvent returns the bounded event object used by runtime history', () => {
  const event = createEvent('x', { value: 'a'.repeat(300_000) });
  const normalized = normalizeEvent(event);
  assert.equal(normalized.data.truncated, true);
  assert.equal(normalized.event, 'x');
});
