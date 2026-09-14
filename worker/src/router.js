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
