import { test } from 'node:test';
import assert from 'node:assert/strict';
import { tokenize, loadTokenizer } from '../site/tokenize.js';

test('o200k splits a clinical word into visible pieces with ids', async () => {
  const enc = await loadTokenizer('o200k');
  const toks = tokenize(enc, 'The patient has hyponatremia.');
  assert.deepEqual(toks.map(t => t.text), ['The', ' patient', ' has', ' hy', 'pon', 'at', 'rem', 'ia', '.']);
  assert.ok(toks.every(t => Number.isInteger(t.id)));
});
// Runs before the plain cl100k test below on purpose: loadTokenizer caches by name, so this must be the first cl100k load.
test('a failed load is not cached, so a later load of the same name succeeds', async () => {
  await assert.rejects(loadTokenizer('cl100k', { importer: async () => { throw new Error('network down'); } }), /network down/);
  const enc = await loadTokenizer('cl100k');
  assert.equal(typeof enc.encode, 'function');
});
test('cl100k loads and tokenizes too', async () => {
  const enc = await loadTokenizer('cl100k');
  assert.ok(tokenize(enc, 'warfarin').length >= 2);
});
test('unknown tokenizer name rejects', async () => {
  await assert.rejects(loadTokenizer('nope'));
});
test('special-token text is tokenized as ordinary text instead of throwing', async () => {
  const enc = await loadTokenizer('o200k');
  const toks = tokenize(enc, '<|endoftext|>');
  assert.ok(toks.length > 1);
  assert.equal(toks.map(t => t.text).join(''), '<|endoftext|>');
});
test('per-token decode is stateless: partial multi-byte tokens show as U+FFFD and repeat calls agree', async () => {
  const enc = await loadTokenizer('o200k');
  const text = '🩺 a';
  const first = tokenize(enc, text);
  const second = tokenize(enc, text);
  assert.deepEqual(first, second);
  assert.ok(first.every(t => t.text.length > 0), 'no token renders as empty text');
  const partial = first.filter(t => t.text === '�');
  assert.ok(partial.length >= 1, 'the emoji splits into byte pieces that cannot decode alone');
  assert.equal(first.map(t => t.text).filter(t => t !== '�').join(''), ' a');
  assert.equal(enc.decode(first.map(t => t.id)), text, 'the ids still reconstruct the text as a whole');
  // A lone partial token decodes to U+FFFD on its own, not to leftover state from a previous call.
  assert.deepEqual(tokenize(enc, text.slice(0, 2)).slice(0, 1).map(t => t.text), ['�']);
});
