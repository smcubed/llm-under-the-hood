import { DurableObject } from 'cloudflare:workers';
import { Ledger } from './ledger.js';

export class LedgerObject extends DurableObject {
  constructor(ctx, env) {
    super(ctx, env);
    this.ledger = new Ledger();
    ctx.blockConcurrencyWhile(async () => {
      const snap = await ctx.storage.get('state');
      if (snap) this.ledger.restore(snap);
    });
  }
  async persist() { await this.ctx.storage.put('state', this.ledger.snapshot()); }
  async hit(clientId, limit) { const r = this.ledger.hit(clientId, limit); await this.persist(); return r; }
  async canSpend(bucket, limit) { return this.ledger.canSpend(bucket, limit); }
  async charge(bucket, usd) { this.ledger.charge(bucket, usd); await this.persist(); }
  async spent(bucket) { return this.ledger.spent(bucket); }
}
