// Local stand-in for OpenRouter so the Worker and the UI can be exercised offline.
// POST /chat/completions and POST /completions stream a canned, prompt-aware continuation as SSE,
// one token every ~60 ms, in the same shapes OpenRouter uses. `npm run mock` listens on 8788.
import http from 'node:http';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { getModel, estimateCost } from '../site/models.js';

const DEFAULT_PORT = 8788;
const DEFAULT_TOKEN_MS = 60;
const MAX_TOKENS_DEFAULT = 20; // "10–20 fake tokens"
const LOGPROB_LADDER = [-0.2, -1.9, -2.6, -3.3, -4.0];
const FALLBACK_PRICE = { in: 0.15, out: 0.6 }; // per million tokens, for model ids not in the ladder

// Canned continuations, picked by what the prompt looks like so the UI looks alive.
const CONTINUATIONS = [
  { test: /patient|present|clinic|diagnos|symptom|pain|fever|hospital|physician|doctor|exam/i,
    text: ' a CT scan of the chest, which showed a small pulmonary nodule in the right upper lobe, and the team recommended follow-up imaging in three months to watch for any change.' },
  { test: /once upon|story|tale|dragon|princess|castle/i,
    text: ' a small village at the edge of a dark forest, where nobody ever went after sundown, until one evening a child with a lantern decided to find out why the trees whispered.' },
  { test: /\?\s*$/,
    text: ' Good question. The short answer is that it depends on a few things, and the most important one is what you are trying to accomplish, so let us start there and work outward.' },
  { test: /./,
    text: ' the beginning of a longer thought, one that most people finish differently depending on what they were thinking about a moment earlier, which is exactly the point of this exercise.' },
];
const ALT_POOL = [' the', ' a', ' an', ',', ' and', ' of', ' to', ' in', ' that', ' which', ' with', ' was', ' is', ' patient', ' scan', ' chest', ' MRI', ' X', ' history', ' then'];

const words = (s) => s.match(/\s*\S+/g) || [];
// Always returns a string: an empty prompt matches nothing above, so fall back to the last (generic) continuation.
const pickContinuation = (prompt) => (CONTINUATIONS.find(c => c.test.test(prompt)) || CONTINUATIONS.at(-1)).text;

function promptText(body, kind) {
  if (kind === 'chat') {
    if (!Array.isArray(body.messages)) return typeof body.messages === 'string' ? body.messages : '';
    return body.messages.map(m => (typeof m?.content === 'string' ? m.content : JSON.stringify(m?.content ?? ''))).join('\n');
  }
  return Array.isArray(body.prompt) ? body.prompt.join('\n') : String(body.prompt ?? '');
}

/** Chosen token first, then four distinct plausible alternatives, with decaying logprobs. */
function topFive(token, i, all) {
  const seen = new Set([token]);
  const out = [{ token, logprob: LOGPROB_LADDER[0] }];
  const candidates = [...all.slice(i + 1), ...ALT_POOL, ...all];
  for (const c of candidates) {
    if (out.length === 5) break;
    if (seen.has(c)) continue;
    seen.add(c); out.push({ token: c, logprob: LOGPROB_LADDER[out.length] });
  }
  return out;
}
const chatLogprobs = (top) => ({ content: [{ token: top[0].token, logprob: top[0].logprob, bytes: null, top_logprobs: top }] });
const legacyLogprobs = (top) => ({ tokens: [top[0].token], token_logprobs: [top[0].logprob], top_logprobs: [Object.fromEntries(top.map(t => [t.token, t.logprob]))], text_offset: [0] });

function plan(body, kind) {
  const prompt = promptText(body, kind);
  const all = words(pickContinuation(prompt));
  const maxTokens = Number.isInteger(body.max_tokens) && body.max_tokens > 0 ? body.max_tokens : MAX_TOKENS_DEFAULT;
  const n = Math.min(all.length, MAX_TOKENS_DEFAULT, maxTokens);
  const tokens = all.slice(0, n);
  // 'length' only when the caller's own max_tokens cut the continuation short; our 20-token cap reads as a natural stop.
  const finish = Number.isInteger(body.max_tokens) && body.max_tokens < all.length && n === body.max_tokens ? 'length' : 'stop';
  const wantLogprobs = kind === 'chat' ? Boolean(body.logprobs) : (body.logprobs != null && body.logprobs !== false);
  const model = getModel(body.model);
  const promptTokens = Math.ceil(prompt.length / 4);
  const price = model?.price || FALLBACK_PRICE;
  const cost = estimateCost({ price }, promptTokens, n);
  const usage = { prompt_tokens: promptTokens, completion_tokens: n, total_tokens: promptTokens + n, cost };
  return { tokens, all, finish, wantLogprobs, usage, id: `${kind === 'chat' ? 'gen' : 'cmpl'}-mock-${Date.now().toString(36)}`, model: body.model };
}

function chunk(p, kind, i) {
  const token = p.tokens[i];
  const top = p.wantLogprobs ? topFive(token, i, p.all) : null;
  const base = { id: p.id, object: kind === 'chat' ? 'chat.completion.chunk' : 'text_completion', created: Math.floor(Date.now() / 1000), model: p.model };
  if (kind === 'chat') return { ...base, choices: [{ index: 0, delta: { content: token }, logprobs: top ? chatLogprobs(top) : null, finish_reason: null }] };
  return { ...base, choices: [{ index: 0, text: token, logprobs: top ? legacyLogprobs(top) : null, finish_reason: null }] };
}
function finalChunk(p, kind) {
  const base = { id: p.id, object: kind === 'chat' ? 'chat.completion.chunk' : 'text_completion', created: Math.floor(Date.now() / 1000), model: p.model, usage: p.usage };
  if (kind === 'chat') return { ...base, choices: [{ index: 0, delta: {}, logprobs: null, finish_reason: p.finish }] };
  return { ...base, choices: [{ index: 0, text: '', logprobs: p.wantLogprobs ? { tokens: [], token_logprobs: [], top_logprobs: [], text_offset: [] } : null, finish_reason: p.finish }] };
}
function wholeCompletion(p, kind) {
  const text = p.tokens.join('');
  const tops = p.wantLogprobs ? p.tokens.map((t, i) => topFive(t, i, p.all)) : null;
  const base = { id: p.id, created: Math.floor(Date.now() / 1000), model: p.model, usage: p.usage };
  if (kind === 'chat') {
    const logprobs = tops ? { content: tops.map(top => ({ token: top[0].token, logprob: top[0].logprob, bytes: null, top_logprobs: top })) } : null;
    return { ...base, object: 'chat.completion', choices: [{ index: 0, message: { role: 'assistant', content: text }, logprobs, finish_reason: p.finish }] };
  }
  const logprobs = tops ? { tokens: tops.map(t => t[0].token), token_logprobs: tops.map(t => t[0].logprob), top_logprobs: tops.map(top => Object.fromEntries(top.map(t => [t.token, t.logprob]))), text_offset: tops.map(() => 0) } : null;
  return { ...base, object: 'text_completion', choices: [{ index: 0, text, logprobs, finish_reason: p.finish }] };
}

const sendJson = (res, status, obj) => { res.writeHead(status, { 'content-type': 'application/json' }); res.end(JSON.stringify(obj)); };
const sleep = (ms) => new Promise(r => setTimeout(r, ms));
const MAX_BODY_CHARS = 1e6;
const readBody = (req) => new Promise((resolve, reject) => {
  let s = '';
  req.on('data', c => { if (s.length < MAX_BODY_CHARS) s += c; });
  req.on('end', () => (s.length > MAX_BODY_CHARS ? reject(Object.assign(new Error('body too large'), { status: 413 })) : resolve(s)));
  req.on('error', reject);
});
const isPlainObject = (v) => v !== null && typeof v === 'object' && !Array.isArray(v);

export function createMock({ tokenMs = DEFAULT_TOKEN_MS, log = () => {} } = {}) {
  const handler = async (req, res) => {
    const url = new URL(req.url, 'http://mock');
    if (req.method === 'GET' && url.pathname === '/') return sendJson(res, 200, { ok: true, mock: 'openrouter', routes: ['/chat/completions', '/completions'] });
    const kind = url.pathname.endsWith('/chat/completions') ? 'chat' : url.pathname.endsWith('/completions') ? 'completion' : null;
    if (req.method !== 'POST' || !kind) return sendJson(res, 404, { error: { code: 404, message: `mock: no route for ${req.method} ${url.pathname}` } });
    const raw = await readBody(req); // rejects with status 413 when over MAX_BODY_CHARS; the outer catch answers
    let body;
    try { body = JSON.parse(raw || '{}'); } catch { return sendJson(res, 400, { error: { code: 400, message: 'mock: body is not JSON' } }); }
    if (!isPlainObject(body)) return sendJson(res, 400, { error: { code: 400, message: 'mock: body must be a JSON object' } });
    log(`${kind} ${body.model} stream=${body.stream !== false} logprobs=${body.logprobs ?? 'no'} max_tokens=${body.max_tokens ?? 'default'}`);
    if (body.model === 'mock/error') return sendJson(res, 500, { error: { code: 500, message: 'mock: simulated provider failure' } });

    const p = plan(body, kind);
    if (body.stream === false) return sendJson(res, 200, wholeCompletion(p, kind));

    res.writeHead(200, { 'content-type': 'text/event-stream; charset=utf-8', 'cache-control': 'no-store', connection: 'keep-alive' });
    const write = (obj) => res.write(`data: ${JSON.stringify(obj)}\n\n`);
    let open = true; res.on('close', () => { open = false; });
    if (kind === 'chat') write({ id: p.id, object: 'chat.completion.chunk', created: Math.floor(Date.now() / 1000), model: p.model, choices: [{ index: 0, delta: { role: 'assistant', content: '' }, logprobs: null, finish_reason: null }] });
    for (let i = 0; i < p.tokens.length && open; i++) {
      await sleep(tokenMs);
      if (!open) return; // the client may have gone away while we slept
      write(chunk(p, kind, i));
    }
    if (!open) return;
    write(finalChunk(p, kind));
    res.write('data: [DONE]\n\n');
    res.end();
  };
  // A thrown error must never take the whole mock down: answer 500 if we still can, otherwise just close the response.
  return http.createServer((req, res) => {
    handler(req, res).catch((err) => {
      log(`error: ${err?.message || err}`);
      const status = err?.status || 500;
      if (!res.headersSent) return sendJson(res, status, { error: { code: status, message: `mock: ${err?.message || 'internal error'}` } });
      res.end();
    });
  });
}

/** Start the mock on `port` (0 = ephemeral). Resolves with the listening http.Server. */
export function startMock(port = DEFAULT_PORT, opts = {}) {
  const server = createMock(opts);
  return new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(port, '127.0.0.1', () => resolve(server));
  });
}

if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  const port = Number(process.env.MOCK_PORT) || DEFAULT_PORT;
  startMock(port, { log: (m) => console.log(`[mock] ${m}`) })
    .then(() => console.log(`Mock OpenRouter listening on http://127.0.0.1:${port} (POST /chat/completions, /completions)`))
    .catch((err) => { console.error('mock: failed to start', err.message); process.exit(1); });
}
