import test from 'node:test';
import assert from 'node:assert/strict';
import { LiveController } from '../server/live-controller.js';
import { LiveStats } from '../server/stats.js';

function harness(options = {}) {
  const events = [], statuses = [], persisted = [], timers = [];
  const stats = new LiveStats();
  const node = { start: async () => ({ roomId: '123456789' }), stop: async () => {} };
  const engines = { node, ...options.engines };
  const live = new LiveController({ engines,
    emitEvent: e => { events.push(e); stats.consume(e); },
    onStatus: s => statuses.push(s), persistDesired: d => persisted.push(d),
    now: () => 1000, random: () => 0.5,
    setTimer: (fn, delay) => { const timer = { fn, delay }; timers.push(timer); return timer; },
    clearTimer: timer => { if (timer) timer.cancelled = true; }, ...options, engines
  });
  async function retry() {
    const timer = timers.find(x => !x.cancelled && !x.fired);
    assert.ok(timer, 'expected a scheduled reconnect'); timer.fired = true; timer.fn();
    await live.operation;
  }
  return { live, node, events, statuses, persisted, timers, retry, stats };
}

test('native initial events follow stream.started and remain in session totals', async () => {
  const h = harness();
  h.node.start = async () => {
    h.live.onEngineEvent('node', { event: 'chat', data: { message: 'initial' } });
    h.live.onEngineEvent('node', { event: 'gift', data: { username: 'alice', giftType: 0, repeatCount: 1, diamondCount: 100 } });
    h.live.onEngineEvent('node', { event: 'stream', data: { state: 'started' } });
    h.live.onEngineStatus('node', 'Connected');
    return { roomId: '123456789' };
  };
  await h.live.start('broadcaster');
  assert.deepEqual(h.events.map(x => x.event), ['stream', 'chat', 'gift']);
  assert.equal(h.events[0].data.state, 'started');
  assert.equal(h.events[1].roomId, '123456789');
  assert.equal(h.stats.value.chat, 1); assert.equal(h.stats.value.giftCoins, 100);
  assert.equal(h.live.snapshot().status, 'Connected');
});

test('reconnect applies backoff, preserves same-room totals, and resets for a different room', async () => {
  const h = harness(); await h.live.start('broadcaster');
  h.live.onEngineEvent('node', { event: 'chat', data: {} });
  h.live.onEngineStatus('node', 'Disconnected', 'network');
  assert.equal(h.live.snapshot().status, 'Reconnecting...');
  assert.equal(h.timers[0].delay, 2000); assert.equal(h.live.snapshot().desiredRunning, true);
  assert.equal(h.live.snapshot().running, false);
  await h.retry(); assert.equal(h.events.at(-1).data.resumed, true); assert.equal(h.stats.value.chat, 1);
  h.node.start = async () => ({ roomId: '987654321' });
  h.live.onEngineStatus('node', 'Error', 'network');
  assert.equal(h.timers.at(-1).delay, 4000);
  await h.retry(); assert.equal(h.events.at(-1).data.resumed, false); assert.equal(h.stats.value.chat, 0);
});

test('explicit Stop cancels retries and persists stopped intent even after disconnection', async () => {
  const h = harness(); await h.live.start('broadcaster');
  h.live.onEngineStatus('node', 'Disconnected');
  await h.live.stop();
  assert.equal(h.timers[0].cancelled, true); assert.equal(h.persisted.at(-1).running, false);
  h.timers[0].fn(); await h.live.operation;
  assert.equal(h.live.snapshot().status, 'Disconnected'); assert.equal(h.live.snapshot().running, false);
});

test('restart resumes persisted intent; graceful shutdown does not persist Stop', async () => {
  const h = harness({ desired: { running: true, username: 'broadcaster', roomId: '' } });
  await h.live.resume(); assert.equal(h.live.snapshot().status, 'Connected');
  await h.live.stop({ shutdown: true });
  assert.deepEqual(h.persisted, []); assert.equal(h.live.desired.running, true);
  h.live.onEngineStatus('node', 'Error', 'late callback');
  assert.equal(h.timers.length, 0);
});

test('failed attempts are bounded and storage failure never changes desired state', async () => {
  const h = harness({ maxAttempts: 2, recoveryIntervalMs: 0 });
  h.node.start = async () => { throw Error('network unavailable'); };
  await assert.rejects(h.live.start('broadcaster'), /network/);
  await h.retry(); await h.retry();
  assert.equal(h.live.snapshot().recoveryExhausted, true); assert.equal(h.timers.length, 2);
  const broken = harness({ persistDesired: () => { throw Error('disk full'); } });
  assert.throws(() => broken.live.start('broadcaster'), /disk full/);
  assert.equal(broken.live.snapshot().running, false);
});

test('Start is serialized and Stop cancels an in-flight startup without leaking events', async () => {
  const h = harness(); let resolve;
  h.node.start = () => new Promise(done => { resolve = done; });
  const first = h.live.start('broadcaster');
  await assert.rejects(h.live.start('other'), /diproses/);
  await Promise.resolve();
  const stop = h.live.stop();
  h.live.onEngineEvent('node', { event: 'chat', data: {} });
  resolve({ roomId: '123456789' }); await first; await stop;
  assert.deepEqual(h.events, []); assert.equal(h.live.snapshot().running, false);
});

test('fallback discards failed-engine data and ignores stale callbacks', async () => {
  const managed = { enabled: true, start: async () => ({ roomId: '123456789' }), stop: () => {}, flushPendingEvents: () => {} };
  const h = harness({ engines: { managed } });
  // Use the exact entitlement guidance recognized by the application.
  const { EULER_BUSINESS_PLAN_MESSAGE } = await import('../server/signing-error.js');
  h.node.start = async () => {
    h.live.onEngineEvent('node', { event: 'chat', data: { message: 'discard' } });
    throw Error(EULER_BUSINESS_PLAN_MESSAGE);
  };
  await h.live.start('broadcaster');
  h.live.onEngineStatus('node', 'Disconnected');
  h.live.onEngineEvent('node', { event: 'chat', data: {} });
  assert.equal(h.live.snapshot().engine, 'managed'); assert.equal(h.live.snapshot().status, 'Connected');
  assert.equal(h.events.length, 1);
});

test('permanent managed authorization denial does not retry indefinitely', async () => {
  const h = harness(); await h.live.start('broadcaster');
  h.live.onEngineStatus('node', 'Error', 'API key Cloud WebSocket Eulerstream tidak diterima.');
  assert.equal(h.live.snapshot().recoveryExhausted, true); assert.equal(h.timers.length, 0);
});

test('source IDs suppress replayed packets during recovery without suppressing new messages', async () => {
  const h = harness(); await h.live.start('broadcaster');
  h.live.onEngineEvent('node', { id: 'upstream-id-1', event: 'chat', data: {} });
  h.live.onEngineStatus('node', 'Disconnected'); await h.retry();
  h.live.onEngineEvent('node', { id: 'upstream-id-1', event: 'chat', data: {} });
  h.live.onEngineEvent('node', { id: 'upstream-id-2', event: 'chat', data: {} });
  assert.equal(h.stats.value.chat, 2);
});

test('remote bridge cleanup finishes before another connection attempt', async () => {
  const order = []; const h = harness();
  h.node.start = async () => { order.push('start'); return { roomId: '123456789' }; };
  h.node.stop = async () => { await Promise.resolve(); order.push('stop'); };
  await h.live.start('broadcaster'); h.live.onEngineStatus('node', 'Error', 'poll failed'); await h.retry();
  assert.deepEqual(order, ['start', 'stop', 'start']);
});

test('late room metadata becomes visible to status consumers', async () => {
  const h = harness(); h.node.start = async () => ({}); await h.live.start('broadcaster');
  h.live.onEngineEvent('node', { event: 'viewer', roomId: '123456789', data: { viewerCount: 5 } });
  assert.equal(h.live.snapshot().roomId, '123456789');
});

test('managed fallback is attempted when native Room ID discovery fails', async () => {
  let managedStarts = 0;
  const managed = {
    enabled: true,
    start: async () => { managedStarts++; return { roomId: '123456789012345' }; },
    stop: async () => {}, flushPendingEvents: () => {}
  };
  const h = harness({ engines: { managed } });
  h.node.start = async () => { throw Error('Failed to retrieve Room ID from all sources.'); };
  await h.live.start('broadcaster');
  assert.equal(managedStarts, 1);
  assert.equal(h.live.snapshot().engine, 'managed');
  assert.equal(h.live.snapshot().roomId, '123456789012345');
});

test('reconnect skips denied Business signer; a fresh manual Start can retry it', async () => {
  const { EULER_BUSINESS_PLAN_MESSAGE } = await import('../server/signing-error.js');
  let nativeStarts = 0, managedStarts = 0;
  const managed = {
    enabled: true,
    start: async () => { managedStarts++; return { roomId: '123456789012345' }; },
    stop: async () => {}, flushPendingEvents: () => {}
  };
  const h = harness({ engines: { managed } });
  h.node.start = async () => { nativeStarts++; throw Error(EULER_BUSINESS_PLAN_MESSAGE); };
  await h.live.start('broadcaster');
  assert.equal(nativeStarts, 1);
  assert.equal(managedStarts, 1);
  h.live.onEngineStatus('managed', 'Error', 'temporary disconnection');
  await h.retry();
  assert.equal(nativeStarts, 1, 'retry must not hit the known Business-only signer again');
  assert.equal(managedStarts, 2);
  await h.live.stop();
  await h.live.start('broadcaster');
  assert.equal(nativeStarts, 2, 'operator Start should recheck Node after a possible plan change');
  assert.equal(managedStarts, 3);
});

test('managed checks username when native reports a possibly stale offline Room ID', async () => {
  const managed = {
    enabled: true, start: async () => ({ roomId: '7698371791703100167' }),
    stop: async () => {}, flushPendingEvents: () => {}
  };
  const h = harness({ engines: { managed } });
  h.node.start = async () => { throw Error("The requested user isn't online :("); };
  await h.live.start('genwangi');
  assert.equal(h.live.snapshot().engine, 'managed');
  assert.equal(h.live.snapshot().roomId, '7698371791703100167');
});

test('slow recovery continues after fast retries and successful connection restores the retry budget', async () => {
  const h = harness({ maxAttempts: 1, recoveryIntervalMs: 300_000 });
  h.node.start = async () => { throw Error('offline'); };
  await assert.rejects(h.live.start('broadcaster'), /offline/);
  await h.retry();
  assert.equal(h.live.snapshot().recoveryExhausted, true);
  assert.equal(h.timers.at(-1).delay, 300_000);
  await h.retry();
  assert.equal(h.timers.at(-1).delay, 300_000);
  h.node.start = async () => ({ roomId: '123456789' }); await h.retry();
  assert.equal(h.live.snapshot().status, 'Connected');
  assert.equal(h.live.snapshot().recoveryExhausted, false);
  assert.equal(h.live.snapshot().reconnectAttempts, 0);
  h.live.onEngineStatus('node', 'Disconnected', 'network');
  assert.equal(h.timers.at(-1).delay, 2000);
});

test('Stop and shutdown cancel slow recovery; disabled reconnect and permanent errors never schedule it', async () => {
  for (const shutdown of [false, true]) {
    const h = harness({ maxAttempts: 0 });
    h.node.start = async () => { throw Error('offline'); };
    await assert.rejects(h.live.start('broadcaster'));
    const timer = h.timers.at(-1); assert.equal(timer.delay, 300_000);
    await h.live.stop({ shutdown }); assert.equal(timer.cancelled, true);
    timer.fn(); await h.live.operation;
    assert.equal(h.live.snapshot().status, 'Disconnected');
  }
  for (const options of [{ autoReconnect: false }, {}]) {
    const h = harness(options);
    h.node.start = async () => { throw Error('API key Cloud WebSocket Eulerstream tidak diterima.'); };
    await assert.rejects(h.live.start('broadcaster'));
    assert.equal(h.timers.length, 0);
  }
});
