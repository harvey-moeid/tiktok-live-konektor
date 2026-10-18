import test from 'node:test';
import assert from 'node:assert/strict';
import { LiveStats } from '../server/stats.js';
const gift = (s, data) => s.consume({ event: 'gift', data: { username: 'alice', giftId: '1', repeatCount: 1, diamondCount: 100, ...data } });

test('independent non-streak gifts are counted without a repeatEnd packet', () => {
  const s = new LiveStats();
  gift(s, { giftType: 0, repeatEnd: false }); gift(s, { giftType: 0, repeatEnd: false });
  assert.equal(s.value.gifts, 2); assert.equal(s.value.giftCoins, 200);
  assert.equal(s.streaks.size, 0);
});

test('streak progress, late metadata, regressing counts, final packets and a new streak', () => {
  const s = new LiveStats();
  gift(s, { giftType: 1, repeatCount: 1, giftName: 'Gift #1' });
  gift(s, { giftType: 1, repeatCount: 3, giftName: 'Rose' });
  gift(s, { giftType: 1, repeatCount: 2 });
  gift(s, { giftType: 1, repeatCount: 3, repeatEnd: true });
  assert.equal(s.value.gifts, 3); assert.equal(s.value.giftCoins, 300);
  gift(s, { giftType: 1, repeatCount: 2, repeatEnd: true });
  assert.equal(s.value.gifts, 5); assert.equal(s.value.giftCoins, 500);
});

test('senders outside top ten retain their entire cumulative contribution', () => {
  const s = new LiveStats();
  for (let i = 0; i < 10; i++) gift(s, { username: 'top' + i, repeatEnd: true });
  gift(s, { diamondCount: 90 }); gift(s, { diamondCount: 90 });
  assert.deepEqual(s.value.topGifter[0], { username: 'alice', coins: 180 });
  assert.equal(s.value.giftCoins, 1180);
});

test('same-room recovery preserves totals; a fresh session resets them', () => {
  const s = new LiveStats(); gift(s, {});
  s.consume({ event: 'stream', data: { state: 'started', resumed: true } });
  assert.equal(s.value.giftCoins, 100);
  s.consume({ event: 'stream', data: { state: 'started' } });
  assert.equal(s.value.giftCoins, 0); assert.equal(s.gifters.size, 0);
});

test('abandoned streaks expire and tracking limits are observable', () => {
  let now = 0; const s = new LiveStats({ now: () => now, maxStreaks: 1, maxGifters: 1, streakTtlMs: 100 });
  gift(s, { giftType: 1 }); now = 200;
  gift(s, { username: 'bob', giftType: 1 });
  assert.equal(s.streaks.size, 1); assert.equal(s.value.trackingLimited, true);
  assert.equal(s.value.giftCoins, 200);
});

test('overlapping gift streak groups retain separate counters', () => {
  const s = new LiveStats();
  gift(s, { giftType: 1, groupId: '1' }); gift(s, { giftType: 1, groupId: '2' });
  assert.equal(s.value.gifts, 2);
  gift(s, { giftType: 1, groupId: '1', repeatCount: 2, repeatEnd: true });
  gift(s, { giftType: 1, groupId: '2', repeatCount: 2, repeatEnd: true });
  assert.equal(s.value.gifts, 4); assert.equal(s.streaks.size, 0);
});
