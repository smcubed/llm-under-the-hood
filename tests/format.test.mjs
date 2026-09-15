import { test } from 'node:test';
import assert from 'node:assert/strict';
import { formatCost, formatLatency, formatTokens } from '../site/format.js';

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

test('formatLatency', () => {
  assert.equal(formatLatency(850), '850 ms');
  assert.equal(formatLatency(1200), '1.2 s');
  assert.equal(formatLatency(999.6), '1000 ms');
  assert.equal(formatLatency(0), '0 ms');
  assert.equal(formatLatency(-1), '');
  assert.equal(formatLatency(null), '');
});

test('formatTokens', () => {
  assert.equal(formatTokens({ prompt: 12, completion: 80 }), '12 in · 80 out');
  assert.equal(formatTokens({ prompt: 12 }), '12 in');
  assert.equal(formatTokens({}), '');
  assert.equal(formatTokens(null), '');
});
