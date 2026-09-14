import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { arcPath, normalizeRow, arcHeight, wordAt, highlightCaption, highlightLabel, loadAttention, ARC_H } from '../site/chapters/attention.js';

const data = JSON.parse(await readFile(new URL('../site/data/attention.json', import.meta.url), 'utf8'));

test('arcPath is a quadratic curve starting with M on the baseline and bulging up', () => {
  const d = arcPath(10, 110, 100, 40);
  assert.match(d, /^M /);
  assert.equal(d, 'M 10 100 Q 60 60 110 100');
  assert.match(arcPath(0.333, 1.666, 99.99, 1), /^M 0\.3 100 Q 1 99 1\.7 100$/);
});
test('normalizeRow scales the max to 1 and leaves all-zero rows as zeros', () => {
  assert.deepEqual(normalizeRow([0.2, 0.8, 0.4]), [0.25, 1, 0.5]);
  assert.deepEqual(normalizeRow([0, 0, 0]), [0, 0, 0]);
  assert.deepEqual(normalizeRow([]), []);
  assert.ok(normalizeRow([0, 0]).every(Number.isFinite));
});
test('arcHeight grows with distance and is capped inside the SVG', () => {
  assert.ok(arcHeight(0, 10) < arcHeight(0, 200));
  assert.ok(arcHeight(0, 5000) <= ARC_H - 8);
});
test('wordAt joins the pieces of a split word and trims the leading space', () => {
  const t1 = data.sentences[0].tokens, t2 = data.sentences[1].tokens;
  assert.equal(wordAt(t1, 10), 'dizzy');
  assert.equal(wordAt(t1, 11), 'dizzy');
  assert.equal(wordAt(t1, 5), 'medication');
  assert.equal(wordAt(t1, 0), 'The');
  assert.equal(wordAt(t1, 12), '.');
  assert.equal(wordAt(t2, 2), 'pharmacist');
  assert.equal(wordAt(t2, 3), 'pharmacist');
});
test('highlightCaption reads from the data and bolds both words', () => {
  const s = data.sentences[0], h = s.highlights[0];
  const segs = highlightCaption(s, h, data.layers * data.heads);
  assert.equal(segs.map(x => x.text).join(''), "In one of GPT-2's 144 attention heads (layer 7, head 8), it puts 70% of its attention on medication.");
  assert.deepEqual(segs.filter(x => x.strong).map(x => x.text), ['it', 'medication']);
  assert.equal(highlightLabel(s, h), 'it → medication');
  assert.equal(highlightLabel(data.sentences[1], data.sentences[1].highlights[0]), 'she → mother');
});
test('shipped data is consistent: rows cover every token, weight equals row[to], to precedes from', () => {
  for (const s of data.sentences) for (const h of s.highlights) {
    assert.equal(h.row.length, s.tokens.length);
    assert.ok(h.to < h.from);
    assert.equal(h.row[h.to], h.weight);
  }
});
test('loadAttention forgets a failed fetch so Retry can succeed, then caches', async () => {
  let calls = 0;
  await assert.rejects(loadAttention({ fetcher: async () => { calls++; return new Response('x', { status: 404 }); } }), /HTTP 404/);
  const ok = async () => { calls++; return new Response(JSON.stringify(data), { status: 200 }); };
  const a = await loadAttention({ fetcher: ok }); const b = await loadAttention({ fetcher: ok });
  assert.equal(a, b); assert.equal(calls, 2);
});
