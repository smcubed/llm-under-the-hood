import { test } from 'node:test';
import assert from 'node:assert/strict';
import { formatCost, formatLatency, formatTiming, formatTokens } from '../site/format.js';

test('formatCost', () => {
  assert.equal(formatCost(0.0004), '$0.0004');
  assert.equal(formatCost(0.00004), '< $0.0001');
  assert.equal(formatCost(0.0001), '$0.0001');
  assert.equal(formatCost(0.00123), '$0.0012');
  assert.equal(formatCost(0.0567), '$0.057');
  assert.equal(formatCost(1.5), '$1.50');
  assert.equal(formatCost(0), '$0');
  assert.equal(formatCost(null), '');
  assert.equal(formatCost('x'), '');
});

test('formatLatency: seconds with one decimal, a floor under 50 ms', () => {
  assert.equal(formatLatency(850), '0.9 s');
  assert.equal(formatLatency(1200), '1.2 s');
  assert.equal(formatLatency(999.6), '1.0 s');
  assert.equal(formatLatency(400), '0.4 s');
  assert.equal(formatLatency(49), '< 0.1 s');
  assert.equal(formatLatency(0), '< 0.1 s');
  assert.equal(formatLatency(12345), '12.3 s');
  assert.equal(formatLatency(-1), '');
  assert.equal(formatLatency(null), '');
  assert.equal(formatLatency('x'), '');
});

test('formatTiming labels time to first token and total, or just the total when no token arrived', () => {
  assert.equal(formatTiming({ firstTokenMs: 400, latencyMs: 1300 }), 'first token 0.4 s · total 1.3 s');
  assert.equal(formatTiming({ firstTokenMs: null, latencyMs: 1300 }), 'took 1.3 s');
  assert.equal(formatTiming({ firstTokenMs: 400, latencyMs: null }), '');
  assert.equal(formatTiming({}), '');
  assert.equal(formatTiming(null), '');
});

test('formatTokens', () => {
  assert.equal(formatTokens({ prompt: 12, completion: 80 }), '12 in · 80 out');
  assert.equal(formatTokens({ prompt: 12 }), '12 in');
  assert.equal(formatTokens({}), '');
  assert.equal(formatTokens(null), '');
});
