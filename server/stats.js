const nonNegative = value => Number.isFinite(Number(value)) ? Math.max(0, Number(value)) : 0;

// Keep cumulative totals independently of the top-ten presentation. State is
// scoped to one LIVE room, and transport recovery in that room preserves totals.
export class LiveStats {
  constructor({ maxGifters = 100_000, maxStreaks = 20_000, streakTtlMs = 300_000, now = Date.now } = {}) {
    Object.assign(this, { maxGifters, maxStreaks, streakTtlMs, now });
    this.reset();
  }

  reset() {
    this.gifters = new Map();
    this.streaks = new Map();
    this.lastPrune = 0;
    this.value = { chat: 0, gifts: 0, giftCoins: 0, likes: 0, follows: 0,
      peakViewers: 0, viewerCount: 0, topGifter: [], trackingLimited: false };
  }

  consume(event) {
    const d = event.data || {};
    if (event.event === 'stream' && d.state === 'started' && !d.resumed) this.reset();
    if (event.event === 'chat') this.value.chat++;
    if (event.event === 'follow') this.value.follows++;
    if (event.event === 'like') this.value.likes += Math.max(nonNegative(d.likeCount), 1);
    if (event.event === 'viewer') {
      this.value.viewerCount = nonNegative(d.viewerCount);
      this.value.peakViewers = Math.max(this.value.peakViewers, this.value.viewerCount);
    }
    if (event.event === 'gift') this.addGift(d);
    return this.value;
  }

  addGift(d) {
    const username = String(d.username || 'unknown');
    const count = Math.max(1, nonNegative(d.repeatCount));
    let delta = count;
    if (d.streakable === true || Number(d.giftType) === 1) {
      const now = this.now();
      if (now - this.lastPrune >= 30_000 || this.streaks.size >= this.maxStreaks) {
        for (const [key, item] of this.streaks) if (now - item.at >= this.streakTtlMs) this.streaks.delete(key);
        this.lastPrune = now;
      }
      const key = JSON.stringify([username, d.giftId || d.giftName || 'unknown', d.groupId || '']);
      const previous = this.streaks.get(key)?.count || 0;
      delta = Math.max(count - previous, 0);
      if (d.repeatEnd) this.streaks.delete(key);
      else if (this.streaks.has(key) || this.streaks.size < this.maxStreaks) {
        this.streaks.set(key, { count: Math.max(previous, count), at: now });
      } else this.value.trackingLimited = true;
    }
    const coins = (nonNegative(d.diamondCount) || nonNegative(d.totalValue) / count) * delta;
    this.value.gifts += delta;
    this.value.giftCoins += coins;
    if (!coins) return;
    if (!this.gifters.has(username) && this.gifters.size >= this.maxGifters) {
      this.value.trackingLimited = true;
      return;
    }
    const total = (this.gifters.get(username) || 0) + coins;
    this.gifters.set(username, total);
    // Only this sender can enter or move within the top ten; all other totals
    // remain in the map even when their presentation row falls out of the list.
    const top = this.value.topGifter.filter(x => x.username !== username);
    top.push({ username, coins: total });
    top.sort((a, b) => b.coins - a.coins || a.username.localeCompare(b.username));
    this.value.topGifter = top.slice(0, 10);
  }
}
