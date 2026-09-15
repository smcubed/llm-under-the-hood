/** `request()` against a scripted fetch and a real store-driven run ctx. */
import { test, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { createStore } from '../site/store.js';
import { createRun } from '../site/run.js';
import { request, anySignal } from '../site/stream.js';

const sse = (events) => new Response(events.map(e => `data: ${JSON.stringify(e)}\n\n`).join(''), { status: 200 });
const tok = (text) => ({ type: 'token', text, logprob: -0.1, top: null });
const DONE = { type: 'done', usage: { prompt: 3, completion: 2 }, cost: 0.00001, finish: 'stop' };

let calls, responses, realFetch;
beforeEach(() => {
  calls = []; responses = [];
  realFetch = globalThis.fetch;
  globalThis.fetch = async (url, init) => {
    calls.push({ url, body: JSON.parse(init.body), signal: init.signal });
    const next = responses.shift();
    if (!next) throw new Error('test: no scripted response left');
    return typeof next === 'function' ? next() : next;
  };
});
afterEach(() => { globalThis.fetch = realFetch; });

function runCtx(store) {
  let ctx = null;
  createRun(store, (c) => { ctx = c; });
  return () => ctx;
}
const record = () => {
  const log = [];
  return { log, handlers: { onToken: (ev) => log.push(['token', ev.text]), onDone: (d) => log.push(['done', d?.finish]), onError: (m, fromStream) => log.push(['error', m, fromStream]) } };
};

test('delivers token events then done; the fetch carries a combined signal', async () => {
  const store = createStore({ runId: 1 });
  const ctx = runCtx(store)();
  const { log, handlers } = record();
  responses.push(sse([tok('a'), tok('b'), DONE]));
  const h = request(ctx, { model: 'm', prompt: 'p', maxTokens: 5 }, handlers);
  await h.done;
  assert.deepEqual(log, [['token', 'a'], ['token', 'b'], ['done', 'stop']]);
  assert.equal(calls.length, 1);
  assert.equal(calls[0].body.stream, true);
  assert.ok(calls[0].signal instanceof AbortSignal);
});

test('HTTP errors report the server message with fromStream=false; stream errors keep earlier tokens and set fromStream=true', async () => {
  const store = createStore({ runId: 1 });
  const ctx = runCtx(store)();
  const a = record();
  responses.push(new Response(JSON.stringify({ message: 'Budget used up.' }), { status: 429 }));
  await request(ctx, { model: 'm', prompt: 'p' }, a.handlers).done;
  assert.deepEqual(a.log, [['error', 'Budget used up.', false]]);
  const b = record();
  responses.push(sse([tok('a'), { type: 'error', message: 'Provider failed.' }]));
  await request(ctx, { model: 'm', prompt: 'p' }, b.handlers).done;
  assert.deepEqual(b.log, [['token', 'a'], ['error', 'Provider failed.', true]]);
});

test('abort() silences everything after it, including the error', async () => {
  const store = createStore({ runId: 1 });
  const ctx = runCtx(store)();
  const { log, handlers } = record();
  let release;
  responses.push(() => new Promise(r => { release = () => r(sse([tok('late'), DONE])); }));
  const h = request(ctx, { model: 'm', prompt: 'p' }, handlers);
  h.abort();
  release();
  await h.done;
  assert.deepEqual(log, []);
  assert.equal(calls[0].signal.aborted, true, 'the upstream fetch signal is aborted too');
});

test('a new runId makes the previous request stale: no callbacks, and the fetch signal aborts', async () => {
  const store = createStore({ runId: 1 });
  const get = runCtx(store);
  const { log, handlers } = record();
  let release;
  responses.push(() => new Promise(r => { release = () => r(sse([tok('late'), DONE])); }));
  const h = request(get(), { model: 'm', prompt: 'p' }, handlers);
  store.set({ runId: 2 });
  assert.equal(calls[0].signal.aborted, true);
  release();
  await h.done;
  assert.deepEqual(log, []);
});

test('a plain ctx without isCurrent works; a ctx whose isCurrent flips to false drops the done', async () => {
  const { log, handlers } = record();
  responses.push(sse([tok('a'), DONE]));
  await request({ signal: new AbortController().signal }, { model: 'm', prompt: 'p' }, handlers).done;
  assert.deepEqual(log, [['token', 'a'], ['done', 'stop']]);
  let current = true;
  const b = record();
  responses.push(sse([tok('a'), DONE]));
  await request({ isCurrent: () => current }, { model: 'm', prompt: 'p' }, { ...b.handlers, onToken: (ev) => { b.log.push(['token', ev.text]); current = false; } }).done;
  assert.deepEqual(b.log, [['token', 'a']]);
});

test('anySignal aborts when any input aborts, with or without AbortSignal.any', () => {
  const check = () => {
    const a = new AbortController(), b = new AbortController();
    const s = anySignal([a.signal, undefined, b.signal]);
    assert.equal(s.aborted, false);
    b.abort();
    assert.equal(s.aborted, true);
    const pre = new AbortController(); pre.abort();
    assert.equal(anySignal([pre.signal]).aborted, true);
  };
  check();
  const real = AbortSignal.any;
  AbortSignal.any = undefined;
  try { check(); } finally { AbortSignal.any = real; }
});
