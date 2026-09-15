import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { installFakeDom } from './helpers/fake-dom.mjs';
import { mountViz } from './helpers/mount-viz.mjs';
import { waitFor } from './helpers/wait-for.mjs';
import { createStore } from '../site/store.js';
import { mount, promptWords, project, matchWords, mapStatus, neighborLabel, loadEmbeddings, GROUPS, VIEW, LOADING_NOTE } from '../site/chapters/numbers.js';

test('promptWords: lowercase, punctuation stripped, possessive dropped, unique, in order', () => {
  assert.deepEqual(promptWords("My grandmother's favorite recipe was"), ['my', 'grandmother', 'favorite', 'recipe', 'was']);
  assert.deepEqual(promptWords('The patient presented with chest pain and the patient...'), ['the', 'patient', 'presented', 'with', 'chest', 'pain', 'and']);
  assert.deepEqual(promptWords('Warfarin, heparin; WARFARIN!'), ['warfarin', 'heparin']);
  assert.deepEqual(promptWords(''), []);
  assert.deepEqual(promptWords(undefined), []);
});
test('project maps [-1,1] into the padded viewBox with y pointing up', () => {
  assert.deepEqual(project(-1, -1), { cx: VIEW.pad, cy: VIEW.h - VIEW.pad });
  assert.deepEqual(project(1, 1), { cx: VIEW.w - VIEW.pad, cy: VIEW.pad });
  assert.deepEqual(project(0, 0), { cx: VIEW.w / 2, cy: VIEW.h / 2 });
});
test('matchWords keeps only vocabulary words, in prompt order', () => {
  assert.deepEqual(matchWords(['the', 'warfarin', 'zzz', 'kidney'], new Set(['warfarin', 'kidney'])), ['warfarin', 'kidney']);
  assert.deepEqual(matchWords(['a'], ['b']), []);
});
test('mapStatus wording', () => {
  assert.equal(mapStatus([]), 'None of your words are on this small map; hover around anyway.');
  assert.equal(mapStatus(['warfarin']), '1 of your words is on the map: warfarin.');
  assert.equal(mapStatus(['warfarin', 'kidney']), '2 of your words are on the map: warfarin, kidney.');
});
test('neighborLabel reads as a sentence for screen readers', () => {
  assert.equal(neighborLabel('warfarin', 'drug', [{ w: 'heparin', s: 0.519 }, { w: 'medication', s: 0.465 }]), 'warfarin (drug). Nearest: heparin 0.52, medication 0.47.');
  assert.equal(neighborLabel('x', 'g', []), 'x (g). Nearest: none listed.');
});
test('the shipped data uses exactly the groups the legend knows about', async () => {
  const data = JSON.parse(await readFile(new URL('../site/data/embeddings.json', import.meta.url), 'utf8'));
  const groups = [...new Set(data.words.map(w => w.g))];
  assert.deepEqual(groups.sort(), [...GROUPS].sort());
  assert.ok(data.words.every(w => w.x >= -1 && w.x <= 1 && w.y >= -1 && w.y <= 1));
  assert.ok(data.neighbors.warfarin.some(n => n.w === 'heparin'));
});
test('loadEmbeddings caches a success and forgets a failure so a retry can succeed', async () => {
  let calls = 0;
  const failing = async () => { calls++; return new Response('nope', { status: 500 }); };
  await assert.rejects(loadEmbeddings({ fetcher: failing }), /HTTP 500/);
  const ok = async () => { calls++; return new Response(JSON.stringify({ words: [], neighbors: {} }), { status: 200 }); };
  const a = await loadEmbeddings({ fetcher: ok });
  const b = await loadEmbeddings({ fetcher: ok });
  assert.equal(a, b);
  assert.equal(calls, 2);
});

test('mount shows a map-sized skeleton and "Loading map…" until the data lands, then the map replaces them', async () => {
  const dom = installFakeDom();
  const realFetch = globalThis.fetch;
  globalThis.fetch = async () => new Response(JSON.stringify({ words: [{ w: 'warfarin', g: 'drug', x: 0.1, y: 0.2 }], neighbors: {} }), { status: 200 });
  try {
    const { root, viz, q } = mountViz(dom);
    mount(root, createStore({ prompt: '', modelId: 'openai/gpt-4o-mini', system: '', runId: 0, results: {} }));
    assert.ok(q('.map-skeleton'), 'a skeleton holds the map\'s footprint while loading');
    assert.equal(q('.map-skeleton').attributes['aria-hidden'], 'true');
    assert.equal(q('[role=status]').textContent, LOADING_NOTE);
    await waitFor(() => viz.querySelector('svg')); // tag, not .map: the fake DOM matches classes on className, and svg() sets class as an attribute
    assert.equal(q('.map-skeleton'), null);
    assert.notEqual(q('[role=status]').textContent, LOADING_NOTE);
  } finally { globalThis.fetch = realFetch; dom.restore(); }
});
