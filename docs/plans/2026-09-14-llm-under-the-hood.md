# LLM Under the Hood — Implementation Plan

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.
> Before any Worker or wrangler work, also load the `workers-best-practices`, `durable-objects`, and `wrangler` skills.
> Before writing chapter UI, load `artifact-design` style guidance is NOT needed (this is a normal static site), but do read `docs/plans/2026-09-14-llm-under-the-hood-design.md` section 4 for the chapter content.

**Goal:** A passcode-gated web explainer where a student types a ≤200-character prompt and watches it flow through tokens → embeddings → attention → next-token probabilities → autocomplete-vs-assistant → era comparison, powered by real models via OpenRouter behind a Cloudflare Worker.

**Architecture:** One Cloudflare Worker serves the static `site/` (assets binding) and two API routes (`/api/auth`, `/api/generate`). The Worker validates requests against a shared model allowlist, enforces rate and spend caps through a single Durable Object ledger, proxies to OpenRouter (chat or completion endpoint), and streams back a normalized SSE event shape. The frontend is plain ES modules with a tiny store; six chapter modules subscribe to the store and render.

**Tech Stack:** Cloudflare Workers + static assets + Durable Objects (SQLite, free plan), wrangler 4, OpenRouter API, vanilla HTML/CSS/JS (no bundler), `gpt-tokenizer` vendored via esbuild, `node --test` for all tests (Node 24 has fetch/Request/Response/crypto.subtle/ReadableStream), `@huggingface/transformers` in Node for build-time embeddings, Python venv (`torch`, `transformers`) for build-time GPT-2 attention.

**Decision changes from the design doc:** (1) Tests use `node --test` for the Worker too, instead of vitest-pool-workers, by keeping Worker logic in pure modules and injecting `env` fakes. (2) Counters live in one Durable Object instead of KV, because the free KV tier allows only 1,000 writes/day. (3) Two tokenizers are vendored (o200k for 4o/5-era, cl100k for gpt-3.5/gpt-4) so the tokens chapter is exact for OpenAI models; other models use o200k with a caption that they slice differently.

**Post-review corrections (Tasks 5/8):** A code review after Tasks 5 and 8 landed changed four behaviours; the task code blocks below are the original drafts, so read them with these in mind. (1) `buildUpstream` always sends `stream: true` upstream; for `stream:false` the router collects the normalized events and returns `{events}` as JSON. (2) Spend is reserve-then-reconcile: before the upstream call the router charges `estimateCost(model, ceil(promptChars/3), maxTokens)`, then on the `done` event charges `cost - reserved` (refunded outright if upstream fails), so a disconnect can only over-count, never under-count. (3) The upstream stream is drained by a pump under `ctx.waitUntil`, independent of the client-facing stream, so `done` (and the charge) is reached even when the client cancels; `normalizeUpstream` always emits `done`, estimating usage when upstream omits it and marking streams that end without `[DONE]` as `finish: 'truncated'`. (4) `/api/generate` also applies a per-IP limit via the new `PER_IP_PER_MINUTE` var (default 60) so re-authenticating cannot escape the per-client limit; the passcode compare is over HMAC digests so the length does not leak; missing secrets return 500 "Server is not configured." on `/api/*` only.

**Later deviations from the design (pre-handoff):** The wrong-passcode limit is 10 per IP per minute, not per hour as the design said. Chapter 5 shows the top-3 first-token texts ("First guesses: a · b · c"), not percentages. Chapter 6 runs exactly three panes. A failed pane offers a per-pane Retry instead of marking the model "unavailable for the session". Chat continuation (Keep going, Step, Resume, Fork) sends the text so far as an assistant message followed by an explicit "continue your previous message" user message (`CONTINUE_INSTRUCTION` in `worker/src/openrouter.js`), because chat models do not reliably continue a trailing assistant turn. Model entries may carry per-model `upstream: { omit, extra }` request params; gpt-5-mini uses them to drop `temperature` and send `reasoning: { effort: 'minimal' }`.

**Real-model finding (2026-09-15, after secrets were set):** `openai/gpt-3.5-turbo-instruct` failed every real call with a 400 "Missing required parameter: 'prompt'." Local testing never caught this because the mock happily answered whatever URL our code asked for. OpenRouter's actual API (confirmed against `openrouter.ai/openapi.json`) has no separate legacy `/completions` route at all any more: every model, including old completion-only ones, is called through `/chat/completions`. `buildUpstream` now sends a `endpoint: 'completion'` model there too, wrapped in one `user` message (system + prompt + prefix folded into its content, no separate chat turns), with the current `logprobs: true, top_logprobs: N` fields instead of the legacy integer `logprobs` field. Response parsing is now always chat-shaped (`chatTokens`); the legacy `completionTokens` parser and its fixture were removed as dead code. This was diagnosed live: the Worker previously cancelled a non-OK upstream response without reading it, so `readExcerpt()` (`worker/src/openrouter.js`) was added first to log up to 2000 bytes of a real provider error server-side (never to the client) before the actual cause could be seen.

**Verified facts (2026-09-14):** `gpt-tokenizer@4.0.0` bundles with esbuild to a single ESM file (o200k 2.7 MB raw / 1.0 MB gzip, cl100k 1.0 MB raw); `Xenova/all-MiniLM-L6-v2` via `@huggingface/transformers@4.2.0` embeds words in Node in ~3 s; transformers.js GPT-2 ONNX does **not** expose attentions, so attention data must come from Python. OpenRouter model ids and logprobs support are in the design doc §4.3. Wrangler 4.131 is logged in; `gh` is logged in as `smcubed`.

**Conventions:** Commit after every task with a short imperative message ending in `Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>`. Run `npm test` before each commit. All paths below are relative to the project root `/Users/smcgrath/Desktop/UC Davis AI course/llm-under-the-hood`. Never commit `.dev.vars` or any key.

---

## Phase 0 — Scaffold

### Task 1: Project skeleton, scripts, wrangler config

**Files:**
- Create: `package.json`, `wrangler.jsonc`, `.gitignore`, `.dev.vars.example`, `README.md`
- Create dirs: `site/`, `site/chapters/`, `site/data/`, `site/vendor/`, `worker/src/`, `tools/`, `tests/`, `tests/fixtures/`

**Step 1: package.json**

```json
{
  "name": "llm-under-the-hood",
  "private": true,
  "type": "module",
  "scripts": {
    "test": "node --test tests/",
    "dev": "wrangler dev --port 8787",
    "mock": "node tools/mock_openrouter.mjs",
    "deploy": "wrangler deploy",
    "vendor:tokenizers": "sh tools/vendor_tokenizers.sh",
    "data:embeddings": "node tools/build_embeddings.mjs",
    "data:attention": ".venv/bin/python tools/build_attention.py"
  },
  "devDependencies": {
    "wrangler": "^4.131.0",
    "esbuild": "^0.24.2",
    "gpt-tokenizer": "^4.0.0",
    "@huggingface/transformers": "^4.2.0"
  }
}
```

**Step 2: wrangler.jsonc**

```jsonc
{
  "$schema": "node_modules/wrangler/config-schema.json",
  "name": "llm-under-the-hood",
  "main": "worker/src/index.js",
  "compatibility_date": "2026-09-01",
  "assets": { "directory": "./site", "binding": "ASSETS" },
  "durable_objects": {
    "bindings": [{ "name": "LEDGER", "class_name": "LedgerObject" }]
  },
  "migrations": [{ "tag": "v1", "new_sqlite_classes": ["LedgerObject"] }],
  "vars": {
    "DAILY_BUDGET_USD": "5",
    "GPT4_DAILY_BUDGET_USD": "1",
    "PER_CLIENT_PER_MINUTE": "30",
    "AUTH_ATTEMPTS_PER_MINUTE": "10",
    "OPENROUTER_BASE_URL": "https://openrouter.ai/api/v1",
    "SITE_TITLE": "LLM Under the Hood"
  },
  "observability": { "enabled": true }
}
```
Secrets (never in this file): `OPENROUTER_API_KEY`, `PASSCODE`, `COOKIE_SECRET`.

**Step 3: .gitignore and .dev.vars.example**

`.gitignore`:
```
node_modules/
.wrangler/
.dev.vars
.venv/
.DS_Store
```
`.dev.vars.example` (copy to `.dev.vars` for local dev):
```
OPENROUTER_API_KEY=mock
OPENROUTER_BASE_URL=http://127.0.0.1:8788
PASSCODE=test
COOKIE_SECRET=dev-secret-change-me
```

**Step 4: README.md** — three paragraphs: what it is, `npm install && cp .dev.vars.example .dev.vars && npm run mock` in one terminal and `npm run dev` in another, then open `http://127.0.0.1:8787` and use passcode `test`; tests `npm test`; deploy `npm run deploy`. Link the design doc.

**Step 5: Install and smoke**

Run: `npm install` then `npm test`
Expected: `npm test` exits 0 with "tests 0" (empty directory is fine; if node complains about no files, add `tests/smoke.test.mjs` asserting `1+1===2`).

**Step 6: Commit** — `git add -A && git commit -m "Scaffold project, scripts, wrangler config"`

---

## Phase 1 — Shared config and pure logic (TDD)

### Task 2: Model ladder config (shared by site and Worker)

**Files:**
- Create: `site/models.js`
- Test: `tests/models.test.mjs`

**Step 1: Failing test**

```js
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { MODELS, DEFAULT_MODEL, LIMITS, getModel } from '../site/models.js';

test('ladder has the eight approved models with required fields', () => {
  const ids = MODELS.map(m => m.id);
  assert.deepEqual(ids, [
    'openai/gpt-3.5-turbo-instruct', 'openai/gpt-3.5-turbo', 'openai/gpt-4', 'openai/gpt-4o-mini',
    'anthropic/claude-haiku-4.5', 'openai/gpt-5-mini', 'google/gemini-3.5-flash-lite',
    'meta-llama/llama-3.3-70b-instruct',
  ]);
  for (const m of MODELS) {
    for (const k of ['id','label','year','provider','open','logprobs','endpoint','tokenizer','bucket','price'])
      assert.ok(k in m, `${m.id} missing ${k}`);
    assert.ok(['chat','completion'].includes(m.endpoint));
    assert.ok(['o200k','cl100k'].includes(m.tokenizer));
    assert.equal(typeof m.price.in, 'number'); assert.equal(typeof m.price.out, 'number');
  }
});
test('default model exists and supports logprobs', () => {
  assert.equal(getModel(DEFAULT_MODEL).logprobs, true);
});
test('getModel returns undefined for unknown id', () => assert.equal(getModel('nope/x'), undefined));
test('limits are the design values', () => {
  assert.deepEqual(LIMITS, { promptChars: 200, systemChars: 400, prefixChars: 1500, maxTokens: 200, topLogprobs: 10, temperatureMax: 1.5 });
});
```

**Step 2:** Run `npm test` → FAIL (cannot find module).

**Step 3: Implementation** — `site/models.js` (prices are USD per million tokens, from OpenRouter on 2026-09-14):

```js
export const LIMITS = { promptChars: 200, systemChars: 400, prefixChars: 1500, maxTokens: 200, topLogprobs: 10, temperatureMax: 1.5 };

export const MODELS = [
  { id: 'openai/gpt-3.5-turbo-instruct', label: 'GPT-3.5 Instruct (autocomplete)', short: 'GPT-3.5 instruct', year: 2022, provider: 'OpenAI', open: false, logprobs: true, endpoint: 'completion', tokenizer: 'cl100k', bucket: 'default', price: { in: 1.5, out: 2.0 },
    blurb: 'A completion model from before ChatGPT. It does not answer you; it continues your text.' },
  { id: 'openai/gpt-3.5-turbo', label: 'ChatGPT 3.5 (2023)', short: 'GPT-3.5', year: 2023, provider: 'OpenAI', open: false, logprobs: true, endpoint: 'chat', tokenizer: 'cl100k', bucket: 'default', price: { in: 0.5, out: 1.5 },
    blurb: 'The model behind the original ChatGPT launch.' },
  { id: 'openai/gpt-4', label: 'GPT-4 (2023)', short: 'GPT-4', year: 2023, provider: 'OpenAI', open: false, logprobs: true, endpoint: 'chat', tokenizer: 'cl100k', bucket: 'gpt4', price: { in: 30, out: 60 },
    blurb: 'The first frontier model. Still expensive: about 100× the price of GPT-4o mini.' },
  { id: 'openai/gpt-4o-mini', label: 'GPT-4o mini (2024)', short: 'GPT-4o mini', year: 2024, provider: 'OpenAI', open: false, logprobs: true, endpoint: 'chat', tokenizer: 'o200k', bucket: 'default', price: { in: 0.15, out: 0.6 },
    blurb: 'A small, cheap modern model that still shows its probabilities.' },
  { id: 'anthropic/claude-haiku-4.5', label: 'Claude Haiku 4.5 (2025)', short: 'Haiku 4.5', year: 2025, provider: 'Anthropic', open: false, logprobs: false, endpoint: 'chat', tokenizer: 'o200k', bucket: 'default', price: { in: 1, out: 5 },
    blurb: 'Anthropic\'s fast model. Does not share its probabilities.' },
  { id: 'openai/gpt-5-mini', label: 'GPT-5 mini (2026)', short: 'GPT-5 mini', year: 2026, provider: 'OpenAI', open: false, logprobs: false, endpoint: 'chat', tokenizer: 'o200k', bucket: 'default', price: { in: 0.25, out: 2 },
    blurb: 'A current small OpenAI model. Does not share its probabilities.' },
  { id: 'google/gemini-3.5-flash-lite', label: 'Gemini 3.5 Flash Lite (2026)', short: 'Gemini Flash Lite', year: 2026, provider: 'Google', open: false, logprobs: false, endpoint: 'chat', tokenizer: 'o200k', bucket: 'default', price: { in: 0.3, out: 2.5 },
    blurb: 'Google\'s fast model. Does not share its probabilities.' },
  { id: 'meta-llama/llama-3.3-70b-instruct', label: 'Llama 3.3 70B (open weights)', short: 'Llama 3.3', year: 2024, provider: 'Meta', open: true, logprobs: true, endpoint: 'chat', tokenizer: 'o200k', bucket: 'default', price: { in: 0.1, out: 0.32 },
    blurb: 'Open weights: anyone can download and run it. Uses its own tokenizer, so token counts differ.' },
];

export const DEFAULT_MODEL = 'openai/gpt-4o-mini';
export const AUTOCOMPLETE_MODEL = 'openai/gpt-3.5-turbo-instruct';

export function getModel(id) { return MODELS.find(m => m.id === id); }

/** Estimated USD for a call when the upstream did not report cost. */
export function estimateCost(model, promptTokens, completionTokens) {
  return (promptTokens * model.price.in + completionTokens * model.price.out) / 1e6;
}
```

**Step 4:** `npm test` → PASS. **Step 5:** Commit `Add shared model ladder config`.

### Task 3: Probability math (`site/probs.js`)

**Files:** Create `site/probs.js`; Test `tests/probs.test.mjs`.

**Step 1: Failing tests**

```js
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { withProbs, rescale, sample, band } from '../site/probs.js';

const top = [ { text: ' CT', logprob: Math.log(0.6) }, { text: ' MRI', logprob: Math.log(0.3) }, { text: ' X', logprob: Math.log(0.05) } ];

test('withProbs adds p=exp(logprob) and an "other" remainder', () => {
  const r = withProbs(top);
  assert.ok(Math.abs(r.items[0].p - 0.6) < 1e-9);
  assert.ok(Math.abs(r.other - 0.05) < 1e-9);
  assert.equal(r.items.length, 3);
});
test('withProbs clamps other to >= 0 when rounding overshoots', () => {
  const r = withProbs([{ text: 'a', logprob: 0 }, { text: 'b', logprob: -0.0001 }]);
  assert.equal(r.other, 0);
});
test('rescale at T=1 renormalizes the shown set to sum 1, preserving order', () => {
  const r = rescale(top, 1);
  const sum = r.reduce((s, x) => s + x.p, 0);
  assert.ok(Math.abs(sum - 1) < 1e-9);
  assert.equal(r[0].text, ' CT');
  assert.ok(Math.abs(r[0].p - 0.6 / 0.95) < 1e-9);
});
test('rescale at T→0 gives the top token everything', () => {
  const r = rescale(top, 0);
  assert.equal(r[0].p, 1); assert.equal(r[1].p, 0);
});
test('rescale at high T flattens toward uniform', () => {
  const r = rescale(top, 1.5);
  assert.ok(r[0].p < 0.6 / 0.95); assert.ok(r[2].p > 0.05 / 0.95);
});
test('sample picks by cumulative probability using the supplied random', () => {
  const dist = rescale(top, 1);
  assert.equal(sample(dist, () => 0.0).text, ' CT');
  assert.equal(sample(dist, () => 0.7).text, ' MRI');
  assert.equal(sample(dist, () => 0.999).text, ' X');
});
test('band thresholds', () => {
  assert.equal(band(0.9), 'high'); assert.equal(band(0.6), 'high');
  assert.equal(band(0.4), 'mid'); assert.equal(band(0.25), 'mid');
  assert.equal(band(0.1), 'low'); assert.equal(band(null), 'unknown');
});
```

**Step 2:** run → FAIL. **Step 3: Implementation**

```js
/** top: [{text, logprob}] as returned by the API (natural-log probabilities). */
export function withProbs(top) {
  const items = top.map(t => ({ ...t, p: Math.exp(t.logprob) }));
  const shown = items.reduce((s, x) => s + x.p, 0);
  return { items, other: Math.max(0, 1 - shown) };
}

/** Softmax over the shown candidates at a given temperature. T=0 → argmax. */
export function rescale(top, temperature) {
  if (!top.length) return [];
  if (temperature <= 0) {
    const maxI = top.reduce((bi, x, i, a) => (x.logprob > a[bi].logprob ? i : bi), 0);
    return top.map((t, i) => ({ text: t.text, p: i === maxI ? 1 : 0 }));
  }
  const scaled = top.map(t => t.logprob / temperature);
  const m = Math.max(...scaled);
  const exps = scaled.map(s => Math.exp(s - m));
  const z = exps.reduce((a, b) => a + b, 0);
  return top.map((t, i) => ({ text: t.text, p: exps[i] / z }));
}

/** dist: [{text, p}] summing to ~1. random: () => [0,1). */
export function sample(dist, random = Math.random) {
  const r = random();
  let acc = 0;
  for (const d of dist) { acc += d.p; if (r < acc) return d; }
  return dist[dist.length - 1];
}

export function band(p) {
  if (p == null || Number.isNaN(p)) return 'unknown';
  if (p >= 0.6) return 'high';
  if (p >= 0.25) return 'mid';
  return 'low';
}
```

**Step 4:** PASS. **Step 5:** Commit `Add probability math module`.

### Task 4: Request validation (`worker/src/validate.js`)

**Files:** Create `worker/src/validate.js`; Test `tests/validate.test.mjs`.

Behavior: accepts the client JSON body, returns `{ ok: true, value }` or `{ ok: false, status: 400, message }`. `value` = `{ model (object), prompt, system, prefix, maxTokens, temperature, topLogprobs, stream }`. `prefix` is text already generated (used for forking); for chat models it becomes a partial assistant message, for completion models it is appended to the prompt.

**Step 1: Failing tests**

```js
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { validateGenerate } from '../worker/src/validate.js';

const good = { model: 'openai/gpt-4o-mini', prompt: 'The patient presented with', maxTokens: 50, temperature: 0.7, topLogprobs: 5, stream: true };

test('accepts a valid body and resolves the model', () => {
  const r = validateGenerate(good);
  assert.equal(r.ok, true);
  assert.equal(r.value.model.id, 'openai/gpt-4o-mini');
  assert.equal(r.value.system, '');
  assert.equal(r.value.prefix, '');
});
test('rejects unknown model', () => {
  const r = validateGenerate({ ...good, model: 'openai/gpt-4.1' });
  assert.equal(r.ok, false); assert.equal(r.status, 400); assert.match(r.message, /model/i);
});
test('rejects prompt over 200 chars and empty prompt', () => {
  assert.equal(validateGenerate({ ...good, prompt: 'x'.repeat(201) }).ok, false);
  assert.equal(validateGenerate({ ...good, prompt: '   ' }).ok, false);
});
test('rejects system over 400 and prefix over 1500', () => {
  assert.equal(validateGenerate({ ...good, system: 'x'.repeat(401) }).ok, false);
  assert.equal(validateGenerate({ ...good, prefix: 'x'.repeat(1501) }).ok, false);
});
test('clamps maxTokens, topLogprobs, temperature into range', () => {
  const r = validateGenerate({ ...good, maxTokens: 999, topLogprobs: 50, temperature: 9 });
  assert.equal(r.value.maxTokens, 200); assert.equal(r.value.topLogprobs, 10); assert.equal(r.value.temperature, 1.5);
  const r2 = validateGenerate({ ...good, maxTokens: 0, topLogprobs: -1, temperature: -1 });
  assert.equal(r2.value.maxTokens, 1); assert.equal(r2.value.topLogprobs, 0); assert.equal(r2.value.temperature, 0);
});
test('defaults: maxTokens 120, temperature 0.7, topLogprobs 5, stream true', () => {
  const r = validateGenerate({ model: 'openai/gpt-4o-mini', prompt: 'hi' });
  assert.deepEqual([r.value.maxTokens, r.value.temperature, r.value.topLogprobs, r.value.stream], [120, 0.7, 5, true]);
});
test('forces topLogprobs to 0 for models without logprobs', () => {
  const r = validateGenerate({ ...good, model: 'anthropic/claude-haiku-4.5' });
  assert.equal(r.value.topLogprobs, 0);
});
test('rejects non-object and non-string fields', () => {
  assert.equal(validateGenerate(null).ok, false);
  assert.equal(validateGenerate({ ...good, prompt: 42 }).ok, false);
});
```

**Step 3: Implementation**

```js
import { getModel, LIMITS } from '../../site/models.js';

const clamp = (n, lo, hi, dflt) => {
  const x = typeof n === 'number' && Number.isFinite(n) ? n : dflt;
  return Math.min(hi, Math.max(lo, x));
};
const bad = (message) => ({ ok: false, status: 400, message });

export function validateGenerate(body) {
  if (!body || typeof body !== 'object') return bad('Request body must be an object.');
  const model = getModel(body.model);
  if (!model) return bad('That model is not available here.');
  if (typeof body.prompt !== 'string' || !body.prompt.trim()) return bad('Please type a prompt first.');
  if (body.prompt.length > LIMITS.promptChars) return bad(`Prompts are limited to ${LIMITS.promptChars} characters.`);
  const system = body.system == null ? '' : body.system;
  const prefix = body.prefix == null ? '' : body.prefix;
  if (typeof system !== 'string' || system.length > LIMITS.systemChars) return bad(`System prompts are limited to ${LIMITS.systemChars} characters.`);
  if (typeof prefix !== 'string' || prefix.length > LIMITS.prefixChars) return bad('That continuation is too long to fork from.');
  return {
    ok: true,
    value: {
      model,
      prompt: body.prompt,
      system,
      prefix,
      maxTokens: Math.round(clamp(body.maxTokens, 1, LIMITS.maxTokens, 120)),
      temperature: clamp(body.temperature, 0, LIMITS.temperatureMax, 0.7),
      topLogprobs: model.logprobs ? Math.round(clamp(body.topLogprobs, 0, LIMITS.topLogprobs, 5)) : 0,
      stream: body.stream !== false,
    },
  };
}
```

**Step 4:** PASS. **Step 5:** Commit `Add generate request validation`.

### Task 5: OpenRouter request building and SSE normalization (`worker/src/openrouter.js`)

**Files:** Create `worker/src/openrouter.js`; Test `tests/openrouter.test.mjs`; Fixtures `tests/fixtures/chat_logprobs.sse`, `tests/fixtures/chat_plain.sse`, `tests/fixtures/completion_logprobs.sse`.

Normalized event shape (the only shape the frontend ever sees):
- `{ type: 'token', text, logprob, top }` — `logprob` is a number or `null`; `top` is `[{text, logprob}]` or `null`.
- `{ type: 'done', usage: { prompt, completion }, cost, finish }` — `cost` in USD (upstream-reported or estimated), `finish` = upstream finish_reason or `null`.
- `{ type: 'error', message }`.

**Step 1: Fixtures.** Write these by hand in OpenAI-compatible SSE format (each `data:` line is one JSON object; blank line between events; final `data: [DONE]`).

`tests/fixtures/chat_logprobs.sse`:
```
data: {"id":"gen-1","choices":[{"index":0,"delta":{"role":"assistant","content":""},"logprobs":null,"finish_reason":null}]}

data: {"id":"gen-1","choices":[{"index":0,"delta":{"content":" CT"},"logprobs":{"content":[{"token":" CT","logprob":-0.51,"top_logprobs":[{"token":" CT","logprob":-0.51},{"token":" MRI","logprob":-1.2},{"token":" chest","logprob":-2.99}]}]},"finish_reason":null}]}

data: {"id":"gen-1","choices":[{"index":0,"delta":{"content":" scan"},"logprobs":{"content":[{"token":" scan","logprob":-0.01,"top_logprobs":[{"token":" scan","logprob":-0.01},{"token":" imaging","logprob":-4.6}]}]},"finish_reason":null}]}

data: {"id":"gen-1","choices":[{"index":0,"delta":{},"logprobs":null,"finish_reason":"stop"}],"usage":{"prompt_tokens":12,"completion_tokens":2,"total_tokens":14,"cost":0.0000030}}

data: [DONE]

```

`tests/fixtures/chat_plain.sse` (no logprobs, e.g. Claude):
```
data: {"id":"gen-2","choices":[{"index":0,"delta":{"role":"assistant","content":""},"finish_reason":null}]}

data: {"id":"gen-2","choices":[{"index":0,"delta":{"content":"A CT"},"finish_reason":null}]}

data: {"id":"gen-2","choices":[{"index":0,"delta":{"content":" scan is"},"finish_reason":null}]}

data: {"id":"gen-2","choices":[{"index":0,"delta":{},"finish_reason":"stop"}],"usage":{"prompt_tokens":12,"completion_tokens":4,"total_tokens":16}}

data: [DONE]

```

`tests/fixtures/completion_logprobs.sse` (legacy completions format):
```
data: {"id":"cmpl-1","choices":[{"index":0,"text":" chest","logprobs":{"tokens":[" chest"],"token_logprobs":[-0.3],"top_logprobs":[{" chest":-0.3," CT":-1.5," a":-2.2}]},"finish_reason":null}]}

data: {"id":"cmpl-1","choices":[{"index":0,"text":" pain","logprobs":{"tokens":[" pain"],"token_logprobs":[-0.05],"top_logprobs":[{" pain":-0.05," X":-3.9}]},"finish_reason":null}]}

data: {"id":"cmpl-1","choices":[{"index":0,"text":"","logprobs":{"tokens":[],"token_logprobs":[],"top_logprobs":[]},"finish_reason":"length"}],"usage":{"prompt_tokens":6,"completion_tokens":2,"total_tokens":8}}

data: [DONE]

```

**Step 2: Failing tests**

```js
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { buildUpstream, normalizeUpstream, parseSSE } from '../worker/src/openrouter.js';
import { getModel } from '../site/models.js';

const fx = (n) => readFile(new URL(`./fixtures/${n}`, import.meta.url), 'utf8');
const base = { prompt: 'The patient presented with', system: '', prefix: '', maxTokens: 50, temperature: 0.7, topLogprobs: 5, stream: true };

test('buildUpstream: chat model → /chat/completions with messages, logprobs, usage', () => {
  const v = { ...base, model: getModel('openai/gpt-4o-mini') };
  const { url, body } = buildUpstream(v, 'https://openrouter.ai/api/v1');
  assert.equal(url, 'https://openrouter.ai/api/v1/chat/completions');
  assert.equal(body.model, 'openai/gpt-4o-mini');
  assert.deepEqual(body.messages, [{ role: 'user', content: 'The patient presented with' }]);
  assert.equal(body.logprobs, true); assert.equal(body.top_logprobs, 5);
  assert.equal(body.max_tokens, 50); assert.equal(body.temperature, 0.7); assert.equal(body.stream, true);
  assert.deepEqual(body.usage, { include: true });
});
test('buildUpstream: system and prefix become system + partial assistant messages', () => {
  const v = { ...base, model: getModel('openai/gpt-4o-mini'), system: 'Be brief.', prefix: ' A CT' };
  const { body } = buildUpstream(v, 'x');
  assert.deepEqual(body.messages, [
    { role: 'system', content: 'Be brief.' },
    { role: 'user', content: 'The patient presented with' },
    { role: 'assistant', content: ' A CT' },
  ]);
});
test('buildUpstream: no logprobs fields for models that lack them', () => {
  const v = { ...base, model: getModel('anthropic/claude-haiku-4.5'), topLogprobs: 0 };
  const { body } = buildUpstream(v, 'x');
  assert.equal('logprobs' in body, false); assert.equal('top_logprobs' in body, false);
});
test('buildUpstream: completion model → /completions with prompt+prefix, system prepended', () => {
  const v = { ...base, model: getModel('openai/gpt-3.5-turbo-instruct'), prefix: ' chest', system: 'Note:' };
  const { url, body } = buildUpstream(v, 'https://o/api/v1');
  assert.equal(url, 'https://o/api/v1/completions');
  assert.equal(body.prompt, 'Note:\n\nThe patient presented with chest');
  assert.equal(body.logprobs, 5); assert.equal('messages' in body, false);
});

test('parseSSE splits a buffer into data payloads and keeps the remainder', () => {
  const { events, rest } = parseSSE('data: {"a":1}\n\ndata: {"b":2}\n\ndata: {"c"');
  assert.deepEqual(events, ['{"a":1}', '{"b":2}']);
  assert.equal(rest, 'data: {"c"');
});
test('parseSSE ignores comment lines and handles CRLF', () => {
  const { events } = parseSSE(': keep-alive\r\n\r\ndata: {"x":1}\r\n\r\n');
  assert.deepEqual(events, ['{"x":1}']);
});

async function collect(fixture, modelId) {
  const text = await fx(fixture);
  const stream = new Response(text).body;
  const out = [];
  for await (const ev of normalizeUpstream(stream, getModel(modelId))) out.push(ev);
  return out;
}
test('normalize chat with logprobs → token events with top alternatives and done with cost', async () => {
  const ev = await collect('chat_logprobs.sse', 'openai/gpt-4o-mini');
  assert.equal(ev[0].type, 'token'); assert.equal(ev[0].text, ' CT'); assert.equal(ev[0].logprob, -0.51);
  assert.deepEqual(ev[0].top[1], { text: ' MRI', logprob: -1.2 });
  assert.equal(ev[1].text, ' scan');
  const done = ev.at(-1);
  assert.equal(done.type, 'done'); assert.deepEqual(done.usage, { prompt: 12, completion: 2 });
  assert.equal(done.cost, 0.000003); assert.equal(done.finish, 'stop');
  assert.equal(ev.length, 3);
});
test('normalize chat without logprobs → token events with null logprob/top, estimated cost', async () => {
  const ev = await collect('chat_plain.sse', 'anthropic/claude-haiku-4.5');
  assert.equal(ev[0].text, 'A CT'); assert.equal(ev[0].logprob, null); assert.equal(ev[0].top, null);
  const done = ev.at(-1);
  assert.ok(Math.abs(done.cost - (12 * 1 + 4 * 5) / 1e6) < 1e-12);
});
test('normalize completion with logprobs → top from object map, finish length', async () => {
  const ev = await collect('completion_logprobs.sse', 'openai/gpt-3.5-turbo-instruct');
  assert.equal(ev[0].text, ' chest'); assert.equal(ev[0].logprob, -0.3);
  assert.deepEqual(ev[0].top, [{ text: ' chest', logprob: -0.3 }, { text: ' CT', logprob: -1.5 }, { text: ' a', logprob: -2.2 }]);
  assert.equal(ev.at(-1).finish, 'length');
});
test('normalize surfaces an upstream error object as an error event', async () => {
  const stream = new Response('data: {"error":{"message":"Rate limited","code":429}}\n\n').body;
  const out = []; for await (const e of normalizeUpstream(stream, getModel('openai/gpt-4o-mini'))) out.push(e);
  assert.deepEqual(out, [{ type: 'error', message: 'Rate limited' }]);
});
```

**Step 3: Implementation**

```js
import { estimateCost } from '../../site/models.js';

export function buildUpstream(v, baseUrl) {
  const m = v.model;
  const common = { model: m.id, max_tokens: v.maxTokens, temperature: v.temperature, stream: v.stream, usage: { include: true } };
  if (m.endpoint === 'completion') {
    const prompt = (v.system ? v.system + '\n\n' : '') + v.prompt + v.prefix;
    const body = { ...common, prompt };
    if (m.logprobs && v.topLogprobs > 0) body.logprobs = v.topLogprobs;
    return { url: `${baseUrl}/completions`, body };
  }
  const messages = [];
  if (v.system) messages.push({ role: 'system', content: v.system });
  messages.push({ role: 'user', content: v.prompt });
  if (v.prefix) messages.push({ role: 'assistant', content: v.prefix });
  const body = { ...common, messages };
  if (m.logprobs && v.topLogprobs > 0) { body.logprobs = true; body.top_logprobs = v.topLogprobs; }
  return { url: `${baseUrl}/chat/completions`, body };
}

/** Split accumulated SSE text into complete `data:` payloads. */
export function parseSSE(buffer) {
  const events = [];
  const normalized = buffer.replace(/\r\n/g, '\n');
  const parts = normalized.split('\n\n');
  const rest = parts.pop();
  for (const block of parts) {
    for (const line of block.split('\n')) {
      if (line.startsWith('data:')) events.push(line.slice(5).trim());
    }
  }
  return { events, rest };
}

function chatTokens(choice) {
  const lp = choice.logprobs?.content;
  if (Array.isArray(lp) && lp.length) {
    return lp.map(e => ({ type: 'token', text: e.token, logprob: e.logprob, top: (e.top_logprobs || []).map(t => ({ text: t.token, logprob: t.logprob })) }));
  }
  const text = choice.delta?.content;
  return text ? [{ type: 'token', text, logprob: null, top: null }] : [];
}

function completionTokens(choice) {
  const lp = choice.logprobs;
  if (lp && Array.isArray(lp.tokens) && lp.tokens.length) {
    return lp.tokens.map((tok, i) => ({
      type: 'token', text: tok, logprob: lp.token_logprobs?.[i] ?? null,
      top: lp.top_logprobs?.[i] ? Object.entries(lp.top_logprobs[i]).map(([text, logprob]) => ({ text, logprob })).sort((a, b) => b.logprob - a.logprob) : null,
    }));
  }
  return choice.text ? [{ type: 'token', text: choice.text, logprob: null, top: null }] : [];
}

/** Async generator: upstream SSE ReadableStream → normalized events. */
export async function* normalizeUpstream(stream, model) {
  const reader = stream.getReader();
  const dec = new TextDecoder();
  let buf = '', usage = null, finish = null, sawDone = false;
  while (true) {
    const { value, done } = await reader.read();
    if (done) break;
    buf += dec.decode(value, { stream: true });
    const { events, rest } = parseSSE(buf);
    buf = rest;
    for (const raw of events) {
      if (raw === '[DONE]') { sawDone = true; continue; }
      let json; try { json = JSON.parse(raw); } catch { continue; }
      if (json.error) { yield { type: 'error', message: json.error.message || 'The model returned an error.' }; return; }
      if (json.usage) usage = json.usage;
      for (const choice of json.choices || []) {
        if (choice.finish_reason) finish = choice.finish_reason;
        const toks = model.endpoint === 'completion' ? completionTokens(choice) : chatTokens(choice);
        for (const t of toks) yield t;
      }
    }
  }
  const prompt = usage?.prompt_tokens ?? 0, completion = usage?.completion_tokens ?? 0;
  const cost = typeof usage?.cost === 'number' ? usage.cost : estimateCost(model, prompt, completion);
  yield { type: 'done', usage: { prompt, completion }, cost, finish };
}
```

**Step 4:** PASS. **Step 5:** Commit `Add OpenRouter request building and SSE normalization`.

### Task 6: Session cookie signing (`worker/src/session.js`)

**Files:** Create `worker/src/session.js`; Test `tests/session.test.mjs`.

Cookie value: `${clientId}.${expiresMs}.${sigHex}` where `sig = HMAC-SHA256(secret, clientId + '.' + expiresMs)`, clientId = 16 random hex chars.

**Step 1: Failing tests**
```js
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { issueSession, verifySession, sessionCookieHeader, readCookie } from '../worker/src/session.js';

test('issue then verify round-trips and yields the client id', async () => {
  const tok = await issueSession('s3cret', 1_000_000);
  const v = await verifySession(tok, 's3cret', 1_000_000 + 5);
  assert.equal(v.ok, true); assert.match(v.clientId, /^[0-9a-f]{16}$/);
});
test('rejects expired, tampered, wrong-secret, and garbage tokens', async () => {
  const tok = await issueSession('s3cret', 0);
  assert.equal((await verifySession(tok, 's3cret', 40 * 24 * 3600 * 1000)).ok, false);
  assert.equal((await verifySession(tok.replace(/.$/, c => (c === 'a' ? 'b' : 'a')), 's3cret', 1)).ok, false);
  assert.equal((await verifySession(tok, 'other', 1)).ok, false);
  assert.equal((await verifySession('nope', 's3cret', 1)).ok, false);
  assert.equal((await verifySession(undefined, 's3cret', 1)).ok, false);
});
test('cookie header is HttpOnly, Secure, SameSite=Strict, 30 days', () => {
  const h = sessionCookieHeader('abc');
  assert.match(h, /^sess=abc; /); assert.match(h, /HttpOnly/); assert.match(h, /Secure/); assert.match(h, /SameSite=Strict/); assert.match(h, /Max-Age=2592000/); assert.match(h, /Path=\//);
});
test('readCookie pulls sess out of a Cookie header', () => {
  assert.equal(readCookie('a=1; sess=xyz; b=2', 'sess'), 'xyz');
  assert.equal(readCookie(null, 'sess'), undefined);
});
```

**Step 3: Implementation**
```js
const MAX_AGE_S = 30 * 24 * 3600;
const enc = new TextEncoder();

async function hmac(secret, msg) {
  const key = await crypto.subtle.importKey('raw', enc.encode(secret), { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']);
  const sig = await crypto.subtle.sign('HMAC', key, enc.encode(msg));
  return [...new Uint8Array(sig)].map(b => b.toString(16).padStart(2, '0')).join('');
}
function randomHex(nBytes) {
  const a = new Uint8Array(nBytes); crypto.getRandomValues(a);
  return [...a].map(b => b.toString(16).padStart(2, '0')).join('');
}
function safeEqual(a, b) {
  if (typeof a !== 'string' || typeof b !== 'string' || a.length !== b.length) return false;
  let d = 0; for (let i = 0; i < a.length; i++) d |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return d === 0;
}

export async function issueSession(secret, nowMs = Date.now()) {
  const clientId = randomHex(8);
  const exp = nowMs + MAX_AGE_S * 1000;
  return `${clientId}.${exp}.${await hmac(secret, `${clientId}.${exp}`)}`;
}
export async function verifySession(token, secret, nowMs = Date.now()) {
  if (typeof token !== 'string') return { ok: false };
  const [clientId, expStr, sig] = token.split('.');
  const exp = Number(expStr);
  if (!clientId || !sig || !Number.isFinite(exp) || exp < nowMs) return { ok: false };
  const expected = await hmac(secret, `${clientId}.${exp}`);
  return safeEqual(sig, expected) ? { ok: true, clientId } : { ok: false };
}
export function sessionCookieHeader(token) {
  return `sess=${token}; Path=/; Max-Age=${MAX_AGE_S}; HttpOnly; Secure; SameSite=Strict`;
}
export function readCookie(header, name) {
  if (!header) return undefined;
  for (const part of header.split(';')) {
    const [k, ...rest] = part.trim().split('=');
    if (k === name) return rest.join('=');
  }
  return undefined;
}
export { safeEqual };
```
Note: `Secure` cookies are still accepted by browsers on `http://127.0.0.1` and `localhost`, so local dev works.

**Step 4:** PASS. **Step 5:** Commit `Add signed session cookies`.

### Task 7: Ledger (rate limit + daily spend) as a pure class plus Durable Object wrapper

**Files:** Create `worker/src/ledger.js`; Test `tests/ledger.test.mjs`.

**Step 1: Failing tests**
```js
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Ledger } from '../worker/src/ledger.js';

test('hit allows up to the per-minute limit then blocks with retryAfter', () => {
  let t = 1_000_000; const l = new Ledger(() => t);
  for (let i = 0; i < 3; i++) assert.equal(l.hit('c1', 3).ok, true);
  const r = l.hit('c1', 3);
  assert.equal(r.ok, false); assert.ok(r.retryAfterSec >= 1 && r.retryAfterSec <= 60);
  t += 61_000;
  assert.equal(l.hit('c1', 3).ok, true);
});
test('hits are independent per client', () => {
  const l = new Ledger(() => 0);
  l.hit('a', 1); assert.equal(l.hit('b', 1).ok, true);
});
test('charge accumulates per bucket per UTC day and canSpend respects the limit', () => {
  let t = Date.UTC(2026, 8, 14, 12); const l = new Ledger(() => t);
  assert.equal(l.canSpend('default', 1), true);
  l.charge('default', 0.6); l.charge('default', 0.5);
  assert.equal(l.canSpend('default', 1), false);
  assert.equal(l.canSpend('gpt4', 1), true);
  assert.ok(Math.abs(l.spent('default') - 1.1) < 1e-12);
  t = Date.UTC(2026, 8, 15, 0, 1);
  assert.equal(l.canSpend('default', 1), true); assert.equal(l.spent('default'), 0);
});
test('snapshot/restore round-trips and prunes stale data', () => {
  let t = Date.UTC(2026, 8, 14, 12); const l = new Ledger(() => t);
  l.hit('a', 5); l.charge('default', 0.2);
  const snap = JSON.parse(JSON.stringify(l.snapshot()));
  const l2 = new Ledger(() => t); l2.restore(snap);
  assert.ok(Math.abs(l2.spent('default') - 0.2) < 1e-12);
  assert.equal(l2.hit('a', 1).ok, false);
  t += 3 * 24 * 3600 * 1000;
  const l3 = new Ledger(() => t); l3.restore(snap);
  assert.equal(l3.spent('default'), 0);
  assert.equal(Object.keys(l3.snapshot().minute).length, 0);
});
```

**Step 3: Implementation** (the DO class is a thin wrapper; `DurableObject` import is only resolvable inside wrangler, so guard the import for node tests by placing the DO in `worker/src/ledger_object.js` — see below).

`worker/src/ledger.js`:
```js
const dayKey = (ms) => new Date(ms).toISOString().slice(0, 10);

export class Ledger {
  constructor(now = () => Date.now()) { this.now = now; this.minute = {}; this.spend = {}; }

  hit(clientId, limitPerMinute) {
    const t = this.now(); const cutoff = t - 60_000;
    const arr = (this.minute[clientId] || []).filter(ts => ts > cutoff);
    if (arr.length >= limitPerMinute) {
      this.minute[clientId] = arr;
      return { ok: false, retryAfterSec: Math.max(1, Math.ceil((arr[0] + 60_000 - t) / 1000)) };
    }
    arr.push(t); this.minute[clientId] = arr;
    return { ok: true };
  }
  spent(bucket) { return this.spend[`${dayKey(this.now())}:${bucket}`] || 0; }
  canSpend(bucket, limitUsd) { return this.spent(bucket) < limitUsd; }
  charge(bucket, usd) {
    const k = `${dayKey(this.now())}:${bucket}`;
    this.spend[k] = (this.spend[k] || 0) + (Number(usd) || 0);
  }
  snapshot() {
    this.prune();
    return { minute: this.minute, spend: this.spend };
  }
  restore(snap) {
    this.minute = { ...(snap?.minute || {}) }; this.spend = { ...(snap?.spend || {}) };
    this.prune();
  }
  prune() {
    const t = this.now(); const cutoff = t - 60_000;
    for (const [k, arr] of Object.entries(this.minute)) {
      const kept = arr.filter(ts => ts > cutoff);
      if (kept.length) this.minute[k] = kept; else delete this.minute[k];
    }
    const today = dayKey(t), yesterday = dayKey(t - 86_400_000);
    for (const k of Object.keys(this.spend)) if (!k.startsWith(today) && !k.startsWith(yesterday)) delete this.spend[k];
  }
}
```

`worker/src/ledger_object.js` (not unit-tested; exercised by `wrangler dev`):
```js
import { DurableObject } from 'cloudflare:workers';
import { Ledger } from './ledger.js';

export class LedgerObject extends DurableObject {
  constructor(ctx, env) {
    super(ctx, env);
    this.ledger = new Ledger();
    ctx.blockConcurrencyWhile(async () => {
      const snap = await ctx.storage.get('state');
      if (snap) this.ledger.restore(snap);
    });
  }
  async persist() { await this.ctx.storage.put('state', this.ledger.snapshot()); }
  async hit(clientId, limit) { const r = this.ledger.hit(clientId, limit); await this.persist(); return r; }
  async canSpend(bucket, limit) { return this.ledger.canSpend(bucket, limit); }
  async charge(bucket, usd) { this.ledger.charge(bucket, usd); await this.persist(); }
  async spent(bucket) { return this.ledger.spent(bucket); }
}
```
Durable Object RPC (calling `stub.hit(...)` directly) is supported for classes extending `DurableObject` on compatibility dates ≥ 2024-04-03. `index.js` gets the stub with `env.LEDGER.getByName('global')` (or `env.LEDGER.get(env.LEDGER.idFromName('global'))`).

**Step 4:** PASS. **Step 5:** Commit `Add ledger for rate limits and daily spend`.

### Task 8: Worker router (`worker/src/index.js`)

**Files:** Create `worker/src/index.js`; Test `tests/worker.test.mjs`.

The handler is written as `export async function handle(request, env, ctx)` with all I/O through `env` so tests can inject: `env.LEDGER` (fake with `getByName()` returning an object with `hit/canSpend/charge`), `env.ASSETS.fetch`, `env.fetchUpstream` (defaults to global `fetch`), secrets and vars as strings. `export default { fetch: handle }` and `export { LedgerObject } from './ledger_object.js'` are at the bottom; to keep node tests from importing `cloudflare:workers`, put the router in `worker/src/router.js` and make `index.js` a 3-line file that re-exports both. Tests import `router.js`.

Routes:
- `POST /api/auth` `{passcode}` → per-IP `hit('auth:'+ip, AUTH_ATTEMPTS_PER_MINUTE)`; wrong → 401 `{message:'That passcode is not right.'}`; right → 204 with `Set-Cookie`.
- `GET /api/session` → 204 if cookie valid else 401.
- `GET /api/models` → JSON `MODELS` (so the site and Worker can never disagree).
- `POST /api/generate` → cookie required (401) → JSON body (400) → validate (400) → `hit(clientId, PER_CLIENT_PER_MINUTE)` (429 with `Retry-After`) → `canSpend(model.bucket, budget)` (429, message names the budget) → upstream fetch with `Authorization: Bearer ${env.OPENROUTER_API_KEY}`, `HTTP-Referer` and `X-Title` headers → if upstream not ok, 502 with a plain message → else stream normalized events as SSE `data: {...}\n\n`; when the `done` event passes through, `ctx.waitUntil(ledger.charge(bucket, cost))`. Non-streaming (`stream:false`) collects events and returns JSON `{events:[...]}`.
- Anything else → `env.ASSETS.fetch(request)`.
- All JSON errors: `{ message }`; never forward upstream bodies.

**Step 1: Failing tests** (representative; write all of these)
```js
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
```

**Step 3: Implementation** — `worker/src/router.js`:
```js
import { MODELS } from '../../site/models.js';
import { validateGenerate } from './validate.js';
import { buildUpstream, normalizeUpstream } from './openrouter.js';
import { issueSession, verifySession, sessionCookieHeader, readCookie, safeEqual } from './session.js';

const json = (status, obj, headers = {}) => new Response(JSON.stringify(obj), { status, headers: { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store', ...headers } });
const num = (v, d) => { const n = Number(v); return Number.isFinite(n) ? n : d; };

async function readJson(request) { try { return await request.json(); } catch { return null; } }

export async function handle(request, env, ctx) {
  const url = new URL(request.url);
  const ledger = env.LEDGER.getByName('global');
  const ip = request.headers.get('cf-connecting-ip') || 'unknown';

  if (url.pathname === '/api/auth' && request.method === 'POST') {
    const gate = await ledger.hit(`auth:${ip}`, num(env.AUTH_ATTEMPTS_PER_MINUTE, 10));
    if (!gate.ok) return json(429, { message: 'Too many attempts. Wait a minute and try again.' }, { 'retry-after': String(gate.retryAfterSec) });
    const body = await readJson(request);
    const supplied = typeof body?.passcode === 'string' ? body.passcode.trim() : '';
    if (!safeEqual(supplied, env.PASSCODE)) return json(401, { message: 'That passcode is not right.' });
    const token = await issueSession(env.COOKIE_SECRET);
    return new Response(null, { status: 204, headers: { 'set-cookie': sessionCookieHeader(token), 'cache-control': 'no-store' } });
  }

  if (url.pathname === '/api/session' && request.method === 'GET') {
    const v = await verifySession(readCookie(request.headers.get('cookie'), 'sess'), env.COOKIE_SECRET);
    return new Response(null, { status: v.ok ? 204 : 401, headers: { 'cache-control': 'no-store' } });
  }

  if (url.pathname === '/api/models' && request.method === 'GET') return json(200, MODELS);

  if (url.pathname === '/api/generate' && request.method === 'POST') {
    const sess = await verifySession(readCookie(request.headers.get('cookie'), 'sess'), env.COOKIE_SECRET);
    if (!sess.ok) return json(401, { message: 'Please enter the class passcode.' });
    const body = await readJson(request);
    const v = validateGenerate(body);
    if (!v.ok) return json(v.status, { message: v.message });
    const rl = await ledger.hit(sess.clientId, num(env.PER_CLIENT_PER_MINUTE, 30));
    if (!rl.ok) return json(429, { message: 'You are sending requests quickly. Take a breath and try again in a moment.' }, { 'retry-after': String(rl.retryAfterSec) });
    const { model } = v.value;
    const budget = model.bucket === 'gpt4' ? num(env.GPT4_DAILY_BUDGET_USD, 1) : num(env.DAILY_BUDGET_USD, 5);
    if (!(await ledger.canSpend(model.bucket, budget))) {
      return json(429, { message: model.bucket === 'gpt4' ? 'Today\'s class budget for GPT-4 is used up. Try a cheaper model or come back tomorrow.' : 'Today\'s class budget is used up. Please come back tomorrow.' });
    }
    const { url: upUrl, body: upBody } = buildUpstream(v.value, env.OPENROUTER_BASE_URL);
    const doFetch = env.fetchUpstream || fetch;
    let up;
    try {
      up = await doFetch(upUrl, { method: 'POST', headers: { 'content-type': 'application/json', Authorization: `Bearer ${env.OPENROUTER_API_KEY}`, 'HTTP-Referer': url.origin, 'X-Title': env.SITE_TITLE || 'LLM Under the Hood' }, body: JSON.stringify(upBody) });
    } catch { return json(502, { message: 'Could not reach the model provider. Try again in a moment.' }); }
    if (!up.ok || !up.body) return json(502, { message: `The model provider returned an error (${up.status}). Try again or pick another model.` });

    const events = normalizeUpstream(up.body, model);
    const onDone = (ev) => { if (ev.type === 'done' && ev.cost > 0) ctx.waitUntil(ledger.charge(model.bucket, ev.cost)); };

    if (!v.value.stream) {
      const all = []; for await (const ev of events) { onDone(ev); all.push(ev); }
      return json(200, { events: all });
    }
    const enc = new TextEncoder();
    const stream = new ReadableStream({
      async pull(controller) {
        const { value, done } = await events.next();
        if (done) { controller.close(); return; }
        onDone(value);
        controller.enqueue(enc.encode(`data: ${JSON.stringify(value)}\n\n`));
      },
    });
    return new Response(stream, { status: 200, headers: { 'content-type': 'text/event-stream; charset=utf-8', 'cache-control': 'no-store', 'x-accel-buffering': 'no' } });
  }

  if (url.pathname.startsWith('/api/')) return json(404, { message: 'Not found.' });
  return env.ASSETS.fetch(request);
}
```
`worker/src/index.js`:
```js
import { handle } from './router.js';
export { LedgerObject } from './ledger_object.js';
export default { fetch: handle };
```

**Step 4:** PASS. **Step 5:** Commit `Add Worker router with auth, limits, and streaming proxy`.

### Task 9: Local mock upstream (`tools/mock_openrouter.mjs`)

**Files:** Create `tools/mock_openrouter.mjs`. No unit test; verified by hand in Task 10.

A plain `node:http` server on port 8788 that accepts `POST /chat/completions` and `POST /completions`, reads the body, and streams a canned but *prompt-aware* SSE response so the UI looks alive offline:
- Builds 10–20 fake tokens by echoing a canned clinical continuation (`" a CT scan of the chest, which showed..."`) split on word boundaries, one SSE chunk every 60 ms.
- If the request body has `logprobs`, attaches `top_logprobs` with 5 plausible alternatives and decaying logprobs (e.g. `[-0.2, -1.9, -2.6, -3.3, -4.0]`, with the chosen token first) in chat format for `/chat/completions` and legacy map format for `/completions`.
- If `max_tokens` is 1, sends exactly one token.
- Final chunk carries `usage` with `prompt_tokens = ceil(promptChars/4)`, `completion_tokens`, and `cost` from the model's price (import `site/models.js`).
- If the body's `model` is `mock/error`, responds `500`.
- Respects `stream:false` by returning a single JSON completion object.

Also add `tools/README.md` explaining the mock and the data builders.

**Verify:** `npm run mock` in one terminal; `curl -N -X POST localhost:8788/chat/completions -d '{"model":"openai/gpt-4o-mini","messages":[{"role":"user","content":"hi"}],"stream":true,"logprobs":true,"top_logprobs":5}'` streams chunks ending with `[DONE]`.

**Commit** `Add mock OpenRouter server for local development`.

### Task 10: First `wrangler dev` smoke

**Steps:**
1. `cp .dev.vars.example .dev.vars`.
2. Load the `wrangler` skill, then run `npm run mock` and `npm run dev` (use the Browser pane's `preview_start` with a launch.json entry, not Bash, for the dev server; create `.claude/launch.json` with `{"name":"lluth-dev","runtimeExecutable":"npm","runtimeArgs":["run","dev"],"port":8787}` and `{"name":"lluth-mock","runtimeExecutable":"npm","runtimeArgs":["run","mock"],"port":8788}`).
3. `curl -i -X POST localhost:8787/api/auth -H 'content-type: application/json' -d '{"passcode":"test"}'` → 204 with `set-cookie`.
4. `curl -N -X POST localhost:8787/api/generate -H 'content-type: application/json' -H 'cookie: sess=<value>' -d '{"model":"openai/gpt-4o-mini","prompt":"The patient presented with"}'` → normalized events.
5. Fix anything the real runtime reveals (e.g. `getByName` availability for the compatibility date; fall back to `env.LEDGER.get(env.LEDGER.idFromName('global'))`).
6. Commit `Verify Worker runs locally against the mock`.

---

## Phase 2 — Build-time data

### Task 11: Vendor tokenizers and write `site/tokenize.js`

**Files:** Create `tools/vendor_tokenizers.sh`, `site/vendor/o200k.js`, `site/vendor/cl100k.js` (generated, committed), `site/tokenize.js`; Test `tests/tokenize.test.mjs`.

**Step 1: `tools/vendor_tokenizers.sh`**
```sh
#!/bin/sh
set -e
cd "$(dirname "$0")/.."
npx esbuild node_modules/gpt-tokenizer/esm/encoding/o200k_base.js --bundle --format=esm --minify --outfile=site/vendor/o200k.js
npx esbuild node_modules/gpt-tokenizer/esm/encoding/cl100k_base.js --bundle --format=esm --minify --outfile=site/vendor/cl100k.js
ls -la site/vendor
```
Run `npm run vendor:tokenizers`. Expected: two files, ~2.7 MB and ~1.0 MB.

**Step 2: Failing test**
```js
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { tokenize, loadTokenizer } from '../site/tokenize.js';

test('o200k splits a clinical word into visible pieces with ids', async () => {
  const enc = await loadTokenizer('o200k');
  const toks = tokenize(enc, 'The patient has hyponatremia.');
  assert.deepEqual(toks.map(t => t.text), ['The', ' patient', ' has', ' hy', 'pon', 'at', 'rem', 'ia', '.']);
  assert.ok(toks.every(t => Number.isInteger(t.id)));
});
test('cl100k loads and tokenizes too', async () => {
  const enc = await loadTokenizer('cl100k');
  assert.ok(tokenize(enc, 'warfarin').length >= 2);
});
test('unknown tokenizer name rejects', async () => {
  await assert.rejects(loadTokenizer('nope'));
});
```

**Step 3: `site/tokenize.js`**
```js
const cache = new Map();
/** Lazily import a vendored encoder; works in browsers and Node. */
export async function loadTokenizer(name) {
  if (!['o200k', 'cl100k'].includes(name)) throw new Error(`Unknown tokenizer ${name}`);
  if (!cache.has(name)) cache.set(name, import(`./vendor/${name}.js`));
  return cache.get(name);
}
/** → [{id, text}] */
export function tokenize(enc, text) {
  return enc.encode(text).map(id => ({ id, text: enc.decode([id]) }));
}
```
Note for the browser: a token that is half of a multi-byte character decodes to `�`; render those as `·` with a title "part of a character".

**Step 4:** PASS. **Step 5:** Commit `Vendor tokenizers and add tokenize module`.

### Task 12: Word-embedding map data (`tools/build_embeddings.mjs` → `site/data/embeddings.json`)

**Files:** Create `tools/vocabulary.txt`, `tools/build_embeddings.mjs`, `tools/pca.mjs`; Test `tests/pca.test.mjs`; Output `site/data/embeddings.json` (committed).

**Step 1: vocabulary** — ~300 lowercase words, one per line, `word<TAB>group`. Groups: `drug` (warfarin, heparin, aspirin, metformin, insulin, lisinopril, amoxicillin, ibuprofen, morphine, …), `anatomy` (heart, kidney, renal, liver, hepatic, lung, pulmonary, brain, …), `symptom` (fever, cough, pain, dizziness, nausea, fatigue, rash, …), `disease` (diabetes, hypertension, pneumonia, sepsis, stroke, asthma, …), `test` (ct, mri, xray, ecg, biopsy, glucose, …), `people` (patient, nurse, doctor, surgeon, family, mother, grandmother, …), `place` (hospital, clinic, pharmacy, home, kitchen, school, …), `food` (banana, apple, bread, coffee, soup, recipe, …), `everyday` (car, dog, cat, rain, music, phone, book, …), `verb` (prescribe, diagnose, walk, eat, sleep, write, …), `time` (today, yesterday, morning, week, …). Include the words from the suggested prompts so they light up.

**Step 2: PCA failing test** (`tests/pca.test.mjs`)
```js
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { pca2d } from '../tools/pca.mjs';
test('pca2d projects to 2 dims and separates two clusters', () => {
  const a = Array.from({ length: 20 }, (_, i) => [10 + Math.sin(i), 10 + Math.cos(i), 0.1 * i]);
  const b = Array.from({ length: 20 }, (_, i) => [-10 + Math.sin(i), -10 + Math.cos(i), 0.1 * i]);
  const pts = pca2d([...a, ...b]);
  assert.equal(pts.length, 40); assert.equal(pts[0].length, 2);
  const ma = pts.slice(0, 20).reduce((s, p) => s + p[0], 0) / 20, mb = pts.slice(20).reduce((s, p) => s + p[0], 0) / 20;
  assert.ok(Math.abs(ma - mb) > 5);
});
```
**Step 3: `tools/pca.mjs`** — mean-center, compute covariance (d×d, d=384), top-2 eigenvectors by power iteration with deflation (200 iterations each), project. Return array of `[x, y]`. Then normalize both axes to [-1, 1] in the build script.

**Step 4: `tools/build_embeddings.mjs`**
```js
import { pipeline } from '@huggingface/transformers';
import { readFile, writeFile } from 'node:fs/promises';
import { pca2d } from './pca.mjs';

const lines = (await readFile(new URL('./vocabulary.txt', import.meta.url), 'utf8')).split('\n').map(l => l.trim()).filter(l => l && !l.startsWith('#'));
const words = lines.map(l => { const [w, g] = l.split('\t'); return { w, g: g || 'other' }; });
const emb = await pipeline('feature-extraction', 'Xenova/all-MiniLM-L6-v2', { dtype: 'fp32' });
const out = await emb(words.map(x => x.w), { pooling: 'mean', normalize: true });
const vecs = out.tolist();
const pts = pca2d(vecs);
const norm = (arr, i) => { const v = arr.map(p => p[i]); const lo = Math.min(...v), hi = Math.max(...v); return v.map(x => ((x - lo) / (hi - lo)) * 2 - 1); };
const xs = norm(pts, 0), ys = norm(pts, 1);
const dot = (a, b) => a.reduce((s, x, i) => s + x * b[i], 0);
const neighbors = {};
words.forEach((x, i) => {
  neighbors[x.w] = words.map((y, j) => [y.w, dot(vecs[i], vecs[j])]).filter(([w]) => w !== x.w).sort((a, b) => b[1] - a[1]).slice(0, 5).map(([w, s]) => ({ w, s: Number(s.toFixed(3)) }));
});
const data = { model: 'Xenova/all-MiniLM-L6-v2', built: new Date().toISOString().slice(0, 10), words: words.map((x, i) => ({ w: x.w, g: x.g, x: Number(xs[i].toFixed(4)), y: Number(ys[i].toFixed(4)) })), neighbors };
await writeFile(new URL('../site/data/embeddings.json', import.meta.url), JSON.stringify(data));
console.log('wrote', data.words.length, 'words');
```
Run `npm run data:embeddings`. Check by eye that `neighbors.warfarin` includes heparin and that `neighbors.kidney` includes renal. If the 2D map mixes groups badly, that is acceptable (PCA of 384 dims loses a lot); the caption already says "flattened from 384 dimensions".

**Step 5:** Commit `Add embedding map data and PCA tool`.

### Task 13: Attention data (`tools/build_attention.py` → `site/data/attention.json`)

**Files:** Create `tools/build_attention.py`, `tools/requirements.txt` (`torch`, `transformers`); Output `site/data/attention.json`.

Setup (documented in `tools/README.md`): `python3 -m venv .venv && .venv/bin/pip install -r tools/requirements.txt` (a ~200 MB download, once).

Script: for each of two sentences —
1. `"The patient stopped taking her medication because it made her dizzy."` with highlights `it → medication` and `her → patient`.
2. `"The nurse gave the child an inhaler, and she began breathing more easily."` with highlights `she → child`, `breathing → inhaler`.
— run GPT-2 with `output_attentions=True` (eager attention), find for each highlight the (layer, head) where the `from` token puts the most attention on the `to` token, and store: cleaned tokens (`Ġ` → leading space), and for each highlight `{from, to, layer, head, weight, row}` where `row` is that head's full attention row for the `from` token (rounded to 3 decimals) so the UI can draw arcs to every earlier token. Also store `mean_row` per highlight averaged over heads of that layer. Output shape:
```json
{ "model": "gpt2", "sentences": [ { "text": "...", "tokens": ["The", " patient", ...], "highlights": [ { "from": 7, "to": 5, "layer": 7, "head": 8, "weight": 0.703, "row": [0.01, ...] } ] } ] }
```
Verified 2026-09-14: sentence 1 gives `it → medication` at layer 7 head 8 with weight 0.70.

Run `npm run data:attention`; eyeball the JSON; commit `Add precomputed GPT-2 attention examples`.

---

## Phase 3 — Frontend

General rules for every frontend task: plain ES modules loaded from `index.html` with `<script type="module" src="app.js">`; no framework; each chapter module exports `mount(root, store)`; use `data-*` attributes and `hidden` toggling; CSS in one `styles.css` with tokens on `:root` plus a `prefers-color-scheme: dark` block; every interactive control has a label; the page must not scroll horizontally at 400px. Chapter copy is in the design doc §4.2 — write it in Scott's plain-professor register (short sentences, no hype). After each task, verify in the Browser pane with `preview_start` (mock + dev running) and take a screenshot; fix before committing.

### Task 14: Store, API client, shell page

**Files:** Create `site/store.js`, `site/api.js`, `site/index.html`, `site/styles.css`, `site/app.js`; Test `tests/store.test.mjs`, `tests/api.test.mjs`.

**store.js** — `createStore(initial)` → `{ get(), set(patch), subscribe(fn) → unsubscribe }`; `set` shallow-merges and notifies subscribers with `(state, patchKeys)`. Test: subscribe fires with keys, unsubscribe stops it, `get()` returns the merged state.

**api.js** —
```js
export async function checkSession() { return (await fetch('/api/session')).status === 204; }
export async function login(passcode) { const r = await fetch('/api/auth', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ passcode }) }); if (r.status === 204) return { ok: true }; return { ok: false, message: (await safeJson(r))?.message || 'Could not sign in.' }; }
/** Streams normalized events. onEvent(ev). Returns when done. Throws Error(message) for HTTP errors. */
export async function generate(params, { onEvent, signal } = {}) { ... POST /api/generate, read body with a TextDecoder, reuse parseSSE (copy the pure function into site/sse.js and have the worker import it from there to keep one copy: move parseSSE to site/sse.js in this task and update worker/src/openrouter.js + its test import) ... }
```
Test `api.test.mjs`: stub `globalThis.fetch` to return a `Response` with SSE text; assert `onEvent` sees token then done; a 429 response with `{message}` throws with that message; `signal` abort stops reading.

**index.html** — structure:
```
<header class="strip"> pinned pipeline strip: 6 buttons (Tokens, Numbers, Attention, Predict, Assistant, Compare), active state follows scroll (IntersectionObserver) and click scrolls to the section </header>
<section id="gate" hidden> passcode form (label, input type=password autocomplete=off, button, error line) </section>
<main hidden>
  <section id="intro"> title, 2–3 sentence framing, PHI notice, prompt textarea (maxlength=200, live counter "37 / 200"), model <select> built from MODELS with optgroups by era, 6 starter-prompt chips, "Run it" button </section>
  <section id="ch-tokens" class="chapter"> … </section>  (one per chapter, each with <h2>, <p class="lede">, <div class="viz"></div>, <p class="try">)
</main>
<footer> "Built for MHI 289A · fictional cases only · models via OpenRouter" </footer>
```
Starter prompts (fictional): "The patient presented with chest pain and", "What is the first-line treatment for hypertension?", "Explain hyponatremia to a worried family member in two sentences.", "My grandmother's favorite recipe was", "List three causes of a persistent cough.", "The capital of Australia is".

**app.js** — boot: `checkSession()` → show gate or main; on login success, show main; build the model select; wire the prompt textarea (counter, disable Run when empty); `store` initial state `{ prompt, modelId, system: '', results: {} }`; on Run, `set({ runId: Date.now() })` so chapters re-render; mount all six chapters (import from `./chapters/*.js`); pipeline strip behavior. When `runId` changes, the page scrolls smoothly to the tokens chapter.

**styles.css** — tokens: `--bg`, `--fg`, `--muted`, `--accent` (a teal), `--warn`, `--card`, `--chip-{1..6}` (six distinct pastel token colors that also work in dark mode), `--p-high` (green), `--p-mid` (amber), `--p-low` (red). System font stack; max content width 860px; `body { padding-inline: 16px }`; chapters `min-height: 60vh`; `.strip` sticky top with backdrop blur; `.chip` inline-block token style; `.bar` for probability rows; reduced-motion media query disables transitions.

Verify in the Browser pane: gate appears, wrong passcode shows message, `test` passes, prompt counter works, strip highlights sections. Commit `Add site shell, store, and API client`.

### Task 15: Chapter 1 — Words become tokens (`site/chapters/tokens.js`)

Behavior: on `runId` or `prompt`/`modelId` change, load the model's tokenizer (`loadTokenizer(model.tokenizer)`), tokenize the prompt, render chips (`<span class="chip chip-N" title="token id 12345">` cycling six colors; leading spaces shown as a visible `␣`-style thin marker or rendered via `white-space: pre`). Caption: "**N tokens** for M characters. The model never sees letters or words, only these token IDs." Below, a second line filled after the first API result: "The model reported **K prompt tokens** for this prompt" (from `results.predict.usage.prompt`), and for non-OpenAI models add "Llama uses its own tokenizer, so this split is an approximation." Also an inline demo row that tokenizes three fixed words (`hyponatremia`, `warfarin`, `banana`) so students see splintering even with a short prompt. "Try this" nudge: "Type a long drug name and watch it splinter."

Add tests only for any pure helper you extract (e.g. `chipClass(i)`, `displayToken(text)` which maps `�` → `·` and leading space → visible marker). Verify visually. Commit `Add tokens chapter`.

### Task 16: Chapter 2 — Tokens become numbers (`site/chapters/numbers.js`)

Behavior: fetch `data/embeddings.json` once; render an SVG scatter (viewBox 0 0 600 400, responsive width) of all words as small circles colored by group with a legend; words from the student's prompt (lowercased, stripped of punctuation) that are in the vocabulary are drawn larger with labels and a pulse animation; hovering any point shows a tooltip with its 5 nearest neighbors and similarity scores. Caption: "Each token becomes a list of 384 numbers. Flattened to two dimensions here. Words used in similar ways land near each other." "Try this": "Find warfarin. Who are its neighbors?" If none of the prompt's words are in the vocabulary, show "None of your words are on this small map; hover around anyway."

Pure helper to test: `promptWords(prompt)` → unique lowercase words without punctuation. Commit `Add embeddings map chapter`.

### Task 17: Chapter 3 — Every word looks at the others (`site/chapters/attention.js`)

Two panels.
**Panel A (real data):** tabs for the two sentences from `data/attention.json`. Tokens laid out in a row; clicking a token that is a highlight `from` draws arcs (SVG quadratic curves above the row) to every earlier token with stroke width and opacity proportional to `row[j]`; the `to` token is emphasized. Default selection: the first highlight. Caption under each: "In layer 7, head 8, **it** puts 70% of its attention on **medication**." (values from data). A small note: "GPT-2, a 2019 model small enough to inspect. Bigger models do the same thing across hundreds of heads."
**Panel B (student's prompt, illustrative):** the student's tokens in a row; an animation steps through tokens left to right, fanning thin equal-weight lines from the current token to every earlier one, then moving on. Caption: "Your prompt: each token can look at every token before it. We are not showing real weights here; hosted models do not share them."

Pure helper to test: `arcPath(x1, x2, baseY, height)` returns a valid SVG path string; `normalizeRow(row)` scales max to 1. Commit `Add attention chapter`.

### Task 18: Chapter 4 — Pick the next word (`site/chapters/predict.js`)

This is the largest chapter. State kept in the module: `{ first: {top, text, usage} | null, tokens: [{text, logprob, top}], status: 'idle'|'streaming'|'paused'|'done'|'error', temperature: 0.7, showConfidence: true, error }`.

Behavior:
1. On `runId`: reset; call `generate({ model, prompt, system, maxTokens: 1, topLogprobs: 10, temperature: 0 })` (the client always streams; a one-token stream is just one `token` event and a `done`); from the first `token` event, store `first.top` (10 alternatives). Store `usage.prompt` into `store.results.predict.usage` (tokens chapter reads it). Render **bars**: one row per candidate, `displayToken(text)` label, animated width = p×100%, percentage text; a grey "everything else" row for `other`. Heading: "The model's top guesses for the next token".
2. **Temperature slider** (0 to 1.5, step 0.1, default 0.7) re-renders bars via `rescale(first.top, T)` live, with the caption changing: T<0.3 "Nearly always picks the favorite", 0.3–1.0 "Usually the favorite, sometimes a surprise", >1.0 "Anything goes".
3. **Roll the dice** button: `sample(rescale(first.top, T), Math.random)` → highlights the chosen bar with a brief dice animation and writes the picked token into the output line.
4. **Keep going** button: calls `generate({ ..., maxTokens: 120, topLogprobs: 5, temperature: T, prefix: pickedTokenText, stream: true })`; each `token` event appends a `<span class="out-tok band-high|mid|low">` (band from `exp(logprob)`; class `band-unknown` if null) to the output line; the side panel "What it considered" shows the current step's top-5 as mini bars. **Pause/Resume** uses an AbortController for pause (aborting discards the rest; Resume issues a new request with the current text as `prefix`). **Step** = request with `maxTokens: 1`.
5. **Fork**: each output token is clickable; clicking opens a popover listing that step's alternatives; picking one truncates the output at that index, appends the alternative, and continues with `prefix` = the new text. Show a small "forked here" marker.
6. **Confidence toggle** (checkbox "Color by confidence") toggles band classes. Legend: green ≥60%, amber 25–60%, red <25%. Caption: "Notice the red tokens read just as smoothly as the green ones. That is what a hallucination looks like from the inside."
7. **Models without probabilities**: bars area shows a card "Claude Haiku 4.5 does not share its probabilities. You can still watch it write." Roll/temperature disabled with an explanation; Keep going works; confidence toggle disabled.
8. **Errors**: message from `generate` shown in a `.notice` under the controls; Retry button.
9. Completion models: `prefix` is appended to the prompt server-side already; the UI shows the prompt and the continuation in one flowing line to make the "it just continues" point.

Pure helpers to test in `tests/predict_helpers.test.mjs`: `joinTokens(tokens)` → text, `forkAt(tokens, index, altText)` → new token array ending in the alt with `logprob: null` and `top` carried over; `temperatureCaption(T)`.

Verify with the mock (which returns alternatives) for the full flow: bars → slider → roll → keep going → fork → toggle. Screenshot. Commit `Add next-word prediction chapter`.

### Task 19: Chapter 5 — From autocomplete to assistant (`site/chapters/assistant.js`)

Two panes side by side (stack at <700px): left "GPT-3.5 Instruct, 2022 (autocomplete)" using `AUTOCOMPLETE_MODEL`; right the student's chosen chat model (if the chosen model *is* the instruct model, use `DEFAULT_MODEL` on the right). Both run on `runId` with `maxTokens: 80, topLogprobs: 0, stream: true` and the same `system` (initially empty). Above the panes a **system prompt** control: radio chips "None", "Nurse educator" (`You are a nurse educator. Answer at a sixth-grade reading level in two short sentences.`), "Terse decision support" (`You are a terse clinical decision support tool. Bullet points only. No preamble.`), "Custom…" (textarea, maxlength 400). Changing it and pressing "Run both again" re-runs both panes and updates `store.system` (Compare chapter reuses it). Left pane caption: "It continued your text. It was never taught to answer." Right pane: "Trained afterwards on examples of helpful answers, so it treats your text as a request." Each pane shows latency and the model's first 3 alternatives for its first token when available (small text), so students can see the instruct model's first guess is a continuation word while the chat model's is often "A"/"The"/"Sure".

Pure helper to test: `pickAssistantModel(chosenId)` (returns DEFAULT_MODEL when chosen is the instruct model, else chosen). Commit `Add autocomplete-vs-assistant chapter`.

### Task 20: Chapter 6 — Compare the eras (`site/chapters/compare.js`)

Controls: three `<select>`s (defaults: gpt-3.5-turbo, claude-haiku-4.5, llama-3.3-70b-instruct), a prompt field pre-filled from the main prompt but editable (maxlength 200) plus 4 suggested comparison prompts ("Who won the Nobel Prize in Medicine last year?", "A 70 kg adult takes 500 mg acetaminophen every 4 hours. What is the daily total, and is it safe?", "Cite one peer-reviewed paper showing aspirin prevents migraines.", "What is today's date?"), the shared system prompt toggle (read-only echo of chapter 5's choice with a link back), and "Compare". Each pane: header with label, year badge, provider, "open weights" tag if `open`, and `blurb`; streaming output with confidence coloring when `logprobs`; footer with latency (ms), prompt/output token counts, and cost formatted like `$0.0004` (or `< $0.0001`). Panes run concurrently (`Promise.all` of three `generate` calls, each with its own AbortController; "Stop all" button). Hovering an output token on a logprobs model shows its alternatives in a tooltip (reuse the popover from chapter 4; extract to `site/popover.js`). Errors per pane (a 429 budget message shows only in that pane). gpt-4 pane header carries a "$$$" badge and the caption "about 100× the cost of GPT-4o mini".

Pure helper to test: `formatCost(usd)`, `formatLatency(ms)`. Commit `Add era comparison chapter`.

### Task 21: Polish pass

- Dark mode check via `resize_window` with `colorScheme: 'dark'`; mobile check at 400px (no horizontal scroll; panes stack; strip scrolls horizontally inside itself).
- Keyboard: all chips/buttons focusable; popover closes on Escape.
- `prefers-reduced-motion`: no fan/pulse animations.
- Loading states: tokenizer import can take a second on first load; show "loading tokenizer…" in chapter 1.
- Empty prompt: Run disabled and chapters show the default example prompt's results only after the student runs.
- Console: zero errors in `read_console_messages` across a full run with the mock.
- Add `site/robots.txt` with `Disallow: /` (passcode-gated class tool; no need for indexing).
- Commit `Polish: dark mode, mobile, motion, loading states`.

---

## Phase 4 — Deploy and hand off

### Task 22: GitHub repo and first deploy

1. `gh repo create smcubed/llm-under-the-hood --public --source=. --remote=origin --push` (public is fine: no secrets in the repo; confirm `.dev.vars` is ignored with `git status --ignored`).
2. Load the `wrangler` skill. `npm run deploy` → note the `*.workers.dev` URL. Expect the first deploy to create the Durable Object migration.
3. Scott sets secrets himself (put these in HANDOFF.md, do not run them for him):
   ```bash
   npx wrangler secret put OPENROUTER_API_KEY
   ```
   ```bash
   npx wrangler secret put PASSCODE
   ```
   ```bash
   npx wrangler secret put COOKIE_SECRET
   ```
   (COOKIE_SECRET: any long random string, e.g. `openssl rand -hex 32`.)
4. Until secrets exist the deployed gate will fail with a plain message; that is acceptable.
5. Commit and push.

### Task 23: HANDOFF.md and Canvas text

`HANDOFF.md` mirroring the survey project: links table (site, repo, Cloudflare dashboard, OpenRouter activity page), the three secret commands, how to change the passcode (re-run the secret command; existing cookies stay valid for up to 30 days, or also rotate COOKIE_SECRET to log everyone out), how to swap a model (`site/models.js`, then `npm test && npm run deploy`; check the id on openrouter.ai/models and whether it lists `logprobs` under supported parameters), how to change budgets (`vars` in `wrangler.jsonc`), how to read spend (OpenRouter activity page; the Worker's DO keeps only today's and yesterday's totals), local dev steps, and a "known limits" list (Claude/Gemini/gpt-5 show no probabilities; Llama token counts are approximate; PCA map is a flattening).

`docs/canvas-page.md`: a short Canvas page for Week 1 or 2: what the tool is, the link and passcode placeholder, the no-PHI rule, and three exercises (tokenize a long drug name and report the count; fork one sentence three ways and describe how the meaning changed; compare GPT-3.5 vs Haiku vs Llama on the citation-trap prompt and note which one invented a paper).

Commit `Add handoff notes and Canvas page text`.

### Task 24: Real-model verification (after Scott sets the secrets)

Checklist to run in the Browser pane against the deployed URL, once per ladder model, with the prompt "The patient presented with chest pain and":
- [ ] gpt-3.5-turbo-instruct: bars appear; continuation reads as a sentence continuation; Fork works.
- [ ] gpt-3.5-turbo, gpt-4, gpt-4o-mini, llama-3.3-70b: bars appear; confidence coloring present; counts and cost shown.
- [ ] claude-haiku-4.5, gpt-5-mini, gemini-3.5-flash-lite: "does not share probabilities" card; streaming works.
- [ ] Compare: three panes stream concurrently; costs match OpenRouter's activity page within rounding.
- [ ] Budget: temporarily set `GPT4_DAILY_BUDGET_USD` to `0.0001` via `wrangler deploy --var`, confirm the gpt-4 pane shows the budget message, then redeploy with the real value.
- [ ] Wrong passcode ×11 within a minute → "Too many attempts".
Record findings in HANDOFF.md under "Verified on <date>"; fix and redeploy as needed. Update the memory file `llm-under-the-hood-project.md` with the live URL.
