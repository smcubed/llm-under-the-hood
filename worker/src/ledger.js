const dayKey = (ms) => new Date(ms).toISOString().slice(0, 10);

export class Ledger {
  constructor(now = () => Date.now()) { this.now = now; this.minute = {}; this.spend = {}; }

  hit(clientId, limitPerMinute) {
    const t = this.now(); const cutoff = t - 60_000;
    const arr = (this.minute[clientId] || []).filter(ts => ts > cutoff);
    if (arr.length >= limitPerMinute) {
      this.minute[clientId] = arr;
      return { ok: false, retryAfterSec: Math.max(1, Math.ceil((arr[0] + 60_000 - t) / 1000)) };
    }
    arr.push(t); this.minute[clientId] = arr;
    return { ok: true };
  }
  spent(bucket) { return this.spend[`${dayKey(this.now())}:${bucket}`] || 0; }
  canSpend(bucket, limitUsd) { return this.spent(bucket) < limitUsd; }
  /**
   * Atomically: if the bucket's spend so far is under `limitUsd`, charge `usd` and return true; otherwise leave it
   * untouched and return false. The check is "under the limit before this charge", so the bucket may end up over
   * the limit by at most one reservation. That is deliberate: the limit is a daily class budget, not a hard wall,
   * and refusing a request that would only just cross it would waste the last few cents of budget every day.
   */
  reserveIfUnder(bucket, usd, limitUsd) {
    if (!this.canSpend(bucket, limitUsd)) return false;
    this.charge(bucket, usd);
    return true;
  }
  charge(bucket, usd) {
    const k = `${dayKey(this.now())}:${bucket}`;
    this.spend[k] = (this.spend[k] || 0) + (Number(usd) || 0);
  }
  snapshot() {
    this.prune();
    return { minute: this.minute, spend: this.spend };
  }
  restore(snap) {
    this.minute = { ...(snap?.minute || {}) }; this.spend = { ...(snap?.spend || {}) };
    this.prune();
  }
  prune() {
    const t = this.now(); const cutoff = t - 60_000;
    for (const [k, arr] of Object.entries(this.minute)) {
      const kept = arr.filter(ts => ts > cutoff);
      if (kept.length) this.minute[k] = kept; else delete this.minute[k];
    }
    const today = dayKey(t), yesterday = dayKey(t - 86_400_000);
    for (const k of Object.keys(this.spend)) if (!k.startsWith(today) && !k.startsWith(yesterday)) delete this.spend[k];
  }
}
