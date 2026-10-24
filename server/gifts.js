/**
 * Normalize gift metadata from both legacy and current TikTok LIVE connector payloads.
 * giftName is retained for existing webhooks, overlays and dashboard consumers.
 */
const MISSING_NAME = /^(?:unknown|undefined|null|none|n\/a|gift)$/i;

function firstName(...values) {
  for (const value of values) {
    if (typeof value !== 'string') continue;
    const name = value.trim();
    if (name && !MISSING_NAME.test(name)) return name.slice(0, 200);
  }
  return '';
}

function firstId(...values) {
  for (const value of values) {
    if (typeof value !== 'string' && typeof value !== 'number') continue;
    const id = String(value).trim();
    if (/^[1-9]\d*$/.test(id)) return id;
  }
  return null;
}

function firstNumber(...values) {
  for (const value of values) {
    if (value === undefined || value === null || value === '') continue;
    const n = Number(value);
    if (Number.isFinite(n) && n >= 0) return n;
  }
  return 0;
}

export function normalizeGiftData(data, nameCache = new Map()) {
  const d = data || {};
  const gift = d.giftDetails || d.gift || {};
  const extra = d.extendedGiftInfo || {};
  const giftId = firstId(
    d.giftId, d.gift_id,
    d.giftDetails?.giftId, d.giftDetails?.gift_id, d.giftDetails?.id,
    d.gift?.giftId, d.gift?.gift_id, d.gift?.id, d.gift?.gift?.gift_id,
    extra.giftId, extra.gift_id, extra.id
  );
  const resolvedName = firstName(
    d.giftName, d.gift_name,
    d.giftDetails?.giftName, d.giftDetails?.gift_name, d.giftDetails?.name,
    d.gift?.giftName, d.gift?.gift_name, d.gift?.name,
    extra.name, extra.giftName, extra.gift_name,
    d.gift?.gift?.name
  );

  // Only cache real names. Never teach the cache a placeholder.
  if (giftId && resolvedName && nameCache) {
    nameCache.delete(giftId);
    nameCache.set(giftId, resolvedName);
    if (nameCache.size > 500) nameCache.delete(nameCache.keys().next().value);
  }
  const giftName = resolvedName || (giftId && nameCache?.get(giftId)) ||
    (giftId ? `Gift #${giftId}` : 'Gift tidak dikenal');

  const repeatCount = Math.max(1, firstNumber(d.repeatCount, d.repeat_count, gift.repeatCount, gift.repeat_count, 1));
  const diamondCount = firstNumber(
    d.diamondCount, d.diamond_count, gift.diamondCount, gift.diamond_count,
    extra.diamondCount, extra.diamond_count
  );
  const giftType = firstNumber(d.giftType, d.gift_type, gift.giftType, gift.gift_type);
  const repeatEnd = Boolean(d.repeatEnd ?? d.repeat_end ?? gift.repeatEnd ?? gift.repeat_end);

  return {
    giftId,
    giftName,
    repeatCount,
    repeatEnd,
    giftType,
    streakable: giftType === 1,
    diamondCount,
    totalValue: diamondCount * repeatCount
  };
}
