import { test, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { installFakeDom } from './helpers/fake-dom.mjs';
import { formatPercent, barRows, tokenLabelText, makeBar, paintBar, renderBars } from '../site/bars.js';

const top = [{ text: ' CT', logprob: Math.log(0.6) }, { text: ' MRI', logprob: Math.log(0.3) }, { text: '\n', logprob: Math.log(0.05) }];

test('formatPercent', () => {
  assert.equal(formatPercent(0.6), '60%');
  assert.equal(formatPercent(0.05), '5.0%');
  assert.equal(formatPercent(0.0004), '<0.1%');
  assert.equal(formatPercent(0), '0%');
  assert.equal(formatPercent(NaN), '0%');
  assert.equal(formatPercent(1), '100%');
});

test('tokenLabelText marks a leading space and uses the display form', () => {
  assert.equal(tokenLabelText(' CT'), '␣CT');
  assert.equal(tokenLabelText('\n'), '↵');
  assert.equal(tokenLabelText('x'), 'x');
});

test('barRows raw: one row per candidate plus "everything else" for the remainder; labels use the display form', () => {
  const rows = barRows(top, null);
  assert.equal(rows.length, 4);
  assert.deepEqual(rows.map(r => r.label), ['␣CT', '␣MRI', '↵', 'everything else']);
  assert.deepEqual(rows.map(r => r.percent), ['60%', '30%', '5.0%', '5.0%']);
  assert.ok(Math.abs(rows[3].p - 0.05) < 1e-9);
  assert.equal(rows[3].other, true);
  assert.equal(rows[3].text, null);
  assert.equal(rows[0].other, false);
  assert.equal(rows[0].text, ' CT');
});

test('barRows rescaled: the shown set sums to 1 with no remainder row, and the order is unchanged', () => {
  const rows = barRows(top, 1);
  assert.equal(rows.length, 3);
  assert.ok(Math.abs(rows.reduce((s, r) => s + r.p, 0) - 1) < 1e-9);
  assert.deepEqual(rows.map(r => r.text), [' CT', ' MRI', '\n']);
  assert.ok(rows.every(r => !r.other));
  const cold = barRows(top, 0);
  assert.deepEqual(cold.map(r => r.percent), ['100%', '0%', '0%']);
  const hot = barRows(top, 1.5);
  assert.ok(hot[0].p < rows[0].p && hot[2].p > rows[2].p, 'higher temperature flattens');
});

test('barRows tolerates a non-numeric logprob (p treated as 0)', () => {
  const rows = barRows([{ text: 'a', logprob: 'x' }, { text: 'b', logprob: 0 }], null);
  assert.equal(rows[0].p, 0);
  assert.equal(rows[0].percent, '0%');
  assert.equal(rows[1].percent, '100%');
});

let dom;
beforeEach(() => { dom = installFakeDom(); });
afterEach(() => { dom.restore(); });

test('makeBar/paintBar build a row whose fill, percentage, label and picked state can be repainted', () => {
  const bar = makeBar(' CT');
  assert.equal(bar.row.querySelector('.bar-label').textContent, '␣CT');
  assert.equal(bar.fill.style.width, '0%');
  paintBar(bar, 0.6, '60%', '␣CT', true);
  assert.equal(bar.fill.style.width, '60.00%');
  assert.equal(bar.pct.textContent, '60%');
  assert.ok(bar.row.classList.contains('is-picked'));
  assert.equal(bar.row.attributes['aria-label'], '␣CT: 60%');
  paintBar(bar, 0.3, '30%', '␣CT', false);
  assert.ok(!bar.row.classList.contains('is-picked'));
  const other = makeBar(null, { other: true });
  assert.ok(other.row.classList.contains('bar-other'));
  assert.equal(other.row.querySelector('.bar-label').textContent, 'everything else');
});

test('renderBars replaces the container with painted rows, honours limit and marks the picked text', () => {
  const box = dom.document.createElement('div');
  box.append(dom.document.createElement('p'));
  const bars = renderBars(box, barRows(top, null), { picked: ' MRI', limit: 3 });
  assert.equal(bars.length, 3);
  assert.equal(box.children.length, 3, 'old content is gone; the remainder row was cut by limit');
  assert.deepEqual(box.children.map(r => r.querySelector('.bar-pct').textContent), ['60%', '30%', '5.0%']);
  assert.deepEqual(box.children.map(r => r.classList.contains('is-picked')), [false, true, false]);
  renderBars(box, [{ text: 'a', p: 0.5 }, { text: 'b', p: NaN }], { picked: 1 });
  assert.deepEqual(box.children.map(r => r.querySelector('.bar-pct').textContent), ['50%', '0%']);
  assert.deepEqual(box.children.map(r => r.classList.contains('is-picked')), [false, true]);
  assert.equal(box.children[0].attributes['aria-label'], 'a: 50%');
});
