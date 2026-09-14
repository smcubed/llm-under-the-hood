import { test } from 'node:test';
import assert from 'node:assert/strict';
import { withProbs, rescale, sample, band } from '../site/probs.js';

const top = [ { text: ' CT', logprob: Math.log(0.6) }, { text: ' MRI', logprob: Math.log(0.3) }, { text: ' X', logprob: Math.log(0.05) } ];

test('withProbs adds p=exp(logprob) and an "other" remainder', () => {
  const r = withProbs(top);
  assert.ok(Math.abs(r.items[0].p - 0.6) < 1e-9);
  assert.ok(Math.abs(r.other - 0.05) < 1e-9);
  assert.equal(r.items.length, 3);
});
test('withProbs clamps other to >= 0 when rounding overshoots', () => {
  const r = withProbs([{ text: 'a', logprob: 0 }, { text: 'b', logprob: -0.0001 }]);
  assert.equal(r.other, 0);
});
test('rescale at T=1 renormalizes the shown set to sum 1, preserving order', () => {
  const r = rescale(top, 1);
  const sum = r.reduce((s, x) => s + x.p, 0);
  assert.ok(Math.abs(sum - 1) < 1e-9);
  assert.equal(r[0].text, ' CT');
  assert.ok(Math.abs(r[0].p - 0.6 / 0.95) < 1e-9);
});
test('rescale at T→0 gives the top token everything', () => {
  const r = rescale(top, 0);
  assert.equal(r[0].p, 1); assert.equal(r[1].p, 0);
});
test('rescale at high T flattens toward uniform', () => {
  const r = rescale(top, 1.5);
  assert.ok(r[0].p < 0.6 / 0.95); assert.ok(r[2].p > 0.05 / 0.95);
});
test('sample picks by cumulative probability using the supplied random', () => {
  const dist = rescale(top, 1);
  assert.equal(sample(dist, () => 0.0).text, ' CT');
  assert.equal(sample(dist, () => 0.7).text, ' MRI');
  assert.equal(sample(dist, () => 0.999).text, ' X');
});
test('band thresholds', () => {
  assert.equal(band(0.9), 'high'); assert.equal(band(0.6), 'high');
  assert.equal(band(0.4), 'mid'); assert.equal(band(0.25), 'mid');
  assert.equal(band(0.1), 'low'); assert.equal(band(null), 'unknown');
});
test('withProbs gives NaN for a null logprob and sums other from the rest', () => {
  const r = withProbs([{ text: 'a', logprob: Math.log(0.5) }, { text: 'b', logprob: null }]);
  assert.ok(Number.isNaN(r.items[1].p));
  assert.ok(Math.abs(r.other - 0.5) < 1e-9);
});
test('rescale treats a non-finite temperature as argmax', () => {
  for (const T of [NaN, undefined, Infinity, -Infinity]) {
    const r = rescale(top, T);
    assert.equal(r[0].p, 1); assert.equal(r[1].p, 0); assert.equal(r[2].p, 0);
  }
});
test('rescale keeps logprob on its outputs in both branches', () => {
  assert.equal(rescale(top, 1)[1].logprob, top[1].logprob);
  assert.equal(rescale(top, 0)[1].logprob, top[1].logprob);
});
test('sample returns null for an empty distribution', () => {
  assert.equal(sample([], () => 0.5), null);
});
test('band(NaN) is unknown', () => assert.equal(band(NaN), 'unknown'));
