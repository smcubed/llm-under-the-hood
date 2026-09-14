import { test } from 'node:test';
import assert from 'node:assert/strict';
import { tokenize, loadTokenizer } from '../site/tokenize.js';

test('o200k splits a clinical word into visible pieces with ids', async () => {
  const enc = await loadTokenizer('o200k');
  const toks = tokenize(enc, 'The patient has hyponatremia.');
  assert.deepEqual(toks.map(t => t.text), ['The', ' patient', ' has', ' hy', 'pon', 'at', 'rem', 'ia', '.']);
  assert.ok(toks.every(t => Number.isInteger(t.id)));
});
test('cl100k loads and tokenizes too', async () => {
  const enc = await loadTokenizer('cl100k');
  assert.ok(tokenize(enc, 'warfarin').length >= 2);
});
test('unknown tokenizer name rejects', async () => {
  await assert.rejects(loadTokenizer('nope'));
});
