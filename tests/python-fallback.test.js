import test from 'node:test';
import assert from 'node:assert/strict';
import { PythonLiveFallback, pythonFallbackConfig } from '../server/python-fallback.js';

test('fallback is off without a complete secure configuration', () => {
  assert.equal(pythonFallbackConfig({}), null);
  assert.equal(pythonFallbackConfig({ PYTHON_FALLBACK_URL: 'https://bridge.test', PYTHON_FALLBACK_TOKEN: 'short' }), null);
  assert.throws(() => pythonFallbackConfig({ PYTHON_FALLBACK_URL: 'http://bridge.test', PYTHON_FALLBACK_TOKEN: 'x'.repeat(40) }), /HTTPS/);
});

test('fetches events with authorization and retains monotonically increasing cursor', async () => {
  const calls = [], out = [];
  const fakeFetch = async (url, init) => {
    calls.push({ url, init });
    if (url.endsWith('/start')) return { ok: true, json: async () => ({ ok: true, status: 'connected', roomId: '123456789012345' }) };
    if (url.includes('/events')) return { ok: true, json: async () => ({
      ok: true, status: 'connected', roomId: '123456789012345', latestSeq: 2,
      events: [
        { seq: 1, event: 'chat', data: { message: 'hello' } },
        { seq: 1, event: 'chat', data: { message: 'duplicate' } },
        { seq: 2, event: 'gift', data: { repeatCount: 3 } },
      ]
    }) };
    return { ok: true, json: async () => ({ ok: true }) };
  };
  const instance = new PythonLiveFallback({
    config: { endpoint: 'https://bridge.test', token: 'x'.repeat(40) },
    fetchImpl: fakeFetch,
    emitEvent: e => out.push(e)
  });
  await instance.start('jalurtarot');
  clearTimeout(instance.timer);
  await instance.poll();
  clearTimeout(instance.timer);
  assert.deepEqual(out.map(e => e.event), ['chat', 'gift']);
  assert.equal(out[0].roomId, '123456789012345');
  assert.equal(instance.cursor, 2);
  assert.ok(calls.every(c => c.init.headers.Authorization === 'Bearer ' + 'x'.repeat(40)));
  await instance.stop();
});

test('unexpected remote disconnect is reported to controller', async () => {
  const statuses = [];
  const fakeFetch = async (url) => ({ ok: true, json: async () =>
    url.endsWith('/start') ? { ok: true, status: 'connected' } :
    url.includes('/events') ? { ok: true, status: 'disconnected', events: [] } : { ok: true }
  });
  const fallback = new PythonLiveFallback({
    config: { endpoint: 'https://bridge.test', token: 'x'.repeat(40) },
    fetchImpl: fakeFetch,
    setStatus: (s, e) => statuses.push([s, e])
  });
  await fallback.start('jalurtarot');
  clearTimeout(fallback.timer);
  await fallback.poll();
  assert.equal(fallback.active, false);
  assert.deepEqual(statuses, [['Disconnected', null]]);
});

test('terminal snapshots drain every pending batch before emitting disconnected', async () => {
  const out = [], statuses = [], paths = [];
  const fallback = new PythonLiveFallback({
    config: { endpoint: 'https://bridge.test', token: 'x'.repeat(40) },
    fetchImpl: async url => {
      paths.push(url);
      return { ok: true, json: async () => url.endsWith('/start')
        ? { ok: true, status: 'connected', sessionId: 'session-a' }
        : { ok: true, status: 'disconnected', sessionId: 'session-a', latestSeq: 2,
          events: url.endsWith('after=0') ? [{ seq: 1, event: 'gift', data: { repeatCount: 1 } }]
            : [{ seq: 2, event: 'chat', data: { message: 'last chat' } }] } };
    },
    emitEvent: e => out.push(e), setStatus: s => statuses.push(s)
  });
  await fallback.start('broadcaster'); clearTimeout(fallback.timer);
  await fallback.poll(); clearTimeout(fallback.timer);
  assert.equal(fallback.active, true); assert.deepEqual(statuses, []);
  await fallback.poll(); clearTimeout(fallback.timer);
  assert.deepEqual(out.map(x => x.event), ['gift', 'chat']);
  assert.deepEqual(statuses, ['Disconnected']); assert.equal(fallback.cursor, 2);
  assert.ok(paths.at(-1).endsWith('after=1'));
});

test('bridge restart is detected instead of silently skipping a reset event sequence', async () => {
  const statuses = [], out = [];
  const fallback = new PythonLiveFallback({
    config: { endpoint: 'https://bridge.test', token: 'x'.repeat(40) },
    fetchImpl: async url => ({ ok: true, json: async () => url.endsWith('/start')
      ? { status: 'connected', sessionId: 'old' }
      : { status: 'connected', sessionId: 'new', latestSeq: 1, events: [{ seq: 1, event: 'gift', data: {} }] } }),
    setStatus: s => statuses.push(s), emitEvent: e => out.push(e)
  });
  await fallback.start('broadcaster'); clearTimeout(fallback.timer);
  await fallback.poll();
  assert.equal(fallback.active, false); assert.deepEqual(statuses, ['Error']); assert.deepEqual(out, []);
});

test('stalled backlog fails after a bounded number of polls rather than busy-looping', async () => {
  const statuses = [];
  const fallback = new PythonLiveFallback({
    config: { endpoint: 'https://bridge.test', token: 'x'.repeat(40) },
    fetchImpl: async url => ({ ok: true, json: async () => url.endsWith('/start')
      ? { status: 'connected' } : { status: 'disconnected', latestSeq: 5, events: [] } }),
    setStatus: s => statuses.push(s)
  });
  await fallback.start('broadcaster'); clearTimeout(fallback.timer);
  for (let i = 0; i < 3; i++) { await fallback.poll(); clearTimeout(fallback.timer); }
  assert.deepEqual(statuses, ['Error']); assert.equal(fallback.active, false);
});
