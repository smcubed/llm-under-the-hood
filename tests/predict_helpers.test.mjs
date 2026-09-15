import { test } from 'node:test';
import assert from 'node:assert/strict';
import { joinTokens, forkAt, temperatureCaption, barsCaption, statusText, barRows, formatPercent, tokenBand, noProbsMessage, formatTemperature } from '../site/chapters/predict.js';
import { getModel } from '../site/models.js';

const top = [{ text: ' CT', logprob: Math.log(0.6) }, { text: ' MRI', logprob: Math.log(0.3) }, { text: '\n', logprob: Math.log(0.05) }];
const tokens = [
  { text: ' a', logprob: -0.1, top },
  { text: ' CT', logprob: -0.5, top: [{ text: ' CT', logprob: -0.5 }, { text: ' chest', logprob: -1.2 }] },
  { text: ' scan', logprob: -0.01, top: null },
];

test('joinTokens concatenates token text without separators', () => {
  assert.equal(joinTokens(tokens), ' a CT scan');
  assert.equal(joinTokens([]), '');
});

test('forkAt truncates at the index and appends the alternative with the step\'s alternatives carried over', () => {
  const forked = forkAt(tokens, 1, ' chest');
  assert.equal(forked.length, 2);
  assert.deepEqual(forked[0], tokens[0]);
  assert.deepEqual(forked[1], { text: ' chest', logprob: null, top: tokens[1].top });
  assert.equal(joinTokens(forked), ' a chest');
  assert.equal(tokens.length, 3, 'the input is not mutated');
  assert.equal(forkAt(tokens, 0, 'X').length, 1);
  assert.equal(forkAt(tokens, 2, 'X')[2].top, null, 'a step without alternatives still forks');
  assert.throws(() => forkAt(tokens, 3, 'X'), RangeError);
  assert.throws(() => forkAt(tokens, -1, 'X'), RangeError);
});

test('temperatureCaption bands', () => {
  assert.equal(temperatureCaption(0), 'Nearly always picks the favorite');
  assert.equal(temperatureCaption(0.2), 'Nearly always picks the favorite');
  assert.equal(temperatureCaption(0.3), 'Usually the favorite, sometimes a surprise');
  assert.equal(temperatureCaption(0.7), 'Usually the favorite, sometimes a surprise');
  assert.equal(temperatureCaption(1.0), 'Usually the favorite, sometimes a surprise');
  assert.equal(temperatureCaption(1.1), 'Anything goes');
  assert.equal(temperatureCaption(1.5), 'Anything goes');
});

test('barsCaption says whether the bars are raw or rescaled', () => {
  assert.equal(barsCaption(null), 'Raw probabilities from the model. Move the slider to rescale them.');
  assert.equal(barsCaption(undefined), barsCaption(null));
  assert.equal(barsCaption(0.7), 'Rescaled at temperature 0.7. Usually the favorite, sometimes a surprise.');
  assert.equal(barsCaption(1.5), 'Rescaled at temperature 1.5. Anything goes.');
  assert.equal(formatTemperature(1), '1.0');
});

test('statusText covers writing, paused, and every finish reason', () => {
  assert.equal(statusText(null, true, false), 'Writing…');
  assert.equal(statusText('stop', true, false), 'Writing…', 'streaming wins over a stale finish');
  assert.equal(statusText(null, false, true), 'Paused');
  assert.equal(statusText('stop', false, false), 'Finished (stop)');
  assert.equal(statusText('length', false, false), 'Cut off at the token limit');
  assert.equal(statusText('truncated', false, false), 'Connection dropped, partial output kept');
  assert.equal(statusText('content_filter', false, false), 'Finished (content_filter)');
  assert.equal(statusText(null, false, false), '');
});

test('formatPercent', () => {
  assert.equal(formatPercent(0.6), '60%');
  assert.equal(formatPercent(0.05), '5.0%');
  assert.equal(formatPercent(0.0004), '<0.1%');
  assert.equal(formatPercent(0), '0%');
  assert.equal(formatPercent(NaN), '0%');
  assert.equal(formatPercent(1), '100%');
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

test('tokenBand uses the token\'s own probability and falls back to unknown', () => {
  assert.equal(tokenBand({ logprob: -0.1 }), 'high');
  assert.equal(tokenBand({ logprob: Math.log(0.4) }), 'mid');
  assert.equal(tokenBand({ logprob: Math.log(0.1) }), 'low');
  assert.equal(tokenBand({ logprob: null }), 'unknown');
  assert.equal(tokenBand({}), 'unknown');
});

test('noProbsMessage names the model', () => {
  assert.equal(noProbsMessage(getModel('anthropic/claude-haiku-4.5')), 'Claude Haiku 4.5 (2025) does not share its probabilities. You can still watch it write.');
});
