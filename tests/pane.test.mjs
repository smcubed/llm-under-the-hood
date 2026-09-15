/** The shared output pane: pure helpers, then one integration pass with the fake DOM and a scripted fetch. */
import { test, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { installFakeDom } from './helpers/fake-dom.mjs';
import { waitFor } from './helpers/wait-for.mjs';
import { closePopover } from '../site/popover.js';
import { getModel } from '../site/models.js';
import { createOutputPane, joinTokens, forkAt, tokenBand, statusText, toToken } from '../site/pane.js';

const top = [{ text: ' CT', logprob: Math.log(0.6) }, { text: ' MRI', logprob: Math.log(0.3) }];
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
  assert.equal(tokens.length, 3, 'the input is not mutated');
  assert.equal(forkAt(tokens, 2, 'X')[2].top, null, 'a step without alternatives still forks');
  assert.throws(() => forkAt(tokens, 3, 'X'), RangeError);
  assert.throws(() => forkAt(tokens, -1, 'X'), RangeError);
});

test('tokenBand uses the token\'s own probability and falls back to unknown', () => {
  assert.equal(tokenBand({ logprob: -0.1 }), 'high');
  assert.equal(tokenBand({ logprob: Math.log(0.4) }), 'mid');
  assert.equal(tokenBand({ logprob: Math.log(0.1) }), 'low');
  assert.equal(tokenBand({ logprob: null }), 'unknown');
  assert.equal(tokenBand({}), 'unknown');
});

test('statusText covers writing, paused, stopped and every finish reason', () => {
  assert.equal(statusText(null, true, false), 'Writing…');
  assert.equal(statusText('stop', true, false), 'Writing…', 'streaming wins over a stale finish');
  assert.equal(statusText(null, false, true), 'Paused');
  assert.equal(statusText('stop', false, false), 'Finished (stop)');
  assert.equal(statusText('length', false, false), 'Cut off at the token limit');
  assert.equal(statusText('truncated', false, false), 'Connection dropped, partial output kept');
  assert.equal(statusText('stopped', false, false), 'Stopped');
  assert.equal(statusText('content_filter', false, false), 'Finished (content_filter)');
  assert.equal(statusText(null, false, false), '');
});

test('toToken normalizes a token event', () => {
  assert.deepEqual(toToken({ text: 'a', logprob: -1, top: [] }), { text: 'a', logprob: -1, top: null });
  assert.deepEqual(toToken({ text: 'a', logprob: 'x', top }), { text: 'a', logprob: null, top });
});

// ---- Integration --------------------------------------------------------------------------------------------------
const sse = (events) => new Response(events.map(e => `data: ${JSON.stringify(e)}\n\n`).join(''), { status: 200 });
const tok = (text, logprob, top) => ({ type: 'token', text, logprob, top });
const done = (finish = 'stop') => ({ type: 'done', usage: { prompt: 12, completion: 3 }, cost: 0.0004, finish });
const hanging = (events) => () => new Response(new ReadableStream({
  start(c) { for (const e of events) c.enqueue(new TextEncoder().encode(`data: ${JSON.stringify(e)}\n\n`)); },
}), { status: 200 });

let dom, calls, responses, realFetch;
beforeEach(() => {
  dom = installFakeDom();
  calls = []; responses = [];
  realFetch = globalThis.fetch;
  globalThis.fetch = async (url, init) => {
    calls.push({ url, body: JSON.parse(init.body) });
    const next = responses.shift();
    if (!next) throw new Error('test: no scripted response left');
    return typeof next === 'function' ? next() : next;
  };
});
afterEach(() => { closePopover(); globalThis.fetch = realFetch; dom.restore(); });

const ctxOf = (current = () => true) => ({ signal: new AbortController().signal, isCurrent: current });
const params = { model: 'openai/gpt-4o-mini', prompt: 'Why?', system: '', maxTokens: 80, topLogprobs: 3, temperature: 0.7, prefix: '' };

test('start → tokens appear → pause → resume sends the text so far as prefix → footer; read-only alternatives on hover/click; reset closes the popover', async () => {
  const root = dom.document.createElement('div');
  dom.document.body.append(root);
  const changes = [];
  const pane = createOutputPane(root, { getModel: () => getModel('openai/gpt-4o-mini'), showConsidered: false, forkable: false, alternatives: true, footer: true, onChange: (p) => changes.push(p.phase) });
  const chips = () => root.querySelectorAll('.out-chips .chip');
  const status = () => root.querySelector('.status').textContent;
  assert.equal(pane.el, root);
  assert.equal(pane.phase, 'idle');
  assert.equal(root.querySelector('.considered'), null);
  assert.equal(root.querySelector('.pane-foot').hidden, true);

  responses.push(hanging([tok(' Because', -0.2, [{ text: ' Because', logprob: -0.2 }, { text: ' It', logprob: -2 }]), tok(' the', -0.9, null)]));
  pane.start(ctxOf(), params);
  assert.equal(pane.phase, 'streaming');
  assert.equal(status(), 'Writing…');
  assert.equal(root.querySelector('.out-prompt').textContent, 'Why?');
  await waitFor(() => chips().length === 2);
  assert.deepEqual(chips().map(c => c.textContent), ['␣Because', '␣the']);
  assert.ok(chips()[0].classList.contains('band-high') && chips()[0].classList.contains('has-alts'));
  assert.equal(chips()[0].classList.contains('can-fork'), false);
  assert.ok(chips()[1].classList.contains('band-mid') && !chips()[1].classList.contains('has-alts'));
  assert.deepEqual(pane.tokens.map(t => t.text), [' Because', ' the']);

  pane.pause();
  assert.equal(pane.phase, 'paused');
  assert.equal(status(), 'Paused');
  assert.equal(chips().length, 2);
  responses.push(sse([tok(' sky', -0.3, null), done()]));
  pane.resume();
  await waitFor(() => pane.phase === 'done');
  assert.equal(calls.length, 2);
  assert.equal(calls[1].body.prefix, ' Because the');
  assert.deepEqual({ ...calls[1].body, prefix: '' }, { ...params, stream: true });
  assert.equal(status(), 'Finished (stop)');
  assert.equal(pane.finish, 'stop');
  assert.equal(pane.text, ' Because the sky');
  const foot = root.querySelector('.pane-foot');
  assert.equal(foot.hidden, false);
  assert.match(foot.querySelector('.foot-latency').textContent, /^\d+ ms$|^\d+\.\d s$/);
  assert.equal(foot.querySelector('.foot-tokens').textContent, '12 in · 3 out');
  assert.equal(foot.querySelector('.foot-cost').textContent, '$0.0004');
  assert.deepEqual(pane.stats.usage, { prompt: 12, completion: 3 });
  assert.deepEqual(changes, ['streaming', 'paused', 'streaming', 'done']);

  // Read-only alternatives: hover opens, leaving closes; click opens sticky rows that are not buttons.
  chips()[0].dispatch('mouseover');
  let pop = dom.document.body.querySelector('.popover');
  assert.ok(pop, 'hover opened the popover');
  assert.equal(pop.querySelectorAll('button').length, 0);
  assert.deepEqual(pop.querySelectorAll('.fork-alt').map(r => r.querySelector('.fork-label').textContent), ['␣Because', '␣It']);
  assert.equal(pop.querySelectorAll('.fork-alt')[0].attributes['aria-current'], 'true');
  chips()[0].dispatch('mouseout', { relatedTarget: chips()[0].querySelector('.sp') });
  assert.ok(dom.document.body.querySelector('.popover'), 'moving onto the chip\'s own space marker keeps it open');
  chips()[0].dispatch('mouseout');
  assert.equal(dom.document.body.querySelector('.popover'), null);
  chips()[0].dispatch('click');
  pop = dom.document.body.querySelector('.popover');
  assert.ok(pop);
  chips()[0].dispatch('mouseout');
  assert.ok(dom.document.body.querySelector('.popover'), 'a clicked-open popover survives the pointer leaving');
  pane.reset();
  assert.equal(dom.document.body.querySelector('.popover'), null);
  assert.equal(chips().length, 0);
  assert.equal(pane.phase, 'idle');
  assert.equal(status(), '');
  assert.equal(foot.hidden, true);
});

test('errors show a notice whose Retry resumes from the current text; stop() marks the pane stopped; a stale ctx renders nothing', async (t) => {
  t.mock.method(console, 'error', () => {});
  const root = dom.document.createElement('div');
  dom.document.body.append(root);
  const errors = [];
  const pane = createOutputPane(root, { getModel: () => getModel('anthropic/claude-haiku-4.5'), forkable: false, onError: (m, fromStream) => errors.push([m, fromStream]) });
  const chips = () => root.querySelectorAll('.out-chips .chip');
  assert.ok(root.querySelector('.considered'), 'the side panel is on by default');

  responses.push(sse([tok(' Sure', null, null), { type: 'error', message: 'Provider failed.' }]));
  pane.start(ctxOf(), params);
  await waitFor(() => pane.phase === 'error');
  assert.equal(chips().length, 1);
  assert.deepEqual(errors, [['Provider failed.', true]]);
  const n = root.querySelector('.error-slot .notice');
  assert.equal(n.children[0].textContent, 'Provider failed.');
  assert.match(root.querySelector('.considered p').textContent, /does not share/);
  responses.push(sse([tok(',', null, null), done('length')]));
  n.querySelector('button').dispatch('click');
  assert.equal(root.querySelector('.error-slot .notice'), null);
  await waitFor(() => pane.phase === 'done');
  assert.equal(calls[1].body.prefix, ' Sure');
  assert.equal(root.querySelector('.status').textContent, 'Cut off at the token limit');

  pane.reset();
  responses.push(hanging([tok(' a', null, null)]));
  pane.start(ctxOf(), params);
  await waitFor(() => chips().length === 1);
  pane.stop();
  assert.equal(pane.phase, 'done');
  assert.equal(pane.finish, 'stopped');
  assert.equal(root.querySelector('.status').textContent, 'Stopped');
  pane.stop();
  assert.equal(pane.finish, 'stopped', 'a second stop is a no-op');

  pane.reset();
  responses.push(sse([tok(' late', null, null), done()]));
  pane.start(ctxOf(() => false), params);
  await waitFor(() => calls.length === 4);
  await new Promise(r => setTimeout(r, 0));
  await new Promise(r => setTimeout(r, 0));
  assert.equal(chips().length, 0);
  assert.equal(pane.phase, 'streaming', 'a stale run never resolves the pane');
});

test('forkable panes fork themselves when no onFork is given, and setTokens/setPrompt/setConfidence render directly', async () => {
  const root = dom.document.createElement('div');
  dom.document.body.append(root);
  const pane = createOutputPane(root, { getModel: () => getModel('openai/gpt-3.5-turbo-instruct'), completionNote: 'It continues.', getPrefixText: () => 'The patient' });
  const chips = () => root.querySelectorAll('.out-chips .chip');
  pane.setPrompt('The patient');
  assert.ok(root.querySelector('.out-line').classList.contains('is-completion'));
  assert.equal(root.querySelector('.completion-note').hidden, false);
  pane.setTokens([{ text: ' was', logprob: -0.1, top: [{ text: ' was', logprob: -0.1 }, { text: ' had', logprob: -1.5 }] }]);
  assert.equal(chips().length, 1);
  assert.ok(chips()[0].classList.contains('can-fork'));
  assert.equal(root.querySelectorAll('.mini-bars .bar-row').length, 2);
  pane.setConfidence(false);
  assert.ok(root.querySelector('.out-line').classList.contains('confidence-off'));

  responses.push(sse([tok(' seen', -0.2, null), done()]));
  pane.start(ctxOf(), { ...params, model: 'openai/gpt-3.5-turbo-instruct', prefix: ' was' });
  await waitFor(() => pane.phase === 'done');
  chips()[0].dispatch('keydown', { key: 'Enter', preventDefault() {} });
  const alts = dom.document.body.querySelector('.popover').querySelectorAll('.fork-alt');
  assert.equal(alts[1].tagName, 'button');
  responses.push(sse([tok(' a', -0.2, null), done()]));
  alts[1].dispatch('click');
  await waitFor(() => pane.phase === 'done' && chips().length === 3);
  assert.equal(calls[1].body.prefix, ' had');
  assert.deepEqual(chips().map(c => c.textContent), ['forked here', '␣had', '␣a']);
});
