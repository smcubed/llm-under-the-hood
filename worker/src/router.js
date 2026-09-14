import { MODELS, estimateCost } from '../../site/models.js';
import { validateGenerate } from './validate.js';
import { buildUpstream, normalizeUpstream } from './openrouter.js';
import { issueSession, verifySession, sessionCookieHeader, readCookie, passcodeMatches } from './session.js';

const json = (status, obj, headers = {}) => new Response(JSON.stringify(obj), { status, headers: { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store', ...headers } });
const num = (v, d) => { const n = Number(v); return Number.isFinite(n) ? n : d; };
/** Seconds until the daily budgets reset (next UTC midnight). */
export const secondsToUtcMidnight = (nowMs = Date.now()) => {
  const d = new Date(nowMs);
  return Math.max(1, Math.ceil((Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate() + 1) - nowMs) / 1000));
};

async function readJson(request) { try { return await request.json(); } catch { return null; } }

const REQUIRED_SECRETS = ['PASSCODE', 'COOKIE_SECRET', 'OPENROUTER_API_KEY'];

export async function handle(request, env, ctx) {
  const url = new URL(request.url);
  if (url.pathname.startsWith('/api/')) {
    const missing = REQUIRED_SECRETS.filter(k => !env[k]);
    if (missing.length) {
      console.error(`Server is not configured: missing ${missing.join(', ')}. Set with: wrangler secret put <NAME>`);
      return json(500, { message: 'Server is not configured.' });
    }
  }
  const ledger = env.LEDGER.getByName('global');
  const ip = request.headers.get('cf-connecting-ip') || 'unknown';

  if (url.pathname === '/api/auth' && request.method === 'POST') {
    const gate = await ledger.hit(`auth:${ip}`, num(env.AUTH_ATTEMPTS_PER_MINUTE, 10));
    if (!gate.ok) return json(429, { message: 'Too many attempts. Wait a minute and try again.' }, { 'retry-after': String(gate.retryAfterSec) });
    const body = await readJson(request);
    const supplied = typeof body?.passcode === 'string' ? body.passcode.trim() : '';
    if (!(await passcodeMatches(supplied, env.PASSCODE, env.COOKIE_SECRET))) return json(401, { message: 'That passcode is not right.' });
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
    // Per-IP limit first (so an IP-limited request does not consume a client slot), then the per-client limit (cookie)
    // so re-authenticating for a fresh client id does not reset the budget of requests.
    const ipl = await ledger.hit(`ip:${ip}`, num(env.PER_IP_PER_MINUTE, 60));
    if (!ipl.ok) return json(429, { message: 'Too many requests from this network right now. Try again in a moment.' }, { 'retry-after': String(ipl.retryAfterSec) });
    const rl = await ledger.hit(sess.clientId, num(env.PER_CLIENT_PER_MINUTE, 30));
    if (!rl.ok) return json(429, { message: 'You are sending requests quickly. Take a breath and try again in a moment.' }, { 'retry-after': String(rl.retryAfterSec) });
    const { model } = v.value;
    const budget = model.bucket === 'gpt4' ? num(env.GPT4_DAILY_BUDGET_USD, 1) : num(env.DAILY_BUDGET_USD, 5);

    // Reserve a conservative estimate before calling upstream, then reconcile against the real cost on `done`.
    // The budget check and the reservation are one ledger call, so two concurrent requests cannot both pass the check.
    // If the client disconnects (or we crash) before `done`, the reservation stands as the charge.
    const promptChars = v.value.prompt.length + v.value.system.length + v.value.prefix.length;
    const reserved = estimateCost(model, Math.ceil(promptChars / 3), v.value.maxTokens);
    if (!(await ledger.reserveIfUnder(model.bucket, reserved, budget))) {
      return json(429, { message: model.bucket === 'gpt4' ? 'Today\'s class budget for GPT-4 is used up. Try a cheaper model or come back tomorrow.' : 'Today\'s class budget is used up. Please come back tomorrow.' }, { 'retry-after': String(secondsToUtcMidnight()) });
    }
    const refund = () => ctx.waitUntil(ledger.charge(model.bucket, -reserved));
    const { url: upUrl, body: upBody } = buildUpstream(v.value, env.OPENROUTER_BASE_URL);
    const doFetch = env.fetchUpstream || fetch;
    let up;
    try {
      up = await doFetch(upUrl, { method: 'POST', headers: { 'content-type': 'application/json', Authorization: `Bearer ${env.OPENROUTER_API_KEY}`, 'HTTP-Referer': url.origin, 'X-Title': env.SITE_TITLE || 'LLM Under the Hood' }, body: JSON.stringify(upBody) });
    } catch (err) {
      refund();
      console.error('generate: upstream fetch failed', err?.message || err);
      return json(502, { message: 'Could not reach the model provider. Try again in a moment.' });
    }
    if (!up.ok || !up.body) {
      refund();
      up.body?.cancel().catch(() => {});
      console.error('generate: upstream returned', up.status);
      const headers = {};
      const retryAfter = up.headers.get('retry-after');
      if (up.status === 429 && retryAfter) headers['retry-after'] = retryAfter;
      return json(502, { message: `The model provider returned an error (${up.status}). Try again or pick another model.` }, headers);
    }

    const events = normalizeUpstream(up.body, model, { promptChars });
    const reconcile = async (cost) => {
      try { await ledger.charge(model.bucket, cost - reserved); }
      catch (err) { console.error('generate: reconciling spend failed; reservation stands', err?.message || err); }
    };

    // Client-facing stream (only when the client asked to stream; otherwise events are collected and returned as JSON).
    // cancel() only marks the client gone; the pump below keeps draining upstream (under ctx.waitUntil)
    // so the `done` event, and therefore the real cost, is always reached.
    const enc = new TextEncoder();
    let controller = null, clientGone = false;
    const collected = v.value.stream ? null : [];
    const readable = collected ? null : new ReadableStream({
      start(c) { controller = c; },
      cancel() { clientGone = true; controller = null; },
    });
    const send = (ev) => {
      if (collected) { collected.push(ev); return; }
      if (clientGone || !controller) return;
      try { controller.enqueue(enc.encode(`data: ${JSON.stringify(ev)}\n\n`)); }
      catch { clientGone = true; controller = null; }
    };
    const pump = (async () => {
      try {
        for await (const ev of events) {
          if (ev.type === 'done') await reconcile(ev.cost);
          send(ev);
        }
      } catch (err) {
        console.error('generate: pump failed; reservation stands as the charge', err?.message || err);
        send({ type: 'error', message: 'The connection to the model dropped.' });
      } finally {
        if (!clientGone && controller) { try { controller.close(); } catch { /* already closed */ } }
      }
    })();
    if (collected) { await pump; return json(200, { events: collected }); }
    // Streaming: the response returns now, so keep the pump alive past the client's disconnect.
    ctx.waitUntil(pump);
    return new Response(readable, { status: 200, headers: { 'content-type': 'text/event-stream; charset=utf-8', 'cache-control': 'no-store', 'x-accel-buffering': 'no' } });
  }

  if (url.pathname.startsWith('/api/')) return json(404, { message: 'Not found.' });
  return env.ASSETS.fetch(request);
}
