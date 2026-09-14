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
const collectingCtx = () => { const promises = []; return { promises, waitUntil: (p) => { promises.push(p); } }; };
const net = (charges, bucket = 'default') => charges.filter(([b]) => b === bucket).reduce((a, [, u]) => a + u, 0);
const FIXTURE_COST = 0.000003;
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
  // Reserve up front, then reconcile against the real cost: two charges that net to the fixture's cost.
  assert.equal(env._charges.length, 2);
  assert.ok(env._charges[0][1] > FIXTURE_COST, 'reservation should be a conservative over-estimate');
  assert.ok(Math.abs(net(env._charges) - FIXTURE_COST) < 1e-15);
});
test('spend is reserved before the upstream call, and refunded when upstream fails', async () => {
  const seenCharges = [];
  const env = makeEnv({ fetchUpstream: async () => { seenCharges.push(env._charges.length); return new Response('nope', { status: 500 }); } });
  const r = await handle(post('/api/generate', { model: 'openai/gpt-4o-mini', prompt: 'hi' }, { cookie: await cookie(env) }), env, ctx);
  assert.equal(r.status, 502);
  assert.deepEqual(seenCharges, [1], 'reservation is charged before upstream is called');
  assert.ok(Math.abs(net(env._charges)) < 1e-15, 'reservation is refunded on upstream failure');
  const env2 = makeEnv({ fetchUpstream: async () => { throw new TypeError('fetch failed'); } });
  const r2 = await handle(post('/api/generate', { model: 'openai/gpt-4o-mini', prompt: 'hi' }, { cookie: await cookie(env2) }), env2, ctx);
  assert.equal(r2.status, 502); assert.ok(Math.abs(net(env2._charges)) < 1e-15);
});
// C1 part 2: the upstream is drained under waitUntil even if the client cancels
test('client disconnect mid-stream still drains upstream and records the real cost', async () => {
  const fixture = await readFile(new URL('./fixtures/chat_logprobs.sse', import.meta.url), 'utf8');
  const blocks = fixture.split('\n\n').filter(Boolean).map(b => b + '\n\n');
  const enc = new TextEncoder(); let pulls = 0; let upstreamCancelled = false;
  const slowUpstream = () => new Response(new ReadableStream({
    async pull(c) {
      pulls++;
      if (pulls === 1) { c.enqueue(enc.encode(blocks[0] + blocks[1])); return; }
      await new Promise(r => setTimeout(r, 30));
      for (const b of blocks.slice(2)) c.enqueue(enc.encode(b));
      c.close();
    },
    cancel() { upstreamCancelled = true; },
  }), { status: 200, headers: { 'content-type': 'text/event-stream' } });
  const env = makeEnv({ fetchUpstream: async () => slowUpstream() });
  const cctx = collectingCtx();
  const r = await handle(post('/api/generate', { model: 'openai/gpt-4o-mini', prompt: 'hi' }, { cookie: await cookie(env) }), env, cctx);
  const reader = r.body.getReader();
  const first = await reader.read();
  assert.equal(first.done, false);
  assert.match(new TextDecoder().decode(first.value), /"type":"token"/);
  await reader.cancel();
  assert.ok(cctx.promises.length >= 1, 'the upstream pump runs under ctx.waitUntil');
  await Promise.all(cctx.promises);
  assert.equal(upstreamCancelled, false, 'upstream is drained, not cancelled, so the real cost is known');
  assert.equal(env._charges.length, 2, 'reservation + reconciliation');
  assert.ok(Math.abs(net(env._charges) - FIXTURE_COST) < 1e-15);
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
  const ra = Number(r.headers.get('retry-after'));
  assert.ok(ra >= 1 && ra <= 86_400, 'Retry-After is seconds until the next UTC midnight');
  const d = new Date(); const toMidnight = Math.ceil((Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate() + 1) - d.getTime()) / 1000);
  assert.ok(Math.abs(ra - toMidnight) <= 2);
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
test('upstream !ok → its body is cancelled, and a 429 Retry-After is forwarded', async () => {
  let cancelled = false;
  const body = new ReadableStream({ pull(c) { c.enqueue(new TextEncoder().encode('{"error":"x"}')); c.close(); }, cancel() { cancelled = true; } });
  const env = makeEnv({ fetchUpstream: async () => new Response(body, { status: 429, headers: { 'retry-after': '17' } }) });
  const r = await handle(post('/api/generate', { model: 'openai/gpt-4o-mini', prompt: 'hi' }, { cookie: await cookie(env) }), env, ctx);
  assert.equal(r.status, 502); assert.equal(r.headers.get('retry-after'), '17');
  assert.equal(cancelled, true);
  const env2 = makeEnv({ fetchUpstream: async () => new Response('x', { status: 500 }) });
  const r2 = await handle(post('/api/generate', { model: 'openai/gpt-4o-mini', prompt: 'hi' }, { cookie: await cookie(env2) }), env2, ctx);
  assert.equal(r2.headers.get('retry-after'), null);
});
test('stream:false returns collected events as JSON, but still streams from upstream', async () => {
  let sentBody; const base = makeEnv();
  const env = makeEnv({ fetchUpstream: async (url, init) => { sentBody = JSON.parse(init.body); return base.fetchUpstream(); } });
  const r = await handle(post('/api/generate', { model: 'openai/gpt-4o-mini', prompt: 'hi', stream: false }, { cookie: await cookie(env) }), env, ctx);
  assert.equal(r.status, 200); assert.match(r.headers.get('content-type'), /application\/json/);
  const j = await r.json(); assert.equal(j.events[0].type, 'token'); assert.equal(j.events.at(-1).type, 'done');
  assert.equal(sentBody.stream, true);
  assert.ok(Math.abs(net(env._charges) - FIXTURE_COST) < 1e-15);
});
test('GET /api/models returns the ladder; other paths fall through to assets', async () => {
  const env = makeEnv();
  const m = await (await handle(new Request('https://x/api/models'), env, ctx)).json();
  assert.equal(m.length, 8);
  assert.equal(await (await handle(new Request('https://x/index.html'), env, ctx)).text(), 'asset');
});
