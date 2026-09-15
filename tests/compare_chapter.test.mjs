/** Chapter 6 with the fake DOM and a scripted fetch: pickers, prompt prefill, system echo, concurrent panes, stop, errors. */
import { test, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { installFakeDom } from './helpers/fake-dom.mjs';
import { waitFor } from './helpers/wait-for.mjs';
import { createStore } from '../site/store.js';
import { closePopover } from '../site/popover.js';
import { MODELS } from '../site/models.js';
import { mount, systemEchoText, DEFAULT_PICKS, SUGGESTED_PROMPTS, GPT4_COST_NOTE } from '../site/chapters/compare.js';

test('systemEchoText echoes none or the first 60 characters', () => {
  assert.equal(systemEchoText(''), 'System prompt: none');
  assert.equal(systemEchoText(undefined), 'System prompt: none');
  assert.equal(systemEchoText('Answer in French.'), 'System prompt: “Answer in French.”');
  const long = 'You are a nurse educator. Answer at a sixth-grade reading level in two short sentences.';
  assert.equal(systemEchoText(long), 'System prompt: “You are a nurse educator. Answer at a sixth-grade reading le…”');
});

test('the plan\'s defaults and suggested prompts', () => {
  assert.deepEqual([...DEFAULT_PICKS], ['openai/gpt-3.5-turbo', 'anthropic/claude-haiku-4.5', 'meta-llama/llama-3.3-70b-instruct']);
  assert.equal(SUGGESTED_PROMPTS.length, 4);
  assert.equal(SUGGESTED_PROMPTS[3], "What is today's date?");
});

// ---- Integration --------------------------------------------------------------------------------------------------
const sse = (events) => new Response(events.map(e => `data: ${JSON.stringify(e)}\n\n`).join(''), { status: 200 });
const tok = (text, logprob, top) => ({ type: 'token', text, logprob, top });
const done = (finish = 'stop') => ({ type: 'done', usage: { prompt: 11, completion: 2 }, cost: 0.0005, finish });
const hanging = (events) => () => new Response(new ReadableStream({
  start(c) { for (const e of events) c.enqueue(new TextEncoder().encode(`data: ${JSON.stringify(e)}\n\n`)); },
}), { status: 200 });

let dom, calls, responses, realFetch;
beforeEach(() => {
  dom = installFakeDom();
  calls = []; responses = new Map();
  realFetch = globalThis.fetch;
  globalThis.fetch = async (url, init) => {
    const body = JSON.parse(init.body);
    calls.push({ url, body });
    const next = (responses.get(body.model) || []).shift();
    if (!next) throw new Error(`test: no scripted response left for ${body.model}`);
    return typeof next === 'function' ? next() : next;
  };
});
afterEach(() => { closePopover(); globalThis.fetch = realFetch; dom.restore(); });
const script = (model, res) => { if (!responses.has(model)) responses.set(model, []); responses.get(model).push(res); };

function mountChapter(state = {}) {
  const viz = dom.document.createElement('div'); viz.className = 'viz';
  const root = dom.document.createElement('section'); root.append(viz);
  dom.document.body.append(root);
  const store = createStore({ prompt: 'The capital of Australia is', modelId: 'openai/gpt-4o-mini', system: '', runId: 0, results: {}, ...state });
  mount(root, store);
  const q = (sel) => viz.querySelector(sel);
  const selects = () => viz.querySelectorAll('select');
  const panes = () => viz.querySelectorAll('.pane');
  const status = (pane) => pane.querySelector('.status').textContent;
  const chipsIn = (pane) => pane.querySelectorAll('.out-chips .chip');
  const button = (text) => viz.querySelectorAll('button').find(b => b.textContent.trim() === text);
  const forModel = (id) => calls.filter(c => c.body.model === id);
  return { viz, store, q, selects, panes, status, chipsIn, button, forModel };
}

test('pickers, prompt prefill, suggested chips and the system echo before any run', () => {
  const { store, q, selects, panes, button } = mountChapter();
  assert.equal(selects().length, 3);
  assert.deepEqual(selects().map(s => s.value), [...DEFAULT_PICKS]);
  const groups = selects()[0].querySelectorAll('optgroup');
  assert.deepEqual(groups.map(g => g.attributes.label), ['Early (2022–2023)', 'Recent (2024)', 'Current (2025–2026)', 'Open weights']);
  assert.equal(selects()[0].querySelectorAll('option').length, MODELS.length);
  assert.equal(q('.panes').hidden, true);
  assert.equal(calls.length, 0);
  assert.equal(panes()[1].querySelector('.pane-title').textContent, 'Claude Haiku 4.5 (2025)', 'headers reflect the picks before a run');
  assert.equal(panes()[2].querySelector('.badge-open').textContent, 'open weights');
  assert.equal(panes()[0].querySelector('.badge-open'), null);
  assert.equal(panes()[0].querySelector('.badge-year').textContent, '2023');
  assert.equal(panes()[0].querySelector('.pane-provider').textContent, 'OpenAI');

  const field = q('textarea');
  assert.equal(field.value, 'The capital of Australia is');
  assert.equal(field.attributes.maxlength, '200');
  assert.equal(q('#compare-counter').textContent, '27 / 200');
  assert.equal(button('Compare').disabled, false);
  assert.equal(button('Stop all').disabled, true);
  assert.equal(q('.system-echo').textContent, 'System prompt: none · change it in chapter 5');
  assert.equal(q('.system-echo a').attributes.href, '#ch-assistant');
  store.set({ system: 'Answer in French.' });
  assert.equal(q('.system-echo span').textContent, 'System prompt: “Answer in French.”');

  // An untouched field follows the main prompt on each global run; a touched one keeps the student's text.
  store.set({ prompt: 'List three causes of a persistent cough.', runId: 1 });
  assert.equal(field.value, 'List three causes of a persistent cough.');
  const chips = q('.suggested').querySelectorAll('button');
  assert.deepEqual(chips.map(c => c.textContent), [...SUGGESTED_PROMPTS]);
  chips[0].dispatch('click');
  assert.equal(field.value, SUGGESTED_PROMPTS[0]);
  store.set({ prompt: 'Something else', runId: 2 });
  assert.equal(field.value, SUGGESTED_PROMPTS[0], 'a chosen prompt is kept');
  field.value = ''; field.dispatch('input');
  assert.equal(button('Compare').disabled, true);
});

test('Compare streams three panes at once with the shared system prompt; alternatives popover on probability chips; footers; nothing published', async () => {
  const { store, q, panes, status, chipsIn, button, forModel } = mountChapter({ system: 'Be brief.' });
  script('openai/gpt-3.5-turbo', sse([tok(' Canberra', -0.2, [{ text: ' Canberra', logprob: -0.2 }, { text: ' Sydney', logprob: -1.8 }]), done()]));
  script('anthropic/claude-haiku-4.5', sse([tok(' Canberra', null, null), tok('.', null, null), done()]));
  script('meta-llama/llama-3.3-70b-instruct', sse([tok(' Sydney', -1.9, [{ text: ' Canberra', logprob: -0.3 }, { text: ' Sydney', logprob: -1.9 }]), done('length')]));
  button('Compare').dispatch('click');
  assert.equal(q('.panes').hidden, false);
  assert.equal(button('Stop all').disabled, false);
  assert.equal(calls.length, 3, 'all three requests go out together');
  await waitFor(() => panes().every(p => status(p) !== 'Writing…'));

  const expected = { prompt: 'The capital of Australia is', system: 'Be brief.', prefix: '', maxTokens: 120, temperature: 0.7, topLogprobs: 5, stream: true };
  for (const id of DEFAULT_PICKS) assert.deepEqual(forModel(id)[0].body, { model: id, ...expected });
  const [a, b, c] = panes();
  assert.equal(status(a), 'Finished (stop)');
  assert.equal(status(c), 'Cut off at the token limit');
  assert.ok(chipsIn(a)[0].classList.contains('band-high') && chipsIn(a)[0].classList.contains('has-alts'));
  assert.ok(chipsIn(b)[0].classList.contains('band-unknown') && !chipsIn(b)[0].classList.contains('has-alts'));
  assert.ok(chipsIn(c)[0].classList.contains('band-low'));
  assert.equal(a.querySelector('.out-prompt').textContent, '', 'the prompt is not repeated in every pane');
  assert.equal(a.querySelector('.foot-tokens').textContent, '11 in · 2 out');
  assert.equal(a.querySelector('.foot-cost').textContent, '$0.0005');
  assert.match(a.querySelector('.foot-latency').textContent, /ms|s$/);
  assert.equal(button('Stop all').disabled, true);

  chipsIn(c)[0].dispatch('mouseover');
  const pop = dom.document.body.querySelector('.popover');
  assert.ok(pop, 'hover shows the alternatives');
  assert.deepEqual(pop.querySelectorAll('.fork-alt').map(r => r.querySelector('.fork-label').textContent), ['␣Canberra', '␣Sydney']);
  assert.equal(pop.querySelectorAll('.fork-alt')[1].attributes['aria-current'], 'true');
  assert.equal(pop.querySelectorAll('button').length, 0, 'read-only: nothing to fork');
  chipsIn(c)[0].dispatch('mouseout');
  assert.equal(dom.document.body.querySelector('.popover'), null);
  assert.deepEqual(store.get().results, {}, 'compare publishes nothing');
  assert.equal(store.get().runId, 0, 'compare does not touch the global run');
});

test('Stop all marks streaming panes stopped; changing a picker shows the GPT-4 cost badge and clears that pane; errors stay in their pane', async (t) => {
  t.mock.method(console, 'error', () => {});
  const { q, selects, panes, status, chipsIn, button, forModel } = mountChapter();
  script('openai/gpt-3.5-turbo', hanging([tok(' Can', -0.2, null)]));
  script('anthropic/claude-haiku-4.5', sse([tok(' Canberra', null, null), done()]));
  script('meta-llama/llama-3.3-70b-instruct', hanging([tok(' Syd', -1.9, null)]));
  button('Compare').dispatch('click');
  await waitFor(() => chipsIn(panes()[0]).length === 1 && chipsIn(panes()[2]).length === 1 && status(panes()[1]) === 'Finished (stop)');
  button('Stop all').dispatch('click');
  assert.deepEqual(panes().map(status), ['Stopped', 'Finished (stop)', 'Stopped']);
  assert.equal(chipsIn(panes()[0]).length, 1, 'partial output is kept');
  assert.equal(button('Stop all').disabled, true);

  const sel = selects()[1];
  sel.value = 'openai/gpt-4'; sel.dispatch('change');
  const pane = panes()[1];
  assert.equal(pane.querySelector('.pane-title').textContent, 'GPT-4 (2023)');
  assert.equal(pane.querySelector('.badge-cost').textContent, '$$$');
  assert.equal(pane.querySelector('.pane-cost-note').hidden, false);
  assert.equal(pane.querySelector('.pane-cost-note').textContent, GPT4_COST_NOTE);
  assert.equal(pane.querySelector('.pane-blurb').textContent, 'The first frontier model. Still expensive: about 100× the price of GPT-4o mini.');
  assert.equal(chipsIn(pane).length, 0, 'output from the previous model is cleared');
  assert.equal(status(pane), '');

  script('openai/gpt-3.5-turbo', sse([tok(' Canberra', -0.2, null), done()]));
  script('openai/gpt-4', new Response(JSON.stringify({ message: "Today's GPT-4 budget is used up." }), { status: 429 }));
  script('meta-llama/llama-3.3-70b-instruct', sse([tok(' Canberra', -0.3, null), done()]));
  button('Compare').dispatch('click');
  await waitFor(() => pane.querySelector('.notice') && status(panes()[0]) === 'Finished (stop)' && status(panes()[2]) === 'Finished (stop)');
  assert.equal(pane.querySelector('.notice').children[0].textContent, "Today's GPT-4 budget is used up.");
  assert.equal(panes()[0].querySelector('.notice'), null);
  assert.equal(panes()[2].querySelector('.notice'), null);
  assert.equal(forModel('openai/gpt-4').length, 1);
  assert.equal(q('.panes').hidden, false);
});
