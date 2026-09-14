import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Ledger } from '../worker/src/ledger.js';

test('hit allows up to the per-minute limit then blocks with retryAfter', () => {
  let t = 1_000_000; const l = new Ledger(() => t);
  for (let i = 0; i < 3; i++) assert.equal(l.hit('c1', 3).ok, true);
  const r = l.hit('c1', 3);
  assert.equal(r.ok, false); assert.ok(r.retryAfterSec >= 1 && r.retryAfterSec <= 60);
  t += 61_000;
  assert.equal(l.hit('c1', 3).ok, true);
});
test('hits are independent per client', () => {
  const l = new Ledger(() => 0);
  l.hit('a', 1); assert.equal(l.hit('b', 1).ok, true);
});
test('charge accumulates per bucket per UTC day and canSpend respects the limit', () => {
  let t = Date.UTC(2026, 8, 14, 12); const l = new Ledger(() => t);
  assert.equal(l.canSpend('default', 1), true);
  l.charge('default', 0.6); l.charge('default', 0.5);
  assert.equal(l.canSpend('default', 1), false);
  assert.equal(l.canSpend('gpt4', 1), true);
  assert.ok(Math.abs(l.spent('default') - 1.1) < 1e-12);
  t = Date.UTC(2026, 8, 15, 0, 1);
  assert.equal(l.canSpend('default', 1), true); assert.equal(l.spent('default'), 0);
});
test('snapshot/restore round-trips and prunes stale data', () => {
  let t = Date.UTC(2026, 8, 14, 12); const l = new Ledger(() => t);
  l.hit('a', 5); l.charge('default', 0.2);
  const snap = JSON.parse(JSON.stringify(l.snapshot()));
  const l2 = new Ledger(() => t); l2.restore(snap);
  assert.ok(Math.abs(l2.spent('default') - 0.2) < 1e-12);
  assert.equal(l2.hit('a', 1).ok, false);
  t += 3 * 24 * 3600 * 1000;
  const l3 = new Ledger(() => t); l3.restore(snap);
  assert.equal(l3.spent('default'), 0);
  assert.equal(Object.keys(l3.snapshot().minute).length, 0);
});
test('reserveIfUnder charges only while spend is under the limit, and reports which happened', () => {
  let t = Date.UTC(2026, 8, 14, 12); const l = new Ledger(() => t);
  assert.equal(l.reserveIfUnder('default', 0.6, 1), true);
  assert.ok(Math.abs(l.spent('default') - 0.6) < 1e-12);
  // Still under the limit, so the reservation goes through even though it will push spend over.
  assert.equal(l.reserveIfUnder('default', 0.6, 1), true);
  assert.ok(Math.abs(l.spent('default') - 1.2) < 1e-12);
  // Now at/over the limit: nothing is charged.
  assert.equal(l.reserveIfUnder('default', 0.1, 1), false);
  assert.ok(Math.abs(l.spent('default') - 1.2) < 1e-12);
  assert.equal(l.reserveIfUnder('gpt4', 0.1, 1), true, 'buckets are independent');
  t = Date.UTC(2026, 8, 15, 0, 1);
  assert.equal(l.reserveIfUnder('default', 0.1, 1), true, 'a new UTC day resets the bucket');
});
