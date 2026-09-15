import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { handle } from '../worker/src/router.js';
import { Ledger } from '../worker/src/ledger.js';
import { issueSession } from '../worker/src/session.js';
import { startMock } from '../tools/mock_openrouter.mjs';
import { getModel, estimateCost } from '../site/models.js';

function makeEnv(overrides = {}) {
  const ledger = new Ledger();
  const charges = [];
  return {
    PASSCODE: 'test', COOKIE_SECRET: 'secret', OPENROUTER_API_KEY: 'k', OPENROUTER_BASE_URL: 'https://up/api/v1',
    DAILY_BUDGET_USD: '5', GPT4_DAILY_BUDGET_USD: '1', PER_CLIENT_PER_MINUTE: '30', AUTH_ATTEMPTS_PER_MINUTE: '10',
    // Fake DO stub over the pure Ledger. Deliberately exposes no canSpend: the router must reserve atomically.
    LEDGER: { getByName: () => ({
      hit: async (c, l) => ledger.hit(c, l),
      reserveIfUnder: async (b, u, l) => { const ok = ledger.reserveIfUnder(b, u, l); if (ok) charges.push([b, u]); return ok; },
      charge: async (b, u) => { charges.push([b, u]); ledger.charge(b, u); },
    }) },
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
  // Every model, "completion"-style ones included, goes to /chat/completions: OpenRouter has no separate legacy route.
  await handle(post('/api/generate', { model: 'openai/gpt-3.5-turbo-instruct', prompt: 'hi' }, { cookie: await cookie(env) }), env, ctx);
  assert.equal(seen.url, 'https://up/api/v1/chat/completions');
  assert.equal(seen.init.headers.Authorization, 'Bearer k');
  assert.deepEqual(JSON.parse(seen.init.body).messages, [{ role: 'user', content: 'hi' }]);
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
  assert.equal(env._charges.length, 0, 'a refused reservation charges nothing');
  const ok = await handle(post('/api/generate', { model: 'openai/gpt-4o-mini', prompt: 'hi' }, { cookie: c }), env, ctx);
  assert.equal(ok.status, 200);
});
test('budget check and reservation are one atomic ledger call', async () => {
  const env = makeEnv(); const calls = [];
  const inner = env.LEDGER.getByName();
  env.LEDGER = { getByName: () => new Proxy(inner, { get: (t, k) => { if (k === 'canSpend') return undefined; if (typeof t[k] === 'function') return (...a) => { calls.push(k); return t[k](...a); }; return t[k]; } }) };
  const r = await handle(post('/api/generate', { model: 'openai/gpt-4o-mini', prompt: 'hi' }, { cookie: await cookie(env) }), env, ctx);
  assert.equal(r.status, 200); await r.text();
  assert.equal(calls.filter(k => k === 'reserveIfUnder').length, 1);
  assert.ok(Math.abs(net(env._charges) - FIXTURE_COST) < 1e-15, 'reservation + reconciliation still net to the real cost');
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
test('upstream !ok → the real provider error is logged server-side (never to the client), and a 429 Retry-After is forwarded', async (t) => {
  const errSpy = t.mock.method(console, 'error', () => {});
  const body = new ReadableStream({ pull(c) { c.enqueue(new TextEncoder().encode('{"error":"logprobs is not supported for this model"}')); c.close(); } });
  const env = makeEnv({ fetchUpstream: async () => new Response(body, { status: 429, headers: { 'retry-after': '17' } }) });
  const r = await handle(post('/api/generate', { model: 'openai/gpt-4o-mini', prompt: 'hi' }, { cookie: await cookie(env) }), env, ctx);
  assert.equal(r.status, 502); assert.equal(r.headers.get('retry-after'), '17');
  const j = await r.json(); assert.doesNotMatch(j.message, /logprobs is not supported/);
  const call = errSpy.mock.calls.find(c => c.arguments[0] === 'generate: upstream returned');
  assert.ok(call, 'expected the upstream status and body excerpt to be logged');
  assert.equal(call.arguments[1], 429);
  assert.match(call.arguments[2], /logprobs is not supported/);

  const env2 = makeEnv({ fetchUpstream: async () => new Response('x', { status: 500 }) });
  const r2 = await handle(post('/api/generate', { model: 'openai/gpt-4o-mini', prompt: 'hi' }, { cookie: await cookie(env2) }), env2, ctx);
  assert.equal(r2.headers.get('retry-after'), null);
});
test('upstream !ok with an oversized body → excerpt is capped and the remainder is abandoned', async (t) => {
  const errSpy = t.mock.method(console, 'error', () => {});
  let cancelled = false, pulls = 0;
  const body = new ReadableStream({
    pull(c) { pulls += 1; c.enqueue(new TextEncoder().encode('x'.repeat(500))); },
    cancel() { cancelled = true; },
  });
  const env = makeEnv({ fetchUpstream: async () => new Response(body, { status: 400 }) });
  const r = await handle(post('/api/generate', { model: 'openai/gpt-4o-mini', prompt: 'hi' }, { cookie: await cookie(env) }), env, ctx);
  assert.equal(r.status, 502);
  assert.equal(cancelled, true);
  const call = errSpy.mock.calls.find(c => c.arguments[0] === 'generate: upstream returned');
  assert.ok(call.arguments[2].length <= 2000);
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
test('GET /api/session → 401 without a valid cookie, 204 with one', async () => {
  const env = makeEnv();
  assert.equal((await handle(new Request('https://x/api/session'), env, ctx)).status, 401);
  assert.equal((await handle(new Request('https://x/api/session', { headers: { cookie: 'sess=garbage' } }), env, ctx)).status, 401);
  assert.equal((await handle(new Request('https://x/api/session', { headers: { cookie: await cookie(env) } }), env, ctx)).status, 204);
});
test('unknown /api path → 404 JSON, not an asset', async () => {
  const r = await handle(new Request('https://x/api/nope'), makeEnv(), ctx);
  assert.equal(r.status, 404); assert.match(r.headers.get('content-type'), /json/);
  assert.equal((await r.json()).message, 'Not found.');
});
test('missing secrets → 500 "Server is not configured." on /api/*, but assets still serve', async () => {
  for (const missing of ['PASSCODE', 'COOKIE_SECRET', 'OPENROUTER_API_KEY']) {
    const env = makeEnv({ [missing]: undefined });
    const r = await handle(post('/api/auth', { passcode: 'test' }), env, ctx);
    assert.equal(r.status, 500, missing); assert.equal((await r.json()).message, 'Server is not configured.');
    assert.equal((await handle(new Request('https://x/api/models'), env, ctx)).status, 500, missing);
    assert.equal(await (await handle(new Request('https://x/index.html'), env, ctx)).text(), 'asset', missing);
  }
  const env = makeEnv({ PASSCODE: '' });
  assert.equal((await handle(post('/api/auth', { passcode: '' }), env, ctx)).status, 500, 'empty passcode counts as missing');
});
test('per-IP limit on /api/generate cannot be escaped by re-authenticating', async () => {
  const env = makeEnv({ PER_IP_PER_MINUTE: '1', PER_CLIENT_PER_MINUTE: '30' });
  const h = (c) => ({ cookie: c, 'cf-connecting-ip': '9.9.9.9' });
  const ok = await handle(post('/api/generate', { model: 'openai/gpt-4o-mini', prompt: 'hi' }, h(await cookie(env))), env, ctx);
  assert.equal(ok.status, 200);
  const r = await handle(post('/api/generate', { model: 'openai/gpt-4o-mini', prompt: 'hi' }, h(await cookie(env))), env, ctx);
  assert.equal(r.status, 429); assert.ok(r.headers.get('retry-after'));
  const other = await handle(post('/api/generate', { model: 'openai/gpt-4o-mini', prompt: 'hi' }, { cookie: await cookie(env), 'cf-connecting-ip': '8.8.8.8' }), env, ctx);
  assert.equal(other.status, 200, 'a different IP is unaffected');
});
test('an IP-limited request does not consume a per-client slot', async () => {
  const env = makeEnv({ PER_IP_PER_MINUTE: '1', PER_CLIENT_PER_MINUTE: '1' });
  const c = await cookie(env);
  const fromA = (ck) => ({ cookie: ck, 'cf-connecting-ip': '5.5.5.5' });
  assert.equal((await handle(post('/api/generate', { model: 'openai/gpt-4o-mini', prompt: 'hi' }, fromA(await cookie(env))), env, ctx)).status, 200, 'another client uses up IP A');
  const blocked = await handle(post('/api/generate', { model: 'openai/gpt-4o-mini', prompt: 'hi' }, fromA(c)), env, ctx);
  assert.equal(blocked.status, 429); assert.match((await blocked.json()).message, /network/i);
  const fromB = await handle(post('/api/generate', { model: 'openai/gpt-4o-mini', prompt: 'hi' }, { cookie: c, 'cf-connecting-ip': '6.6.6.6' }), env, ctx);
  assert.equal(fromB.status, 200, 'the IP-limited attempt did not spend the client\'s only slot');
});
test('per-IP limit defaults to 60 when the var is unset', async () => {
  const env = makeEnv({ PER_IP_PER_MINUTE: undefined, PER_CLIENT_PER_MINUTE: '100' });
  const h = (c) => ({ cookie: c, 'cf-connecting-ip': '7.7.7.7' });
  let last;
  for (let i = 0; i < 61; i++) last = await handle(post('/api/generate', { model: 'openai/gpt-4o-mini', prompt: 'hi' }, h(await cookie(env))), env, ctx);
  assert.equal(last.status, 429);
});

// End to end against the real mock upstream (tools/mock_openrouter.mjs) over loopback HTTP.
test('end to end: Worker streams normalized events from the mock for chat and completions models, and charges its cost', async () => {
  const server = await startMock(0, { tokenMs: 1 });
  try {
    const base = `http://127.0.0.1:${server.address().port}`;
    for (const modelId of ['openai/gpt-4o-mini', 'openai/gpt-3.5-turbo-instruct']) {
      const env = makeEnv({ fetchUpstream: fetch, OPENROUTER_BASE_URL: base });
      const prompt = 'The patient presented with';
      const r = await handle(post('/api/generate', { model: modelId, prompt }, { cookie: await cookie(env) }), env, ctx);
      assert.equal(r.status, 200, modelId);
      const events = (await r.text()).split('\n\n').filter(Boolean).map(l => JSON.parse(l.replace(/^data: /, '')));
      const tokens = events.filter(e => e.type === 'token');
      assert.ok(tokens.length >= 10 && tokens.length <= 20, `${modelId}: 10–20 tokens, got ${tokens.length}`);
      assert.equal(tokens[0].top.length, 5, `${modelId}: five alternatives on the first token`);
      const done = events.at(-1);
      assert.equal(done.type, 'done');
      // Coupled to the mock's pricing rule on purpose: tools/mock_openrouter.mjs sets usage.prompt_tokens to
      // ceil(promptChars / 4), completion_tokens to the number of streamed tokens, and usage.cost to
      // estimateCost(model, ...) from site/models.js. Recomputing it here (instead of trusting a cost read back from
      // the stream) proves the Worker passed the upstream cost through untouched and charged exactly that amount.
      // If the mock's formula changes, update this line with it.
      const expected = estimateCost(getModel(modelId), Math.ceil(prompt.length / 4), tokens.length);
      assert.ok(Math.abs(done.cost - expected) < 1e-15, `${modelId}: done.cost ${done.cost} vs mock ${expected}`);
      assert.ok(Math.abs(net(env._charges, getModel(modelId).bucket) - expected) < 1e-15, `${modelId}: net charges equal the mock's cost`);
    }
  } finally {
    server.closeAllConnections?.();
    await new Promise(r => server.close(r));
  }
});
