import { test, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { checkSession, login, generate } from '../site/api.js';

const realFetch = globalThis.fetch;
let calls;
beforeEach(() => { calls = []; });
afterEach(() => { globalThis.fetch = realFetch; });

/** Install a fetch stub that records (url, init) and returns the given Response (or calls a function per request). */
function stubFetch(responder) {
  globalThis.fetch = async (url, init = {}) => {
    calls.push({ url, init });
    return typeof responder === 'function' ? responder(url, init) : responder;
  };
}
const sse = (...events) => events.map(e => `data: ${JSON.stringify(e)}\n\n`).join('');
const sseResponse = (text, status = 200) => new Response(text, { status, headers: { 'content-type': 'text/event-stream' } });
const TOKEN = { type: 'token', text: ' a', logprob: -0.2, top: [{ text: ' a', logprob: -0.2 }] };
const DONE = { type: 'done', usage: { prompt: 5, completion: 1 }, cost: 0.000001, finish: 'stop' };

test('checkSession: 204 → true, 401 → false', async () => {
  stubFetch(new Response(null, { status: 204 }));
  assert.equal(await checkSession(), true);
  assert.equal(calls[0].url, '/api/session');
  stubFetch(new Response(null, { status: 401 }));
  assert.equal(await checkSession(), false);
});

test('login: 204 → ok; 401 with a message → that message; junk body → generic message', async () => {
  stubFetch(new Response(null, { status: 204 }));
  assert.deepEqual(await login('test'), { ok: true });
  assert.equal(calls[0].url, '/api/auth');
  assert.equal(calls[0].init.method, 'POST');
  assert.deepEqual(JSON.parse(calls[0].init.body), { passcode: 'test' });
  stubFetch(new Response(JSON.stringify({ message: 'That passcode is not right.' }), { status: 401 }));
  assert.deepEqual(await login('nope'), { ok: false, message: 'That passcode is not right.' });
  stubFetch(new Response('<html>oops</html>', { status: 502 }));
  assert.deepEqual(await login('nope'), { ok: false, message: 'Could not sign in.' });
});

test('generate: POSTs the request shape, streams token then done to onEvent, and returns the done event', async () => {
  stubFetch(sseResponse(sse(TOKEN, DONE)));
  const seen = [];
  const done = await generate({ model: 'openai/gpt-4o-mini', prompt: 'The patient', maxTokens: 1, temperature: 0.7, topLogprobs: 10 }, { onEvent: (ev) => seen.push(ev) });
  assert.equal(calls.length, 1);
  assert.equal(calls[0].url, '/api/generate');
  assert.equal(calls[0].init.method, 'POST');
  assert.equal(calls[0].init.headers['content-type'], 'application/json');
  assert.deepEqual(JSON.parse(calls[0].init.body), { model: 'openai/gpt-4o-mini', prompt: 'The patient', system: '', prefix: '', maxTokens: 1, temperature: 0.7, topLogprobs: 10, stream: true });
  assert.deepEqual(seen, [TOKEN, DONE]);
  assert.deepEqual(done, DONE);
});

test('generate: events split across chunks are reassembled; a stream with no done event returns null', async () => {
  const text = sse(TOKEN, TOKEN);
  const cut = text.indexOf('\n\n') + 5; // split inside the second event
  const body = new ReadableStream({
    start(c) { const enc = new TextEncoder(); c.enqueue(enc.encode(text.slice(0, cut))); c.enqueue(enc.encode(text.slice(cut))); c.close(); },
  });
  stubFetch(new Response(body, { status: 200, headers: { 'content-type': 'text/event-stream' } }));
  const seen = [];
  const done = await generate({ model: 'm', prompt: 'p' }, { onEvent: (ev) => seen.push(ev) });
  assert.deepEqual(seen, [TOKEN, TOKEN]);
  assert.equal(done, null);
});

test('generate: 429 with a JSON message throws that message', async () => {
  stubFetch(new Response(JSON.stringify({ message: 'You are sending requests quickly.' }), { status: 429, headers: { 'content-type': 'application/json' } }));
  await assert.rejects(generate({ model: 'm', prompt: 'p' }, { onEvent: () => {} }), (err) => err instanceof Error && err.message === 'You are sending requests quickly.' && err.status === 429);
});

test('generate: a non-JSON error body throws a generic message that names the status', async () => {
  stubFetch(new Response('Bad gateway', { status: 502 }));
  await assert.rejects(generate({ model: 'm', prompt: 'p' }, { onEvent: () => {} }), (err) => /502/.test(err.message) && !/Bad gateway/.test(err.message));
});

test('generate: aborting the signal stops reading and rejects with an AbortError, not an unhandled error', async () => {
  let cancelled = false, pushed = 0;
  const enc = new TextEncoder();
  const body = new ReadableStream({
    pull(c) { pushed++; c.enqueue(enc.encode(sse(TOKEN))); return new Promise(r => setTimeout(r, 5)); },
    cancel() { cancelled = true; },
  });
  stubFetch((url, init) => { assert.ok(init.signal, 'the signal is handed to fetch'); return new Response(body, { status: 200, headers: { 'content-type': 'text/event-stream' } }); });
  const ac = new AbortController();
  let tokens = 0;
  const p = generate({ model: 'm', prompt: 'p' }, { onEvent: () => { tokens++; if (tokens === 2) ac.abort(); }, signal: ac.signal });
  await assert.rejects(p, (err) => err.name === 'AbortError');
  assert.ok(cancelled, 'the body reader was cancelled');
  const after = pushed;
  await new Promise(r => setTimeout(r, 30));
  assert.equal(pushed, after, 'no more chunks are pulled after the abort');
  assert.ok(tokens <= 3, `stopped promptly, saw ${tokens} tokens`);
});

test('generate: an already-aborted signal rejects before fetching', async () => {
  stubFetch(sseResponse(sse(TOKEN, DONE)));
  const ac = new AbortController(); ac.abort();
  await assert.rejects(generate({ model: 'm', prompt: 'p' }, { onEvent: () => {}, signal: ac.signal }), (err) => err.name === 'AbortError');
  assert.equal(calls.length, 0);
});
