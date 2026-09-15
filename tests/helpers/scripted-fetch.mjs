/**
 * Shared harness for the streaming tests: SSE response builders and a scripted stand-in for `fetch`.
 *
 *   sse(events)             one complete text/event-stream Response
 *   tok(text, logprob, top) a token event;  doneEvent(finish, { usage, cost }) a done event
 *   hanging(events)         a factory for a stream that sends its events and then hangs until the client aborts it
 *   installScriptedFetch()  → { calls, script, restore }
 *
 * `script(res)` queues a response for the next call to any model; `script(modelId, res)` queues one for the next call
 * sent for that model (so concurrent panes cannot race for the wrong response). A response may be a Response or a
 * function returning one (or a promise of one). The stub throws when nothing is scripted. Call `restore()` in afterEach.
 */
const encode = (events) => events.map(e => `data: ${JSON.stringify(e)}\n\n`).join('');

export const sse = (events, { status = 200 } = {}) => new Response(encode(events), { status, headers: { 'content-type': 'text/event-stream' } });
export const tok = (text, logprob = -0.1, top = null) => ({ type: 'token', text, logprob, top });
export const doneEvent = (finish = 'stop', { usage = { prompt: 3, completion: 2 }, cost = 0.00001 } = {}) => ({ type: 'done', usage, cost, finish });
export const hanging = (events) => () => new Response(new ReadableStream({
  start(c) { c.enqueue(new TextEncoder().encode(encode(events))); },
}), { status: 200 });

export function installScriptedFetch() {
  const calls = [];
  const anyQueue = [];
  const byModel = new Map();
  const realFetch = globalThis.fetch;
  globalThis.fetch = async (url, init) => {
    const body = init?.body ? JSON.parse(init.body) : {};   // GET /api/session and the like carry no body
    calls.push({ url, body, signal: init?.signal });
    const perModel = byModel.get(body.model);
    const next = (perModel || anyQueue).shift();
    if (!next) throw new Error(`test: no scripted response left for ${url}${perModel ? ` (model ${body.model})` : ''}`);
    return typeof next === 'function' ? next() : next;
  };
  const script = (modelOrRes, res) => {
    if (res === undefined) { anyQueue.push(modelOrRes); return; }
    if (!byModel.has(modelOrRes)) byModel.set(modelOrRes, []);
    byModel.get(modelOrRes).push(res);
  };
  return { calls, script, restore() { globalThis.fetch = realFetch; } };
}
