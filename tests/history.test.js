import test from 'node:test';
import assert from 'node:assert/strict';
import { removeHistoryEvent } from '../server/history.js';

const sample = Object.freeze([
  Object.freeze({ id: 'chat-1', event: 'chat' }),
  Object.freeze({ id: 'gift-2', event: 'gift' }),
  Object.freeze({ id: 'like-3', event: 'like' })
]);

test('removes only one matching activity without mutating the original feed', () => {
  const result = removeHistoryEvent(sample, 'gift-2');
  assert.equal(result.status, 'removed');
  assert.deepEqual(result.events.map(x => x.id), ['chat-1', 'like-3']);
  assert.equal(sample.length, 3);
});

test('returns missing for a deleted or unknown event', () => {
  const result = removeHistoryEvent(sample, 'no-such-id');
  assert.equal(result.status, 'missing');
  assert.equal(result.events, sample);
});

test('rejects invalid event IDs without changing the feed', () => {
  for (const id of ['', '   ', ' leading', 'x'.repeat(129), null, 10]) {
    const result = removeHistoryEvent(sample, id);
    assert.equal(result.status, 'invalid');
    assert.equal(result.events, sample);
  }
});

test('removes only first occurrence even if input has duplicate event IDs', () => {
  const duplicated = [...sample, { id: 'gift-2', event: 'gift' }];
  const result = removeHistoryEvent(duplicated, 'gift-2');
  assert.equal(result.events.length, 3);
  assert.deepEqual(result.events.map(x => x.id), ['chat-1', 'like-3', 'gift-2']);
});
