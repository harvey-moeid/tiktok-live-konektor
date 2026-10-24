import test from 'node:test';
import assert from 'node:assert/strict';
import { normalizeGiftData } from '../server/gifts.js';

test('reads giftName from the top-level TikTok gift event', () => {
  const d = normalizeGiftData({ giftName: 'Rose', giftId: 5655, repeatCount: 3, repeatEnd: true, diamondCount: 1, giftType: 1 });
  assert.deepEqual(d, {
    giftId: '5655', giftName: 'Rose', repeatCount: 3, repeatEnd: true,
    giftType: 1, streakable: true, diamondCount: 1, totalValue: 3
  });
});

test('reads giftDetails and extendedGiftInfo names (multiple connector schemas)', () => {
  const modern = normalizeGiftData({ giftDetails: { giftId: '5953', giftName: 'TikTok Universe', diamondCount: 44999 } });
  assert.equal(modern.giftName, 'TikTok Universe');
  assert.equal(modern.giftId, '5953');
  assert.equal(modern.diamondCount, 44999);
  const legacy = normalizeGiftData({ gift: { gift_id: 12 }, extendedGiftInfo: { name: 'Nevalyashka doll', diamond_count: 25 } });
  assert.equal(legacy.giftName, 'Nevalyashka doll');
  assert.equal(legacy.giftId, '12');
  assert.equal(legacy.totalValue, 25);
  const snake = normalizeGiftData({ gift: { gift_id: 1000, name: '  Heart  ', gift_type: 1 }, repeat_count: 4, repeat_end: 1 });
  assert.equal(snake.giftName, 'Heart');
  assert.equal(snake.totalValue, 0);
  assert.equal(snake.repeatCount, 4);
  assert.equal(snake.repeatEnd, true);
});

test('does not turn placeholder Unknown into a real name', () => {
  const d = normalizeGiftData({ giftName: 'Unknown', gift: { gift_id: 5953, name: 'Rose' } });
  assert.equal(d.giftName, 'Rose');
  assert.equal(normalizeGiftData({ giftName: 'unknown', giftId: 5953 }).giftName, 'Gift #5953');
  assert.equal(normalizeGiftData({ giftName: '  ' }).giftName, 'Gift tidak dikenal');
  assert.equal(normalizeGiftData({}).giftId, null);
});

test('caches valid names by gift ID for temporarily incomplete events', () => {
  const cache = new Map();
  assert.equal(normalizeGiftData({ giftId: 5953 }, cache).giftName, 'Gift #5953');
  assert.equal(normalizeGiftData({ giftId: 5953, extendedGiftInfo: { name: 'Rose' } }, cache).giftName, 'Rose');
  assert.equal(normalizeGiftData({ giftId: 5953, giftName: 'Unknown' }, cache).giftName, 'Rose');
  assert.equal(normalizeGiftData({ giftId: 5954 }, cache).giftName, 'Gift #5954');
  assert.equal(cache.has('5954'), false);
});

test('limits name cache size and keeps most recent gift metadata', () => {
  const cache = new Map();
  for (let id = 1; id <= 510; id++) normalizeGiftData({ giftId: id, giftName: 'Gift ' + id }, cache);
  assert.equal(cache.size, 500);
  assert.equal(cache.has('1'), false);
  assert.equal(cache.get('510'), 'Gift 510');
});

test('ignores invalid IDs, respects valid zero-cost gifts, and prevents negative counters', () => {
  const d = normalizeGiftData({ giftId: 0, diamondCount: 0, repeatCount: -5, giftType: 0 });
  assert.equal(d.giftId, null);
  assert.equal(d.giftName, 'Gift tidak dikenal');
  assert.equal(d.repeatCount, 1);
  assert.equal(d.totalValue, 0);
});
