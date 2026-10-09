import test from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { ManagedLiveConnection, normalizeManagedMessage, extractManagedMessages, managedCloseReason } from '../server/managed-live.js';

const fake = () => {
  const socket = new EventEmitter();
  socket.close = () => { socket.closed = true; };
  return socket;
};
function bridge(socket, opts = {}) {
  const events = [], statuses = [], calls = [];
  const instance = new ManagedLiveConnection({
    apiKey: 'community-key',
    socketFactory: (url, init) => { calls.push({ url, init }); return socket; },
    urlFactory: (options) => 'wss://ws.example.test/?apiKey=' + options.apiKey,
    emitEvent: (event) => events.push(event),
    setStatus: (...args) => statuses.push(args),
    timeoutMs: 1000,
    ...opts
  });
  return { instance, events, statuses, calls };
}
test('normalizes managed Webcast events to existing overlay/webhook contract', () => {
  const user = { uniqueId: 'visitor', nickname: 'Viewer' };
  const chat = normalizeManagedMessage('WebcastChatMessage', { user, comment: 'halo' });
  assert.deepEqual(chat, { event: 'chat', data: { username: 'visitor', nickname: 'Viewer', message: 'halo' } });
  const gift = normalizeManagedMessage('WebcastGiftMessage', { user, giftId: 5655, gift: { name: 'Rose', diamondCount: 1 }, repeatCount: 2, repeatEnd: true });
  assert.equal(gift.event, 'gift');
  assert.equal(gift.data.giftId, '5655');
  assert.equal(gift.data.giftName, 'Rose');
  assert.equal(gift.data.totalValue, 2);
  assert.deepEqual(normalizeManagedMessage('WebcastSocialMessage', { user, displayType: 'pm_mt_guidance_follow' }), { event: 'follow', data: { username: 'visitor', nickname: 'Viewer' } });
  assert.equal(normalizeManagedMessage('WebcastSocialMessage', { user, displayType: 'other' }), null);
  assert.deepEqual(normalizeManagedMessage('WebcastRoomUserSeqMessage', { total: 35 }), { event: 'viewer', data: { viewerCount: 35 } });
});

test('extracts bundled and singleton frames and ignores invalid frames', () => {
  const bundled = Buffer.from(JSON.stringify({ timestamp: 123, messages: [
    { type: 'WebcastChatMessage', data: { comment: 'ok' } },
    { type: 'room.status', data: { state: 'connected', roomId: '123456789012345' } }
  ] }));
  assert.deepEqual(extractManagedMessages(bundled).map(x => x.type), ['WebcastChatMessage', 'room.status']);
  assert.equal(extractManagedMessages(JSON.stringify({ type: 'WebcastLikeMessage', data: { count: 2 } })).length, 1);
  assert.deepEqual(extractManagedMessages('bad payload'), []);
  assert.deepEqual(extractManagedMessages(Buffer.alloc(256 * 1024 + 1)), []);
});

test('requires room.status connected, preserves username and normalized events', async () => {
  const socket = fake();
  const { instance, events, calls, statuses } = bridge(socket);
  const pending = instance.start('some_live');
  socket.emit('open');
  socket.emit('message', JSON.stringify({ type: 'WebcastChatMessage', data: { comment: 'premature' } }));
  socket.emit('message', JSON.stringify({ type: 'room.status', data: { state: 'connected', roomId: '123456789012345' } }));
  const connection = await pending;
  assert.equal(connection.roomId, '123456789012345');
  socket.emit('message', JSON.stringify({ messages: [
    { type: 'WebcastChatMessage', data: { user: { uniqueId: 'guest' }, comment: 'hello' } },
    { type: 'WebcastLikeMessage', data: { user: { uniqueId: 'guest' }, count: 3 } },
    { type: 'WebcastGiftMessage', data: { giftId: 5655, giftName: 'Rose', repeatCount: 1 } }
  ] }));
  assert.deepEqual(events.map(x => x.event), ['chat', 'like', 'gift']);
  assert.equal(events[0].roomId, '123456789012345');
  assert.equal(events[0].username, 'some_live');
  assert.equal(events[0].data.message, 'hello');
  assert.equal(calls.length, 1);
  assert.equal(calls[0].url.includes('community-key'), true);
  socket.emit('close', 4005, Buffer.from('ended'));
  assert.equal(instance.active, false);
  assert.deepEqual(statuses, [['Disconnected', 'ended']]);
});

test('explicit stop prevents unexpected disconnect callbacks', async () => {
  const socket = fake();
  const { instance, statuses } = bridge(socket);
  const started = instance.start('some_live');
  socket.emit('message', JSON.stringify({ type: 'room.status', data: { state: 'connected' } }));
  await started;
  await instance.stop();
  socket.emit('close', 4401, Buffer.from('secret-invalid'));
  assert.deepEqual(statuses, []);
  assert.equal(socket.closed, true);
});

test('provider denial rejects with actionable message and does not emit synthetic events', async () => {
  const socket = fake();
  const { instance, events } = bridge(socket);
  const started = instance.start('some_live');
  socket.emit('close', 4403, Buffer.from(''));
  await assert.rejects(started, /izin Cloud WebSocket/);
  assert.deepEqual(events, []);
  assert.match(managedCloseReason(4401), /API key/);
  assert.match(managedCloseReason(4429), /Batas koneksi/);
});

test('missing API key disallows managed connection and avoids accidental anonymous use', async () => {
  const instance = new ManagedLiveConnection({ apiKey: '' });
  assert.equal(instance.enabled, false);
  await assert.rejects(instance.start('some_live'), /EULER_API_KEY/);
});
