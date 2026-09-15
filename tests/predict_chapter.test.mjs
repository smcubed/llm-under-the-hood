/** Drives the mounted chapter with the fake DOM and a scripted `fetch`, so the run → bars → roll → keep going → fork → error flow is checked without a browser. */
import { test, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { installFakeDom } from './helpers/fake-dom.mjs';
import { waitFor } from './helpers/wait-for.mjs';
import { sse, tok, doneEvent, hanging, installScriptedFetch } from './helpers/scripted-fetch.mjs';
import { mountViz } from './helpers/mount-viz.mjs';
import { createStore } from '../site/store.js';
import { mount, HEADING } from '../site/chapters/predict.js';
import { closePopover } from '../site/popover.js';

const done = (finish) => doneEvent(finish, { usage: { prompt: 5, completion: 1 }, cost: 0.0001 });
const TOP = [{ text: ' CT', logprob: Math.log(0.6) }, { text: ' MRI', logprob: Math.log(0.3) }, { text: ' X', logprob: Math.log(0.05) }];
const tick = () => new Promise(r => setTimeout(r, 0));

let dom, fetchStub, calls, script, realRandom;
beforeEach(() => {
  dom = installFakeDom();
  fetchStub = installScriptedFetch();
  ({ calls, script } = fetchStub);
  realRandom = Math.random;
});
afterEach(() => { closePopover(); fetchStub.restore(); Math.random = realRandom; dom.restore(); });

function mountChapter(modelId = 'openai/gpt-4o-mini') {
  const { root, viz, q, button } = mountViz(dom);
  const store = createStore({ prompt: 'The patient presented with', modelId, system: '', runId: 0, results: {} });
  mount(root, store);
  const bigBars = () => viz.querySelectorAll('.bars:not(.mini-bars) .bar-row');
  const chips = () => viz.querySelectorAll('.out-chips .chip');
  const outStatus = () => q('.out-block .status').textContent;
  return { viz, store, q, button, bigBars, chips, outStatus };
}

test('idle until Run; the first call draws raw bars and publishes usage for the tokens chapter', async () => {
  const { viz, store, q, bigBars } = mountChapter();
  assert.equal(calls.length, 0);
  assert.equal(q('.predict').hidden, true);
  assert.match(q('.placeholder').textContent, /Run it/);

  script(sse([tok(' CT', TOP[0].logprob, TOP), done()]));
  store.set({ runId: 1 });
  assert.equal(q('.predict .status').textContent, 'Asking the model for its guesses…');
  await waitFor(() => bigBars().length === 4);

  assert.equal(calls.length, 1);
  assert.deepEqual(calls[0].body, { model: 'openai/gpt-4o-mini', prompt: 'The patient presented with', system: '', prefix: '', maxTokens: 1, temperature: 0, topLogprobs: 10, stream: true });
  assert.equal(q('.predict').hidden, false);
  assert.equal(q('.panel-title').textContent, HEADING);
  assert.equal(q('.predict .status').textContent, '', 'the live status is emptied, not hidden');
  assert.equal(q('.predict .status').hidden, false);
  const rows = bigBars();
  assert.equal(rows[0].querySelector('.bar-fill').style.width, '60.00%');
  assert.equal(rows[0].querySelector('.bar-pct').textContent, '60%');
  assert.ok(rows[3].classList.contains('bar-other'));
  assert.equal(rows[3].querySelector('.bar-pct').textContent, '5.0%');
  assert.match(q('.caption.small').textContent, /^Raw probabilities/);
  assert.deepEqual(store.get().results.predict, { runId: 1, usage: { prompt: 5, completion: 1 }, cost: 0.0001, model: 'openai/gpt-4o-mini' });
  assert.equal(q('input[type=range]').disabled, false);
  assert.equal(q('.out-prompt').textContent, 'The patient presented with');
  assert.equal(q('.out-line').classList.contains('is-completion'), false);
  assert.equal(viz.querySelectorAll('.out-chips .chip').length, 0);
  assert.doesNotMatch(q('.out-pane').textContent, /null|undefined/, 'a pane without a footer renders no stray text');
});

test('slider rescales, roll picks and starts the output, keep going streams with the picked prefix, fork truncates and continues', async () => {
  const { viz, store, q, button, bigBars, chips, outStatus } = mountChapter();
  script(sse([tok(' CT', TOP[0].logprob, TOP), done()]));
  store.set({ runId: 1 });
  await waitFor(() => bigBars().length === 4);

  const slider = q('input[type=range]');
  slider.value = '1.0';
  slider.dispatch('input');
  assert.equal(q('.caption.small').textContent, 'Rescaled at temperature 1.0. Usually the favorite, sometimes a surprise.');
  const rows = bigBars();
  assert.equal(rows[3].hidden, true, 'no remainder row once rescaled');
  assert.equal(rows[0].querySelector('.bar-pct').textContent, '63%');

  Math.random = () => 0.7; // lands on the second candidate at T=1 (0.63 + 0.32)
  button('🎲 Roll the dice').dispatch('click');
  assert.equal(rows[1].classList.contains('is-picked'), true);
  assert.equal(rows[0].classList.contains('is-picked'), false);
  assert.equal(chips().length, 1);
  assert.equal(chips()[0].textContent, '␣MRI');
  assert.ok(chips()[0].classList.contains('band-mid'), 'band from the raw model probability (30%)');
  assert.ok(chips()[0].classList.contains('can-fork'));
  assert.equal(chips()[0].attributes.role, 'button');
  assert.equal(viz.querySelectorAll('.mini-bars .bar-row').length, 3, 'the side panel shows the alternatives');

  const stepTop = [{ text: ' scan', logprob: -0.05 }, { text: ' of', logprob: -3.2 }];
  script(sse([tok(' scan', -0.05, stepTop), tok(' showed', -2.0, null), done('length')]));
  button('Keep going').dispatch('click');
  assert.equal(outStatus(), 'Writing…');
  assert.equal(button('Pause').disabled, false);
  assert.equal(button('Keep going').disabled, true, 'Keep going is disabled while writing');
  assert.equal(button('Step').disabled, true);
  assert.equal(button('🎲 Roll the dice').disabled, true);
  await waitFor(() => outStatus() === 'Cut off at the token limit' && chips().length === 3);
  assert.equal(calls.length, 2);
  assert.equal(calls[1].body.prefix, ' MRI');
  assert.equal(calls[1].body.maxTokens, 120);
  assert.equal(calls[1].body.topLogprobs, 5);
  assert.equal(calls[1].body.temperature, 1);
  let c = chips();
  assert.deepEqual(c.map(x => x.textContent), ['␣MRI', '␣scan', '␣showed']);
  assert.ok(c[1].classList.contains('band-high'));
  assert.ok(c[2].classList.contains('band-low'));
  assert.equal(c[2].classList.contains('can-fork'), false, 'no alternatives, so not forkable');
  assert.equal(viz.querySelectorAll('.mini-bars .bar-row').length, 0);
  assert.match(q('.considered p').textContent, /does not share what else it considered/);
  assert.equal(button('Pause').disabled, true);

  c[1].dispatch('click');
  const pop = dom.document.body.querySelector('.popover');
  assert.ok(pop, 'the fork popover opened');
  const alts = pop.querySelectorAll('.fork-alt');
  assert.deepEqual(alts.map(a => a.querySelector('.fork-label').textContent), ['␣scan', '␣of']);
  assert.equal(alts[0].attributes['aria-current'], 'true');
  assert.equal(alts[0].tagName, 'button');
  script(sse([tok(' the', -0.3, [{ text: ' the', logprob: -0.3 }]), done()]));
  alts[1].dispatch('click');
  assert.equal(dom.document.body.querySelector('.popover'), null);
  await waitFor(() => outStatus() === 'Finished (stop)' && chips().length === 3);
  assert.equal(calls[2].body.prefix, ' MRI of');
  c = chips();
  assert.deepEqual(c.map(x => x.textContent), ['␣MRI', '␣of', '␣the']);
  const marker = q('.out-chips .fork-marker');
  assert.equal(marker.textContent, 'forked here');
  assert.equal(marker.classList.contains('chip'), false, 'the marker is a plain note, not a numbered chip');
  assert.equal(marker.parentNode.children.indexOf(marker), 1, 'it sits between the kept token and the fork');
  assert.ok(c[1].classList.contains('band-unknown'), 'a forked-in token has no logprob of its own');

  const toggle = q('input[type=checkbox]');
  toggle.checked = false; toggle.dispatch('change');
  assert.ok(q('.out-line').classList.contains('confidence-off'));
});

test('pause aborts and keeps tokens; resume continues from the current text', async () => {
  const { store, button, bigBars, chips, outStatus } = mountChapter();
  script(sse([tok(' CT', TOP[0].logprob, TOP), done()]));
  store.set({ runId: 1 });
  await waitFor(() => bigBars().length === 4);
  script(hanging([tok(' a', -0.1, [{ text: ' a', logprob: -0.1 }])]));
  button('Keep going').dispatch('click');
  await waitFor(() => chips().length === 1);
  button('Pause').dispatch('click');
  assert.equal(outStatus(), 'Paused');
  assert.equal(chips().length, 1, 'tokens are kept');
  assert.ok(button('Resume'));
  assert.equal(button('Pause').disabled, true);
  script(sse([tok(' b', -0.2, null), done()]));
  button('Resume').dispatch('click');
  await waitFor(() => outStatus() === 'Finished (stop)');
  assert.equal(calls[2].body.prefix, ' a');
  assert.deepEqual(chips().map(c => c.textContent), ['␣a', '␣b']);
});

test('two Keep going clicks during a stream issue one request; roll while paused closes the popover and clears the error notice', async (t) => {
  t.mock.method(console, 'error', () => {});
  const { store, button, bigBars, chips, q } = mountChapter();
  script(sse([tok(' CT', TOP[0].logprob, TOP), done()]));
  store.set({ runId: 1 });
  await waitFor(() => bigBars().length === 4);
  script(hanging([tok(' a', -0.1, [{ text: ' a', logprob: -0.1 }])]));
  button('Keep going').dispatch('click');
  button('Keep going').dispatch('click');
  await waitFor(() => chips().length === 1);
  assert.equal(calls.length, 2, 'the second click landed on a disabled button');
  button('Pause').dispatch('click');

  // A failed step leaves a notice; opening a fork popover then rolling the dice clears both.
  script(sse([{ type: 'error', message: 'Provider hiccup.' }]));
  button('Step').dispatch('click');
  await waitFor(() => q('.error-slot .notice'));
  chips()[0].dispatch('click');
  assert.ok(dom.document.body.querySelector('.popover'));
  Math.random = () => 0;
  button('🎲 Roll the dice').dispatch('click');
  assert.equal(dom.document.body.querySelector('.popover'), null);
  assert.equal(q('.error-slot .notice'), null);
  assert.deepEqual(chips().map(c => c.textContent), ['␣CT']);
  assert.equal(calls.length, 3);
});

test('HTTP and stream errors show a notice whose Retry re-issues the last action; a new run ignores stale results', async (t) => {
  t.mock.method(console, 'error', () => {}); // the chapter logs each failed request; both failures here are scripted
  const { viz, store, q, button, bigBars, chips } = mountChapter();
  script(new Response(JSON.stringify({ message: 'The class budget for today is used up.' }), { status: 429 }));
  store.set({ runId: 1 });
  await waitFor(() => q('.error-slot .notice'));
  assert.equal(q('.error-slot .notice').children[0].textContent, 'The class budget for today is used up.');
  assert.equal(bigBars().length, 0);
  assert.equal(button('Keep going').disabled, true, 'nothing to continue until the first call succeeds');
  script(sse([tok(' CT', TOP[0].logprob, TOP), done()]));
  q('.error-slot .notice button').dispatch('click');
  await waitFor(() => bigBars().length === 4);
  assert.equal(q('.error-slot').children.length, 0);
  assert.equal(calls[1].body.maxTokens, 1, 'Retry re-issues the first call');

  script(sse([tok(' a', -0.1, null), { type: 'error', message: 'The model returned an error.' }]));
  button('Step').dispatch('click');
  await waitFor(() => q('.error-slot .notice'));
  assert.equal(calls[2].body.maxTokens, 1);
  assert.equal(chips().length, 1, 'tokens before the stream error are kept');
  assert.equal(q('.error-slot .notice').children[0].textContent, 'The model returned an error.');

  // A slow first call for run 2 that finishes after run 3 has started must not draw anything.
  let release;
  script(() => new Promise(r => { release = () => r(sse([tok(' late', -0.1, [{ text: ' late', logprob: -0.1 }]), done()])); }));
  store.set({ runId: 2 });
  await waitFor(() => calls.length === 4);
  assert.equal(viz.querySelectorAll('.out-chips .chip').length, 0, 'the new run cleared the output');
  script(sse([tok(' CT', TOP[0].logprob, TOP), done()]));
  store.set({ runId: 3 });
  await waitFor(() => bigBars().length === 4 && store.get().results.predict?.runId === 3);
  release();
  await tick();
  await tick();
  assert.equal(store.get().results.predict.runId, 3);
  assert.equal(bigBars().length, 4);
  assert.equal(bigBars()[0].querySelector('.bar-label').textContent, '␣CT');
});

test('a model without probabilities still makes the one-token call (publishing usage), shows the card, disables slider/roll/toggle, and writes; the card clears on the next run', async () => {
  const { store, q, button, chips } = mountChapter('anthropic/claude-haiku-4.5');
  script(sse([tok(' Sure', null, null), done()]));
  store.set({ runId: 1 });
  await waitFor(() => q('.nolog-card').hidden === false);
  assert.equal(calls.length, 1);
  assert.equal(calls[0].body.maxTokens, 1);
  assert.equal(q('.nolog-card').textContent, 'Haiku 4.5 does not share its probabilities. You can still watch it write.');
  assert.equal(q('.bars').hidden, true);
  assert.equal(q('input[type=range]').disabled, true);
  assert.equal(button('🎲 Roll the dice').disabled, true);
  assert.match(button('🎲 Roll the dice').title, /does not share its probabilities/);
  assert.equal(q('input[type=checkbox]').disabled, true);
  assert.equal(button('Keep going').disabled, false);
  assert.deepEqual(store.get().results.predict, { runId: 1, usage: { prompt: 5, completion: 1 }, cost: 0.0001, model: 'anthropic/claude-haiku-4.5' }, 'usage is published from the first call even without probabilities');
  assert.equal(chips().length, 0, 'the probe token is not shown as output');
  script(sse([tok(' Sure', null, null), tok(',', null, null), done()]));
  button('Keep going').dispatch('click');
  await waitFor(() => chips().length === 2);
  assert.equal(calls[1].body.prefix, '');
  assert.deepEqual(chips().map(c => c.textContent), ['␣Sure', ',']);
  assert.ok(chips().every(c => c.classList.contains('band-unknown') && !c.classList.contains('can-fork')));

  // Switching to a model with probabilities: the stale card goes away and the bars come back.
  store.set({ modelId: 'openai/gpt-4o-mini' });
  script(sse([tok(' CT', TOP[0].logprob, TOP), done()]));
  store.set({ runId: 2 });
  assert.equal(q('.nolog-card').hidden, true, 'the card is hidden as soon as the new run starts');
  await waitFor(() => q('.bars:not(.mini-bars) .bar-row'));
  assert.equal(q('.bars').hidden, false);
  assert.equal(chips().length, 0);
});

test('a completion model renders prompt and output as one line with the note', async () => {
  const { store, q, bigBars } = mountChapter('openai/gpt-3.5-turbo-instruct');
  script(sse([tok(' CT', TOP[0].logprob, TOP), done()]));
  store.set({ runId: 1 });
  await waitFor(() => bigBars().length === 4);
  assert.ok(q('.out-line').classList.contains('is-completion'));
  assert.equal(q('.out-block p.muted.small:not(.status)').hidden, false);
  assert.equal(q('.out-block p.muted.small:not(.status)').textContent, 'This model just continues the text.');
});

test('the dice animation runs by default and is skipped when the student prefers reduced motion', async () => {
  const { store, button, bigBars, q } = mountChapter();
  script(sse([tok(' CT', TOP[0].logprob, TOP), done()]));
  store.set({ runId: 1 });
  await waitFor(() => bigBars().length === 4);
  Math.random = () => 0;
  button('🎲 Roll the dice').dispatch('click');
  assert.ok(q('.die').classList.contains('dice'), 'the keyframes class is (re)applied on a roll');

  dom.window.matchMedia = () => ({ matches: true });
  q('.die').classList.remove('dice');
  button('🎲 Roll the dice').dispatch('click');
  assert.equal(q('.die').classList.contains('dice'), false, 'no animation under prefers-reduced-motion');
});
