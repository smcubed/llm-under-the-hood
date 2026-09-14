import { parseSSE } from './sse.js';

const JSON_HEADERS = { 'content-type': 'application/json' };

async function safeJson(response) {
  try { return await response.json(); } catch { return null; }
}

const abortError = () => new DOMException('The request was aborted.', 'AbortError');

/** True when the signed session cookie is still valid. */
export async function checkSession() {
  return (await fetch('/api/session')).status === 204;
}

/** → { ok: true } or { ok: false, message }. */
export async function login(passcode) {
  const r = await fetch('/api/auth', { method: 'POST', headers: JSON_HEADERS, body: JSON.stringify({ passcode }) });
  if (r.status === 204) return { ok: true };
  return { ok: false, message: (await safeJson(r))?.message || 'Could not sign in.' };
}

/**
 * Stream one generation (this client always streams). `params`: { model, prompt, system, prefix, maxTokens,
 * temperature, topLogprobs }. Every normalized event ({type:'token'|'error'|'done'}) is passed to `onEvent`; resolves
 * with the `done` event, or null if the stream ended without one. Rejects with Error(message) (plus `.status`) for
 * HTTP errors; with Error(message) (plus `fromStream: true`) once the stream ends if it carried an `error` event; and
 * with an AbortError when `signal` is aborted. On any rejection the body is cancelled and no more events are delivered.
 */
export async function generate(params, { onEvent = () => {}, signal } = {}) {
  if (signal?.aborted) throw abortError();
  const { model, prompt, system = '', prefix = '', maxTokens, temperature, topLogprobs } = params;
  const body = { model, prompt, system, prefix, maxTokens, temperature, topLogprobs, stream: true };
  const r = await fetch('/api/generate', { method: 'POST', headers: JSON_HEADERS, body: JSON.stringify(body), signal });
  if (!r.ok) {
    const message = (await safeJson(r))?.message || `The server returned an error (${r.status}). Try again in a moment.`;
    throw Object.assign(new Error(message), { status: r.status });
  }
  if (!r.body) return null;

  const reader = r.body.getReader();
  const onAbort = () => { reader.cancel().catch(() => {}); };
  signal?.addEventListener('abort', onAbort, { once: true });
  const decoder = new TextDecoder();
  let buffer = '', done = null, streamError = null;
  const deliver = (raw) => {
    let ev;
    try { ev = JSON.parse(raw); } catch { return; }
    if (ev.type === 'done') done = ev;
    if (ev.type === 'error' && !streamError) streamError = ev;
    onEvent(ev);
  };
  const checkAbort = () => { if (signal?.aborted) throw abortError(); };
  try {
    for (;;) {
      const { value, done: finished } = await reader.read();
      checkAbort();
      if (finished) break;
      buffer += decoder.decode(value, { stream: true });
      const parsed = parseSSE(buffer);
      buffer = parsed.rest;
      for (const raw of parsed.events) { checkAbort(); deliver(raw); }
    }
    buffer += decoder.decode();
    for (const raw of parseSSE(buffer + '\n\n').events) deliver(raw);
  } catch (err) {
    reader.cancel().catch(() => {});
    if (signal?.aborted) throw abortError();
    throw err;
  } finally {
    signal?.removeEventListener('abort', onAbort);
  }
  if (streamError) throw Object.assign(new Error(streamError.message || 'The model returned an error.'), { fromStream: true });
  return done;
}
