import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { handle } from '../worker/src/router.js';
import { Ledger } from '../worker/src/ledger.js';
import { issueSession } from '../worker/src/session.js';

function makeEnv(overrides = {}) {
  const ledger = new Ledger();
  const charges = [];
  return {
    PASSCODE: 'test', COOKIE_SECRET: 'secret', OPENROUTER_API_KEY: 'k', OPENROUTER_BASE_URL: 'https://up/api/v1',
    DAILY_BUDGET_USD: '5', GPT4_DAILY_BUDGET_USD: '1', PER_CLIENT_PER_MINUTE: '30', AUTH_ATTEMPTS_PER_MINUTE: '10',
    LEDGER: { getByName: () => ({ hit: async (c, l) => ledger.hit(c, l), canSpend: async (b, l) => ledger.canSpend(b, l), charge: async (b, u) => { charges.push([b, u]); ledger.charge(b, u); } }) },
    ASSETS: { fetch: async () => new Response('asset', { status: 200 }) },
    fetchUpstream: async () => new Response(await readFile(new URL('./fixtures/chat_logprobs.sse', import.meta.url)), { status: 200, headers: { 'content-type': 'text/event-stream' } }),
    _ledger: ledger, _charges: charges, ...overrides,
  };
}
const ctx = { waitUntil: (p) => p };
const post = (path, body, headers = {}) => new Request(`https://x${path}`, { method: 'POST', body: JSON.stringify(body), headers: { 'content-type': 'application/json', ...headers } });

test('wrong passcode → 401; right passcode → 204 + cookie', async () => {
  const env = makeEnv();
  const bad = await handle(post('/api/auth', { passcode: 'nope' }), env, ctx);
  assert.equal(bad.status, 401);
  const ok = await handle(post('/api/auth', { passcode: 'test' }), env, ctx);
  assert.equal(ok.status, 204); assert.match(ok.headers.get('set-cookie'), /^sess=/);
});
test('auth attempts are rate limited per IP', async () => {
  const env = makeEnv({ AUTH_ATTEMPTS_PER_MINUTE: '2' });
  const h = { 'cf-connecting-ip': '1.2.3.4' };
  await handle(post('/api/auth', { passcode: 'x' }, h), env, ctx);
  await handle(post('/api/auth', { passcode: 'x' }, h), env, ctx);
  assert.equal((await handle(post('/api/auth', { passcode: 'test' }, h), env, ctx)).status, 429);
});
test('generate without cookie → 401', async () => {
  const r = await handle(post('/api/generate', { model: 'openai/gpt-4o-mini', prompt: 'hi' }), makeEnv(), ctx);
  assert.equal(r.status, 401);
});
async function cookie(env) { return `sess=${await issueSession(env.COOKIE_SECRET)}`; }
test('generate streams normalized SSE and charges the bucket on done', async () => {
  const env = makeEnv();
  const r = await handle(post('/api/generate', { model: 'openai/gpt-4o-mini', prompt: 'hi' }, { cookie: await cookie(env) }), env, ctx);
  assert.equal(r.status, 200); assert.match(r.headers.get('content-type'), /text\/event-stream/);
  const text = await r.text();
  const events = text.split('\n\n').filter(Boolean).map(l => JSON.parse(l.replace(/^data: /, '')));
  assert.equal(events[0].type, 'token'); assert.equal(events.at(-1).type, 'done');
  assert.deepEqual(env._charges, [['default', 0.000003]]);
});
test('generate passes auth header, url and body to upstream', async () => {
  let seen; const env = makeEnv({ fetchUpstream: async (url, init) => { seen = { url, init }; return new Response('data: [DONE]\n\n', { status: 200 }); } });
  await handle(post('/api/generate', { model: 'openai/gpt-3.5-turbo-instruct', prompt: 'hi' }, { cookie: await cookie(env) }), env, ctx);
  assert.equal(seen.url, 'https://up/api/v1/completions');
  assert.equal(seen.init.headers.Authorization, 'Bearer k');
  assert.equal(JSON.parse(seen.init.body).prompt, 'hi');
});
test('invalid body → 400 with plain message', async () => {
  const env = makeEnv();
  const r = await handle(post('/api/generate', { model: 'bad', prompt: 'hi' }, { cookie: await cookie(env) }), env, ctx);
  assert.equal(r.status, 400); assert.match((await r.json()).message, /model/i);
});
test('daily budget exhausted → 429 naming the budget; gpt-4 has its own bucket', async () => {
  const env = makeEnv(); env._ledger.charge('gpt4', 5);
  const c = await cookie(env);
  const r = await handle(post('/api/generate', { model: 'openai/gpt-4', prompt: 'hi' }, { cookie: c }), env, ctx);
  assert.equal(r.status, 429); assert.match((await r.json()).message, /budget/i);
  const ok = await handle(post('/api/generate', { model: 'openai/gpt-4o-mini', prompt: 'hi' }, { cookie: c }), env, ctx);
  assert.equal(ok.status, 200);
});
test('per-client rate limit → 429 with Retry-After', async () => {
  const env = makeEnv({ PER_CLIENT_PER_MINUTE: '1' }); const c = await cookie(env);
  await handle(post('/api/generate', { model: 'openai/gpt-4o-mini', prompt: 'hi' }, { cookie: c }), env, ctx);
  const r = await handle(post('/api/generate', { model: 'openai/gpt-4o-mini', prompt: 'hi' }, { cookie: c }), env, ctx);
  assert.equal(r.status, 429); assert.ok(r.headers.get('retry-after'));
});
test('upstream failure → 502 with plain message, no upstream body leaked', async () => {
  const env = makeEnv({ fetchUpstream: async () => new Response('{"error":"secret detail"}', { status: 500 }) });
  const r = await handle(post('/api/generate', { model: 'openai/gpt-4o-mini', prompt: 'hi' }, { cookie: await cookie(env) }), env, ctx);
  assert.equal(r.status, 502); const j = await r.json(); assert.doesNotMatch(j.message, /secret detail/);
});
test('stream:false returns collected events as JSON', async () => {
  const env = makeEnv();
  const r = await handle(post('/api/generate', { model: 'openai/gpt-4o-mini', prompt: 'hi', stream: false }, { cookie: await cookie(env) }), env, ctx);
  const j = await r.json(); assert.equal(j.events.at(-1).type, 'done');
});
test('GET /api/models returns the ladder; other paths fall through to assets', async () => {
  const env = makeEnv();
  const m = await (await handle(new Request('https://x/api/models'), env, ctx)).json();
  assert.equal(m.length, 8);
  assert.equal(await (await handle(new Request('https://x/index.html'), env, ctx)).text(), 'asset');
});
