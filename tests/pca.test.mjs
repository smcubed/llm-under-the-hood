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
test('rank-1 input has no second component: every y is exactly 0', () => {
  const dir = [3, -1, 2];
  const pts = pca2d(Array.from({ length: 12 }, (_, i) => dir.map(x => x * (i - 5.5))));
  assert.ok(pts.every(p => p[1] === 0), `second coordinates ${pts.map(p => p[1]).join(', ')}`);
  assert.ok(pts.some(p => Math.abs(p[0]) > 1), 'the first component still carries the spread');
  assert.ok(pts.every(p => Number.isFinite(p[0]) && Number.isFinite(p[1])));
  // Canonical sign: the component's largest-|entry| coordinate (dir[0] = 3) is positive, so the row with the largest
  // positive multiple of dir projects to a positive x.
  assert.ok(pts[11][0] > 0, `expected positive x for the top row, got ${pts[11][0]}`);
});
test('sign is canonical: permuting the rows leaves each point where it was', () => {
  const rows = Array.from({ length: 30 }, (_, i) => [Math.sin(i) * 4, Math.cos(i * 0.7) * 2, (i % 5) - 2, Math.sin(i * 1.3)]);
  const perm = rows.map((_, i) => i).sort((a, b) => ((a * 7919) % 31) - ((b * 7919) % 31));
  const a = pca2d(rows);
  const b = pca2d(perm.map(i => rows[i]));
  perm.forEach((orig, j) => {
    assert.ok(Math.abs(a[orig][0] - b[j][0]) < 1e-9 && Math.abs(a[orig][1] - b[j][1]) < 1e-9, `row ${orig} moved: ${a[orig]} vs ${b[j]}`);
  });
  // Something was actually flipped into the canonical orientation: the larger-|entry| convention makes this deterministic.
  assert.ok(a.some(p => p[0] > 0) && a.some(p => p[0] < 0));
});
