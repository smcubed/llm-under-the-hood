/** Chapter 5 with the fake DOM and a scripted fetch: two panes per run, the system prompt control, re-runs, per-pane errors. */
import { test, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { installFakeDom } from './helpers/fake-dom.mjs';
import { waitFor } from './helpers/wait-for.mjs';
import { sse, tok, doneEvent, hanging, installScriptedFetch } from './helpers/scripted-fetch.mjs';
import { mountViz } from './helpers/mount-viz.mjs';
import { createStore } from '../site/store.js';
import { closePopover } from '../site/popover.js';
import { AUTOCOMPLETE_MODEL, DEFAULT_MODEL } from '../site/models.js';
import { mount, pickAssistantModel, firstGuessesText, presetFor, SYSTEM_PRESETS, LEFT_LABEL, LEFT_CAPTION, RIGHT_CAPTION } from '../site/chapters/assistant.js';

test('pickAssistantModel falls back to the default for the instruct model and unknown ids', () => {
  assert.equal(pickAssistantModel('anthropic/claude-haiku-4.5'), 'anthropic/claude-haiku-4.5');
  assert.equal(pickAssistantModel(AUTOCOMPLETE_MODEL), DEFAULT_MODEL);
  assert.equal(pickAssistantModel('nope/x'), DEFAULT_MODEL);
  assert.equal(pickAssistantModel(undefined), DEFAULT_MODEL);
});

test('firstGuessesText lists up to three display labels or says none were shared', () => {
  assert.equal(firstGuessesText([{ text: ' A', logprob: -0.1 }, { text: ' The', logprob: -1 }, { text: '\n', logprob: -2 }, { text: ' Sure', logprob: -3 }]), 'First guesses: ␣A · ␣The · ↵');
  assert.equal(firstGuessesText([{ text: 'Yes', logprob: -0.1 }]), 'First guesses: Yes');
  assert.equal(firstGuessesText(null), 'First guesses: (no alternatives shared)');
  assert.equal(firstGuessesText([]), 'First guesses: (no alternatives shared)');
});

test('presetFor maps a system text back to its chip; the preset texts are the plan\'s', () => {
  assert.equal(presetFor(''), 'none');
  assert.equal(presetFor(undefined), 'none');
  assert.equal(presetFor('You are a nurse educator. Answer at a sixth-grade reading level in two short sentences.'), 'nurse');
  assert.equal(presetFor('You are a terse clinical decision support tool. Bullet points only. No preamble.'), 'terse');
  assert.equal(presetFor('Answer in French.'), 'custom');
  assert.deepEqual(SYSTEM_PRESETS.map(p => p.label), ['None', 'Nurse educator', 'Terse decision support', 'Custom…']);
});

// ---- Integration --------------------------------------------------------------------------------------------------
const done = (finish) => doneEvent(finish, { usage: { prompt: 9, completion: 2 }, cost: 0.00003 });

let dom, fetchStub, calls, script;
beforeEach(() => {
  dom = installFakeDom();
  fetchStub = installScriptedFetch(); // responses are scripted per model id so the two concurrent panes cannot race for the wrong one
  ({ calls, script } = fetchStub);
});
afterEach(() => { closePopover(); fetchStub.restore(); dom.restore(); });

function mountChapter(state = {}) {
  const { root, viz, q, button } = mountViz(dom);
  const store = createStore({ prompt: 'What is the first-line treatment for hypertension?', modelId: 'anthropic/claude-haiku-4.5', system: '', runId: 0, results: {}, ...state });
  mount(root, store);
  const panes = () => viz.querySelectorAll('.pane');
  const chipsIn = (pane) => pane.querySelectorAll('.out-chips .chip').map(c => c.textContent);
  const radio = (key) => viz.querySelector(`input[type=radio][value=${key}]`);
  const forModel = (id) => calls.filter(c => c.body.model === id);
  return { viz, store, q, panes, chipsIn, radio, button, forModel };
}

test('a run streams both panes with the shared parameters, shows captions, first guesses and footers, and publishes the pair', async () => {
  const { store, q, panes, chipsIn, button, forModel } = mountChapter();
  assert.equal(q('.panes').hidden, true);
  assert.match(q('.placeholder').textContent, /Run it/);
  assert.equal(button('Run both again').disabled, true);
  assert.equal(q('input[type=radio][value=none]').checked, true);
  assert.equal(calls.length, 0);

  script(AUTOCOMPLETE_MODEL, sse([tok(' and', -0.3, [{ text: ' and', logprob: -0.3 }, { text: ' in', logprob: -1.5 }, { text: ' for', logprob: -2 }, { text: ' with', logprob: -3 }]), tok(' how', -1.5, null), done('length')]));
  script('anthropic/claude-haiku-4.5', sse([tok(' A', null, null), tok(' thiazide', null, null), done()]));
  store.set({ runId: 1 });
  assert.equal(q('.panes').hidden, false);
  await waitFor(() => panes().every(p => p.querySelector('.status').textContent.startsWith('Finished') || p.querySelector('.status').textContent.startsWith('Cut off')));

  assert.equal(calls.length, 2);
  const left = forModel(AUTOCOMPLETE_MODEL)[0].body, right = forModel('anthropic/claude-haiku-4.5')[0].body;
  const expected = { prompt: 'What is the first-line treatment for hypertension?', system: '', prefix: '', maxTokens: 80, temperature: 0.7, topLogprobs: 3, stream: true };
  assert.deepEqual(left, { model: AUTOCOMPLETE_MODEL, ...expected });
  assert.deepEqual(right, { model: 'anthropic/claude-haiku-4.5', ...expected });

  const [lp, rp] = panes();
  assert.equal(lp.querySelector('.pane-title').textContent, LEFT_LABEL);
  assert.equal(lp.querySelector('.pane-caption').textContent, LEFT_CAPTION);
  assert.equal(rp.querySelector('.pane-title').textContent, 'Claude Haiku 4.5 (2025)');
  assert.equal(rp.querySelector('.pane-caption').textContent, RIGHT_CAPTION);
  assert.ok(lp.querySelector('.out-line').classList.contains('is-completion'), 'the instruct pane flows prompt into continuation');
  assert.equal(lp.querySelector('.out-prompt').textContent, 'What is the first-line treatment for hypertension?');
  assert.deepEqual(chipsIn(lp), ['␣and', '␣how']);
  assert.deepEqual(chipsIn(rp), ['␣A', '␣thiazide']);
  assert.ok(lp.querySelectorAll('.out-chips .chip')[0].classList.contains('band-high'));
  assert.ok(rp.querySelectorAll('.out-chips .chip')[0].classList.contains('band-unknown'));
  assert.equal(lp.querySelectorAll('.can-fork, .has-alts').length, 0, 'not forkable');
  assert.equal(lp.querySelector('.first-guesses').textContent, 'First guesses: ␣and · ␣in · ␣for');
  assert.equal(rp.querySelector('.first-guesses').textContent, 'First guesses: (no alternatives shared)');
  assert.equal(lp.querySelector('.foot-tokens').textContent, '9 in · 2 out');
  assert.equal(lp.querySelector('.foot-cost').textContent, '< $0.0001');
  assert.match(rp.querySelector('.foot-latency').textContent, /ms|s$/);
  assert.equal(lp.querySelector('.status').textContent, 'Cut off at the token limit');
  assert.equal(rp.querySelector('.status').textContent, 'Finished (stop)');
  assert.deepEqual(store.get().results.assistant, { runId: 1, left: AUTOCOMPLETE_MODEL, right: 'anthropic/claude-haiku-4.5' });
  assert.equal(button('Run both again').disabled, false);
});

test('the right pane uses the default model when the chosen model is the instruct model', async () => {
  const { store, panes, forModel } = mountChapter({ modelId: AUTOCOMPLETE_MODEL });
  script(AUTOCOMPLETE_MODEL, sse([tok(' x', -0.1, null), done()]));
  script(DEFAULT_MODEL, sse([tok(' y', -0.1, null), done()]));
  store.set({ runId: 1 });
  await waitFor(() => calls.length === 2 && panes()[1].querySelector('.status').textContent === 'Finished (stop)');
  assert.equal(forModel(DEFAULT_MODEL).length, 1);
  assert.equal(panes()[1].querySelector('.pane-title').textContent, 'GPT-4o mini (2024)');
});

test('presets and the custom field write store.system; "Run both again" re-runs both panes with it and aborts in-flight streams', async () => {
  const { store, q, radio, button, panes, chipsIn, forModel } = mountChapter();
  const NURSE = SYSTEM_PRESETS[1].text;
  script(AUTOCOMPLETE_MODEL, hanging([tok(' and', -0.3, null)]));
  script('anthropic/claude-haiku-4.5', hanging([tok(' A', null, null)]));
  store.set({ runId: 1 });
  await waitFor(() => panes().every(p => p.querySelectorAll('.out-chips .chip').length === 1));

  radio('nurse').checked = true; radio('nurse').dispatch('change');
  assert.equal(store.get().system, NURSE);
  assert.equal(q('.system-custom').hidden, true);

  script(AUTOCOMPLETE_MODEL, sse([tok(' Blood', -0.2, null), done()]));
  script('anthropic/claude-haiku-4.5', sse([tok(' Doctors', null, null), done()]));
  button('Run both again').dispatch('click');
  assert.equal(store.get().runId, 1, 'a local re-run does not bump the global runId');
  await waitFor(() => panes().every(p => p.querySelector('.status').textContent === 'Finished (stop)'));
  assert.equal(calls.length, 4);
  assert.equal(forModel(AUTOCOMPLETE_MODEL)[1].body.system, NURSE);
  assert.equal(forModel('anthropic/claude-haiku-4.5')[1].body.system, NURSE);
  assert.deepEqual(chipsIn(panes()[0]), ['␣Blood'], 'the earlier hanging stream was aborted and its tokens cleared');
  assert.deepEqual(chipsIn(panes()[1]), ['␣Doctors']);

  radio('custom').checked = true; radio('custom').dispatch('change');
  assert.equal(q('.system-custom').hidden, false);
  assert.equal(store.get().system, '', 'an empty custom field is an empty system prompt');
  const ta = q('textarea');
  assert.equal(ta.attributes.maxlength, '400');
  ta.value = 'Answer in French.'; ta.dispatch('input');
  assert.equal(store.get().system, 'Answer in French.');
  assert.equal(q('.counter-inline').textContent, '17 / 400');
  radio('none').checked = true; radio('none').dispatch('change');
  assert.equal(store.get().system, '');
  assert.equal(q('.system-custom').hidden, true);
});

test('a chapter mounted with a custom system text pre-selects Custom; per-pane errors stay in their pane; a new runId uses the new model', async (t) => {
  t.mock.method(console, 'error', () => {});
  const { store, q, panes, chipsIn, forModel } = mountChapter({ system: 'Answer in French.' });
  assert.equal(q('input[type=radio][value=custom]').checked, true);
  assert.equal(q('textarea').value, 'Answer in French.');
  assert.equal(q('.system-custom').hidden, false);

  script(AUTOCOMPLETE_MODEL, new Response(JSON.stringify({ message: 'The class budget for today is used up.' }), { status: 429 }));
  script('anthropic/claude-haiku-4.5', sse([tok(' Oui', null, null), done()]));
  store.set({ runId: 1 });
  await waitFor(() => panes()[0].querySelector('.notice') && panes()[1].querySelector('.status').textContent === 'Finished (stop)');
  assert.equal(panes()[0].querySelector('.notice').children[0].textContent, 'The class budget for today is used up.');
  assert.equal(panes()[1].querySelector('.notice'), null);
  assert.deepEqual(chipsIn(panes()[1]), ['␣Oui']);
  assert.equal(forModel(AUTOCOMPLETE_MODEL)[0].body.system, 'Answer in French.');

  store.set({ modelId: 'openai/gpt-4o-mini' });
  script(AUTOCOMPLETE_MODEL, sse([tok(' a', -0.1, null), done()]));
  script('openai/gpt-4o-mini', sse([tok(' b', -0.1, [{ text: ' b', logprob: -0.1 }]), done()]));
  store.set({ runId: 2 });
  assert.equal(panes()[0].querySelector('.notice'), null, 'the new run clears the old pane');
  await waitFor(() => panes().every(p => p.querySelector('.status').textContent === 'Finished (stop)'));
  assert.equal(panes()[1].querySelector('.pane-title').textContent, 'GPT-4o mini (2024)');
  assert.equal(panes()[1].querySelector('.first-guesses').textContent, 'First guesses: ␣b');
  assert.equal(store.get().results.assistant.runId, 2);
});
