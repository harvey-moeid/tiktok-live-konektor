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
