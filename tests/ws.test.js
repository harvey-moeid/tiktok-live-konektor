import test from 'node:test';
import assert from 'node:assert/strict';
import { parseEventTypes } from '../server/ws.js';

test('realtime event filter accepts chat like gift', () => {
  assert.deepEqual([...parseEventTypes('chat,like,gift')], ['chat','like','gift']);
});

test('realtime event filter removes unsupported internal events', () => {
  assert.deepEqual([...parseEventTypes('chat,roomMessage,like')], ['chat','like']);
});

test('empty realtime filter means all external event types', () => {
  assert.equal(parseEventTypes(''), null);
});
