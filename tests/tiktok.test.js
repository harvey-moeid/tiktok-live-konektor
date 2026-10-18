import test from 'node:test';
import assert from 'node:assert/strict';
import { extractRoomIdFromHtml, TikTokService } from '../server/tiktok.js';
import { TikTokLiveConnection } from 'tiktok-live-connector';
import { LiveController } from '../server/live-controller.js';
import { LiveStats } from '../server/stats.js';

test('extracts roomId from TikTok JSON', () => {
  assert.equal(extractRoomIdFromHtml('<script>{"roomId":"123456789012345"}</script>'), '123456789012345');
});

test('extracts room_id variant', () => {
  assert.equal(extractRoomIdFromHtml('window.x={"room_id":123456789012345}'), '123456789012345');
});

test('extracts escaped roomId from embedded JSON string', () => {
  const html = String.raw`<script>{"payload":"{\"roomId\":\"7693584931198438164\"}"}</script>`;
  assert.equal(extractRoomIdFromHtml(html), '7693584931198438164');
});

test('extracts HTML-entity encoded roomId', () => {
  const html = '<script>{&quot;roomId&quot;:&quot;7693584931198438164&quot;}</script>';
  assert.equal(extractRoomIdFromHtml(html), '7693584931198438164');
});

test('does not accept short numeric ids', () => {
  assert.equal(extractRoomIdFromHtml('{"roomId":"1234"}'), '');
});

test('does not mistake a generic object id for a LIVE room id', () => {
  assert.equal(extractRoomIdFromHtml('{"id":"7499912345678901234","uniqueId":"streamer"}'), '');
});

test('real SDK decoder follow/share events are forwarded to application consumers', async () => {
  const events = [];
  const service = new TikTokService({ emitEvent: e => events.push(e), setStatus: () => {} });
  const connection = new TikTokLiveConnection('broadcaster', {});
  service.connection = connection; service.bind(connection);
  for (const kind of ['follow', 'share']) {
    await connection.processDecodedData({ type: 'WebcastSocialMessage', data: {
      user: { uniqueId: 'alice', nickname: 'Alice' }, common: { displayText: { key: 'pm_mt_msg_viewer_' + kind } }
    } });
  }
  assert.deepEqual(events.map(e => e.event), ['follow', 'share']);
  assert.deepEqual(events.map(e => e.data.username), ['alice', 'alice']);
  await service.stop();
});

test('gift packets without a real upstream message ID retain distinct event identities', async () => {
  const events = [];
  const service = new TikTokService({ emitEvent: e => events.push(e), setStatus: () => {} });
  const c = new TikTokLiveConnection('broadcaster', {}); service.connection = c; service.bind(c);
  const data = { common: { msgId: '0' }, giftId: 1, giftType: 0, repeatCount: 1 };
  await c.processDecodedData({ type: 'WebcastGiftMessage', data });
  await c.processDecodedData({ type: 'WebcastGiftMessage', data });
  assert.equal(events.length, 2); assert.notEqual(events[0].id, events[1].id);
  await service.stop();
});

test('retired native transports cannot change status or emit events after stop', async () => {
  const events = [], statuses = [];
  const service = new TikTokService({ emitEvent: e => events.push(e), setStatus: s => statuses.push(s) });
  const retired = new TikTokLiveConnection('broadcaster', {});
  service.connection = retired; service.bind(retired);
  await service.stop();
  retired.emit('connected', { roomId: '123456789' });
  retired.emit('chat', { comment: 'stale' });
  retired.emit('disconnected', {});
  assert.deepEqual(events, []); assert.deepEqual(statuses, ['Disconnected']);
});

test('real SDK initial data reaches counters after a single session-start boundary', async () => {
  const events = [], stats = new LiveStats(); let live;
  const service = new TikTokService({
    emitEvent: e => live.onEngineEvent('node', e), setStatus: (s, e) => live.onEngineStatus('node', s, e),
    connectionFactory: (username, options) => {
      const c = new TikTokLiveConnection(username, options);
      c._connect = async () => {
        await c.processDecodedData({ type: 'WebcastChatMessage', data: { common: { msgId: 'chat-1' }, comment: 'initial' } });
        await c.processDecodedData({ type: 'WebcastGiftMessage', data: { common: { msgId: 'gift-1' }, giftId: '1', giftType: 0, repeatCount: 1, diamondCount: 100, user: { uniqueId: 'alice' } } });
        await c.processDecodedData({ type: 'WebcastSocialMessage', data: { common: { msgId: 'follow-1', displayText: { key: 'viewer_follow' } }, user: { uniqueId: 'alice' } } });
      };
      return c;
    }
  });
  live = new LiveController({ engines: { node: service }, emitEvent: e => { events.push(e); stats.consume(e); } });
  await live.start('broadcaster', '123456789');
  assert.deepEqual(events.map(e => e.event), ['stream', 'chat', 'gift', 'follow']);
  assert.equal(stats.value.chat, 1); assert.equal(stats.value.giftCoins, 100); assert.equal(stats.value.follows, 1);
  await live.stop();
});
