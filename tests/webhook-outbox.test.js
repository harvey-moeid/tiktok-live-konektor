import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { WebhookOutbox } from '../server/webhook-outbox.js';

const event = id => ({ id, version: 1, event: 'gift', data: { repeatCount: 1 } });
async function waitFor(predicate) {
  const end = Date.now() + 2000;
  while (!predicate()) {
    if (Date.now() > end) throw Error('Timed out waiting for outbox');
    await new Promise(resolve => setTimeout(resolve, 5));
  }
}
async function fixture(t, options = {}) {
  const directory = await mkdtemp(path.join(tmpdir(), 'tlk-outbox-'));
  const instances = [];
  const make = extra => {
    const instance = new WebhookOutbox({ file: path.join(directory, 'outbox.sqlite'),
      deliver: async () => {}, autoStart: false, ...options, ...extra });
    instances.push(instance); return instance;
  };
  t.after(async () => {
    for (const instance of instances) if (instance.db) await instance.close({ timeoutMs: 0 });
    await rm(directory, { recursive: true, force: true });
  });
  return make;
}

test('durable enqueue survives restart and preserves event IDs and exact payloads', async t => {
  const make = await fixture(t); const first = make(); const e = event('event-1'); const body = JSON.stringify(e);
  assert.equal(first.enqueue(e, body, ['https://one.test/hook', 'https://two.test/hook']), 2);
  assert.equal(first.enqueue(e, body, ['https://one.test/hook']), 0);
  await first.close();
  const deliveries = []; const second = make({ deliver: async job => deliveries.push(job) });
  assert.equal(second.snapshot().pending, 2); second.start();
  await waitFor(() => second.snapshot().pending === 0);
  assert.deepEqual(deliveries.map(x => x.event_id), ['event-1', 'event-1']);
  assert.ok(deliveries.every(x => x.body === body));
});

test('retry exhaustion is durable and explicit replay retains the original event ID', async t => {
  const make = await fixture(t, { maxAttempts: 2, retryDelay: () => 0 });
  let attempts = 0;
  const first = make({ deliver: async () => { attempts++; throw Object.assign(Error('unavailable'), { code: 'HTTP_503' }); } });
  const e = event('retry-event'); first.enqueue(e, JSON.stringify(e), ['https://one.test/hook']); first.start();
  await waitFor(() => first.snapshot().failed === 1);
  assert.equal(attempts, 2); await first.close();
  const sent = []; const second = make({ deliver: async job => sent.push(job.event_id) });
  assert.equal(second.snapshot().failed, 1); assert.equal(second.retryFailed(), 1);
  await waitFor(() => second.snapshot().pending === 0 && second.snapshot().failed === 0);
  assert.deepEqual(sent, ['retry-event']);
});

test('shutdown timeout aborts active HTTP work and leaves unacknowledged jobs recoverable', async t => {
  const make = await fixture(t); let aborted = false;
  const first = make({ deliver: (_job, signal) => new Promise((_resolve, reject) => {
    signal.addEventListener('abort', () => { aborted = true; reject(Error('aborted')); }, { once: true });
  }) });
  const e = event('uncertain'); first.enqueue(e, JSON.stringify(e), ['https://one.test/hook']); first.start();
  await first.close({ timeoutMs: 1 }); assert.equal(aborted, true);
  const sent = []; const second = make({ deliver: async job => sent.push(job.event_id) }); second.start();
  await waitFor(() => second.snapshot().pending === 0);
  assert.deepEqual(sent, ['uncertain']);
});

test('capacity rejects a multi-destination event atomically and exposes rejection', async t => {
  const make = await fixture(t, { capacity: 2 }); const box = make(); const e = event('too-many');
  assert.throws(() => box.enqueue(e, JSON.stringify(e), ['https://one.test', 'https://two.test', 'https://three.test']), /penuh/);
  assert.equal(box.snapshot().pending, 0); assert.equal(box.snapshot().rejected, 3);
});

test('storage errors fail enqueue without acknowledging or partially inserting destinations', async t => {
  const make = await fixture(t); const box = make(); box.db.exec('PRAGMA query_only=ON');
  const e = event('disk-error');
  assert.throws(() => box.enqueue(e, JSON.stringify(e), ['https://one.test']));
  assert.equal(box.snapshot().pending, 0); assert.equal(box.snapshot().storageErrors, 1);
});

test('removing or disabling destinations cancels queued deliveries', async t => {
  const make = await fixture(t); const sent = []; const box = make({ deliver: async job => sent.push(job.url) });
  const e = event('cancel'); box.enqueue(e, JSON.stringify(e), ['https://one.test', 'https://two.test']);
  box.reconcile(['https://two.test']); box.start();
  await waitFor(() => box.snapshot().pending === 0);
  assert.deepEqual(sent, ['https://two.test']);
});

test('delivery concurrency is bounded while all pending jobs remain durable', async t => {
  const make = await fixture(t, { concurrency: 2 }); const releases = []; let active = 0, peak = 0;
  const box = make({ deliver: async () => {
    active++; peak = Math.max(active, peak);
    await new Promise(resolve => releases.push(resolve)); active--;
  } });
  for (let i = 0; i < 6; i++) { const e = event('bounded-' + i); box.enqueue(e, JSON.stringify(e), ['https://one.test']); }
  box.start(); assert.equal(box.snapshot().pending, 6); assert.equal(box.snapshot().active, 2);
  for (let i = 0; i < 3; i++) {
    await waitFor(() => releases.length === 2); releases.splice(0).forEach(resolve => resolve());
  }
  await waitFor(() => box.snapshot().pending === 0); assert.equal(peak, 2);
});

test('explicit recovery acknowledges overflow without erasing loss counters and detects new incidents', async t => {
  const make = await fixture(t, { capacity: 1 }); const box = make();
  box.enqueue(event('first'), '{}', ['https://one.test']);
  assert.throws(() => box.enqueue(event('lost'), '{}', ['https://one.test']), /penuh/);
  box.start(); await waitFor(() => box.snapshot().pending === 0);
  assert.equal(box.snapshot().needsAttention, true);
  box.retryFailed();
  assert.equal(box.snapshot().needsAttention, false);
  assert.equal(box.snapshot().rejected, 1);
  assert.throws(() => box.enqueue(event('lost-again'), '{}', ['https://one.test', 'https://two.test']), /penuh/);
  assert.equal(box.snapshot().needsAttention, true);
});

test('storage recovery requires a successful write and preserves error history', async t => {
  const make = await fixture(t); const box = make(); box.db.exec('PRAGMA query_only=ON');
  assert.throws(() => box.enqueue(event('lost'), '{}', ['https://one.test']));
  assert.throws(() => box.retryFailed());
  assert.equal(box.snapshot().needsAttention, true);
  box.db.exec('PRAGMA query_only=OFF'); box.retryFailed();
  assert.equal(box.snapshot().needsAttention, false);
  assert.equal(box.snapshot().storageErrors, 1);
  box.enqueue(event('recovered'), '{}', ['https://one.test']);
  await waitFor(() => box.snapshot().pending === 0);
});
