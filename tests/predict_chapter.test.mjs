/** Drives the mounted chapter with the fake DOM and a scripted `fetch`, so the run → bars → roll → keep going → fork → error flow is checked without a browser. */
import { test, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { installFakeDom } from './helpers/fake-dom.mjs';
import { createStore } from '../site/store.js';
import { mount, HEADING } from '../site/chapters/predict.js';
import { closePopover } from '../site/popover.js';

const sse = (events) => new Response(events.map(e => `data: ${JSON.stringify(e)}\n\n`).join(''), { status: 200, headers: { 'content-type': 'text/event-stream' } });
const tok = (text, logprob, top) => ({ type: 'token', text, logprob, top });
const done = (finish = 'stop') => ({ type: 'done', usage: { prompt: 5, completion: 1 }, cost: 0.0001, finish });
const TOP = [{ text: ' CT', logprob: Math.log(0.6) }, { text: ' MRI', logprob: Math.log(0.3) }, { text: ' X', logprob: Math.log(0.05) }];
const settle = async () => { for (let i = 0; i < 12; i++) await new Promise(r => setTimeout(r, 0)); };

let dom, calls, responses, realFetch, realRandom;
beforeEach(() => {
  dom = installFakeDom();
  calls = []; responses = [];
  realFetch = globalThis.fetch; realRandom = Math.random;
  globalThis.fetch = async (url, init) => {
    calls.push({ url, body: JSON.parse(init.body) });
    const next = responses.shift();
    if (!next) throw new Error('test: no scripted response left');
    return typeof next === 'function' ? next() : next;
  };
});
afterEach(() => { closePopover(); globalThis.fetch = realFetch; Math.random = realRandom; dom.restore(); });

function mountChapter(modelId = 'openai/gpt-4o-mini') {
  const viz = dom.document.createElement('div'); viz.className = 'viz';
  const root = dom.document.createElement('section'); root.append(viz);
  dom.document.body.append(root);
  const store = createStore({ prompt: 'The patient presented with', modelId, system: '', runId: 0, results: {} });
  mount(root, store);
  const q = (sel) => viz.querySelector(sel);
  const button = (text) => viz.querySelectorAll('button').find(b => b.textContent.trim() === text);
  return { viz, store, q, button };
}

test('idle until Run; the first call draws raw bars and publishes usage for the tokens chapter', async () => {
  const { viz, store, q } = mountChapter();
  assert.equal(calls.length, 0);
  assert.equal(q('.predict').hidden, true);
  assert.match(q('.placeholder').textContent, /Run it/);

  responses.push(sse([tok(' CT', TOP[0].logprob, TOP), done()]));
  store.set({ runId: 1 });
  await settle();

  assert.equal(calls.length, 1);
  assert.deepEqual(calls[0].body, { model: 'openai/gpt-4o-mini', prompt: 'The patient presented with', system: '', prefix: '', maxTokens: 1, temperature: 0, topLogprobs: 10, stream: true });
  assert.equal(q('.predict').hidden, false);
  assert.equal(q('.panel-title').textContent, HEADING);
  const rows = viz.querySelectorAll('.bars:not(.mini-bars) .bar-row');
  assert.equal(rows.length, 4, 'three candidates plus everything else');
  assert.equal(rows[0].querySelector('.bar-fill').style.width, '60.00%');
  assert.equal(rows[0].querySelector('.bar-pct').textContent, '60%');
  assert.ok(rows[3].classList.contains('bar-other'));
  assert.equal(rows[3].querySelector('.bar-pct').textContent, '5.0%');
  assert.match(q('.caption.small').textContent, /^Raw probabilities/);
  assert.deepEqual(store.get().results.predict, { runId: 1, usage: { prompt: 5, completion: 1 }, cost: 0.0001, model: 'openai/gpt-4o-mini' });
  assert.equal(q('input[type=range]').disabled, false);
  assert.equal(q('.out-prompt').textContent, 'The patient presented with');
  assert.equal(q('.out-line').classList.contains('is-completion'), false);
});

test('slider rescales, roll picks and starts the output, keep going streams with the picked prefix, fork truncates and continues', async () => {
  const { viz, store, q, button } = mountChapter();
  responses.push(sse([tok(' CT', TOP[0].logprob, TOP), done()]));
  store.set({ runId: 1 });
  await settle();

  const slider = q('input[type=range]');
  slider.value = '1.0';
  slider.dispatch('input');
  assert.equal(q('.caption.small').textContent, 'Rescaled at temperature 1.0. Usually the favorite, sometimes a surprise.');
  const rows = viz.querySelectorAll('.bars:not(.mini-bars) .bar-row');
  assert.equal(rows[3].hidden, true, 'no remainder row once rescaled');
  assert.equal(rows[0].querySelector('.bar-pct').textContent, '63%');

  Math.random = () => 0.7; // lands on the second candidate at T=1 (0.63 + 0.32)
  button('🎲 Roll the dice').dispatch('click');
  await settle();
  assert.equal(rows[1].classList.contains('is-picked'), true);
  assert.equal(rows[0].classList.contains('is-picked'), false);
  let chips = viz.querySelectorAll('.out-chips .chip');
  assert.equal(chips.length, 1);
  assert.equal(chips[0].textContent, '␣MRI');
  assert.ok(chips[0].classList.contains('band-mid'), 'band from the raw model probability (30%)');
  assert.ok(chips[0].classList.contains('can-fork'));
  assert.equal(chips[0].attributes.role, 'button');
  assert.equal(viz.querySelectorAll('.mini-bars .bar-row').length, 3, 'the side panel shows the alternatives');

  const stepTop = [{ text: ' scan', logprob: -0.05 }, { text: ' of', logprob: -3.2 }];
  responses.push(sse([tok(' scan', -0.05, stepTop), tok(' showed', -2.0, null), done('length')]));
  button('Keep going').dispatch('click');
  assert.equal(q('.out-block .status').textContent, 'Writing…');
  assert.equal(button('Pause').disabled, false);
  assert.equal(button('Keep going').disabled, true, 'Keep going is disabled while writing');
  assert.equal(button('Step').disabled, true);
  assert.equal(button('🎲 Roll the dice').disabled, true);
  await settle();
  assert.equal(calls.length, 2);
  assert.equal(calls[1].body.prefix, ' MRI');
  assert.equal(calls[1].body.maxTokens, 120);
  assert.equal(calls[1].body.topLogprobs, 5);
  assert.equal(calls[1].body.temperature, 1);
  chips = viz.querySelectorAll('.out-chips .chip');
  assert.deepEqual(chips.map(c => c.textContent), ['␣MRI', '␣scan', '␣showed']);
  assert.ok(chips[1].classList.contains('band-high'));
  assert.ok(chips[2].classList.contains('band-low'));
  assert.equal(chips[2].classList.contains('can-fork'), false, 'no alternatives, so not forkable');
  assert.equal(q('.out-block .status').textContent, 'Cut off at the token limit');
  assert.equal(viz.querySelectorAll('.mini-bars .bar-row').length, 0);
  assert.match(q('.considered p').textContent, /does not share what else it considered/);

  chips[1].dispatch('click');
  const pop = dom.document.body.querySelector('.popover');
  assert.ok(pop, 'the fork popover opened');
  const alts = pop.querySelectorAll('.fork-alt');
  assert.deepEqual(alts.map(a => a.querySelector('.fork-label').textContent), ['␣scan', '␣of']);
  assert.equal(alts[0].attributes['aria-current'], 'true');
  responses.push(sse([tok(' the', -0.3, [{ text: ' the', logprob: -0.3 }]), done()]));
  alts[1].dispatch('click');
  await settle();
  assert.equal(dom.document.body.querySelector('.popover'), null);
  assert.equal(calls[2].body.prefix, ' MRI of');
  chips = viz.querySelectorAll('.out-chips .chip');
  assert.deepEqual(chips.map(c => c.textContent), ['␣MRI', 'forked here', '␣of', '␣the']);
  assert.ok(chips[1].classList.contains('fork-marker'));
  assert.ok(chips[2].classList.contains('band-unknown'), 'a forked-in token has no logprob of its own');
  assert.equal(q('.out-block .status').textContent, 'Finished (stop)');

  const toggle = q('input[type=checkbox]');
  toggle.checked = false; toggle.dispatch('change');
  assert.ok(q('.out-line').classList.contains('confidence-off'));
});

test('pause aborts and keeps tokens; resume continues from the current text', async () => {
  const { viz, store, q, button } = mountChapter();
  responses.push(sse([tok(' CT', TOP[0].logprob, TOP), done()]));
  store.set({ runId: 1 });
  await settle();
  // A stream that never ends on its own: one token, then hangs until aborted.
  responses.push(() => new Response(new ReadableStream({
    start(c) { c.enqueue(new TextEncoder().encode(`data: ${JSON.stringify(tok(' a', -0.1, [{ text: ' a', logprob: -0.1 }]))}\n\n`)); },
  }), { status: 200 }));
  button('Keep going').dispatch('click');
  await settle();
  assert.equal(viz.querySelectorAll('.out-chips .chip').length, 1);
  button('Pause').dispatch('click');
  await settle();
  assert.equal(q('.out-block .status').textContent, 'Paused');
  assert.equal(viz.querySelectorAll('.out-chips .chip').length, 1, 'tokens are kept');
  assert.ok(button('Resume'));
  responses.push(sse([tok(' b', -0.2, null), done()]));
  button('Resume').dispatch('click');
  await settle();
  assert.equal(calls[2].body.prefix, ' a');
  assert.deepEqual(viz.querySelectorAll('.out-chips .chip').map(c => c.textContent), ['␣a', '␣b']);
  assert.equal(q('.out-block .status').textContent, 'Finished (stop)');
});

test('HTTP and stream errors show a notice whose Retry re-issues the last action; a new run ignores stale results', async (t) => {
  t.mock.method(console, 'error', () => {}); // the chapter logs each failed request; both failures here are scripted
  const { viz, store, q, button } = mountChapter();
  responses.push(new Response(JSON.stringify({ message: 'The class budget for today is used up.' }), { status: 429 }));
  store.set({ runId: 1 });
  await settle();
  assert.equal(q('.error-slot .notice').children[0].textContent, 'The class budget for today is used up.');
  assert.equal(viz.querySelectorAll('.bars:not(.mini-bars) .bar-row').length, 0);
  responses.push(sse([tok(' CT', TOP[0].logprob, TOP), done()]));
  q('.error-slot .notice button').dispatch('click');
  await settle();
  assert.equal(q('.error-slot').children.length, 0);
  assert.equal(viz.querySelectorAll('.bars:not(.mini-bars) .bar-row').length, 4);

  responses.push(sse([tok(' a', -0.1, null), { type: 'error', message: 'The model returned an error.' }]));
  button('Step').dispatch('click');
  await settle();
  assert.equal(calls[2].body.maxTokens, 1);
  assert.equal(viz.querySelectorAll('.out-chips .chip').length, 1, 'tokens before the stream error are kept');
  assert.equal(q('.error-slot .notice').children[0].textContent, 'The model returned an error.');

  // A slow first call for run 2 that finishes after run 3 has started must not draw anything.
  let release;
  responses.push(() => new Promise(r => { release = () => r(sse([tok(' late', -0.1, [{ text: ' late', logprob: -0.1 }]), done()])); }));
  store.set({ runId: 2 });
  await settle();
  responses.push(sse([tok(' CT', TOP[0].logprob, TOP), done()]));
  store.set({ runId: 3 });
  await settle();
  release();
  await settle();
  assert.equal(store.get().results.predict.runId, 3);
  assert.equal(viz.querySelectorAll('.bars:not(.mini-bars) .bar-row').length, 4);
  assert.equal(viz.querySelectorAll('.bars:not(.mini-bars) .bar-row')[0].querySelector('.bar-label').textContent, '␣CT');
});

test('a model without probabilities skips the first call, shows the card, disables slider/roll/toggle, and still writes', async () => {
  const { viz, store, q, button } = mountChapter('anthropic/claude-haiku-4.5');
  store.set({ runId: 1 });
  await settle();
  assert.equal(calls.length, 0);
  assert.equal(q('.nolog-card').hidden, false);
  assert.equal(q('.nolog-card').textContent, 'Claude Haiku 4.5 (2025) does not share its probabilities. You can still watch it write.');
  assert.equal(q('.bars').hidden, true);
  assert.equal(q('input[type=range]').disabled, true);
  assert.equal(button('🎲 Roll the dice').disabled, true);
  assert.match(button('🎲 Roll the dice').title, /does not share its probabilities/);
  assert.equal(q('input[type=checkbox]').disabled, true);
  assert.equal(button('Keep going').disabled, false);
  responses.push(sse([tok(' Sure', null, null), tok(',', null, null), done()]));
  button('Keep going').dispatch('click');
  await settle();
  assert.equal(calls[0].body.prefix, '');
  const chips = viz.querySelectorAll('.out-chips .chip');
  assert.deepEqual(chips.map(c => c.textContent), ['␣Sure', ',']);
  assert.ok(chips.every(c => c.classList.contains('band-unknown') && !c.classList.contains('can-fork')));
  assert.equal(store.get().results.predict.runId, 1, 'usage is published from the first empty-prefix call');
});

test('a completion model renders prompt and output as one line with the note', async () => {
  const { store, q } = mountChapter('openai/gpt-3.5-turbo-instruct');
  responses.push(sse([tok(' CT', TOP[0].logprob, TOP), done()]));
  store.set({ runId: 1 });
  await settle();
  assert.ok(q('.out-line').classList.contains('is-completion'));
  assert.equal(q('.out-block p.muted.small:not(.status)').hidden, false);
  assert.equal(q('.out-block p.muted.small:not(.status)').textContent, 'This model just continues the text.');
});
