import { test } from 'node:test';
import assert from 'node:assert/strict';
import { pca2d } from '../tools/pca.mjs';
test('pca2d projects to 2 dims and separates two clusters', () => {
  const a = Array.from({ length: 20 }, (_, i) => [10 + Math.sin(i), 10 + Math.cos(i), 0.1 * i]);
  const b = Array.from({ length: 20 }, (_, i) => [-10 + Math.sin(i), -10 + Math.cos(i), 0.1 * i]);
  const pts = pca2d([...a, ...b]);
  assert.equal(pts.length, 40); assert.equal(pts[0].length, 2);
  const ma = pts.slice(0, 20).reduce((s, p) => s + p[0], 0) / 20, mb = pts.slice(20).reduce((s, p) => s + p[0], 0) / 20;
  assert.ok(Math.abs(ma - mb) > 5);
});
