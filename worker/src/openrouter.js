import { estimateCost } from '../../site/models.js';
import { parseSSE } from '../../site/sse.js';

// One copy of the SSE splitter serves both the Worker and the browser client (site/api.js).
export { parseSSE };

/** Reads up to `maxBytes` of a response body for server-side diagnostics (never sent to the client), then
 *  abandons the rest. Returns '' for a null/undefined stream. A body that ends on its own within the cap is
 *  left to close naturally; only an oversized body is explicitly cancelled. */
export async function readExcerpt(stream, maxBytes = 2000) {
  if (!stream) return '';
  const reader = stream.getReader();
  const dec = new TextDecoder();
  let text = '', total = 0, natural = false;
  try {
    while (total < maxBytes) {
      const { value, done } = await reader.read();
      if (done) { natural = true; break; }
      total += value.byteLength;
      text += dec.decode(value, { stream: true });
    }
  } catch { /* return what we have */ }
  if (!natural) { try { await reader.cancel(); } catch { /* already errored/closed */ } }
  try { reader.releaseLock(); } catch { /* already released by cancel */ }
  return text.slice(0, maxBytes);
}

/** Chat models do not reliably continue a trailing assistant message (OpenAI ones tend to start over), so a resumed or
 *  forked run sends the text so far as the assistant turn and then asks, in a user turn, for the continuation only. */
export const CONTINUE_INSTRUCTION = 'Continue your previous message exactly where it left off. Do not repeat any of it and do not add a preamble. Output only the continuation.';

/** Per-model request shaping from `model.upstream`: drop `omit`ted keys, then shallow-merge `extra` over the body. */
function applyUpstream(model, body) {
  const u = model.upstream;
  if (!u) return body;
  for (const k of u.omit || []) delete body[k];
  return { ...body, ...(u.extra || {}) };
}

export function buildUpstream(v, baseUrl) {
  const m = v.model;
  // Always stream upstream so one code path handles every model; the router collects events when the client asked for stream:false.
  const common = { model: m.id, max_tokens: v.maxTokens, temperature: v.temperature, stream: true, usage: { include: true } };
  if (m.endpoint === 'completion') {
    // A completion model continues text by construction: the prefix is simply appended to the prompt.
    const prompt = (v.system ? v.system + '\n\n' : '') + v.prompt + v.prefix;
    const body = { ...common, prompt };
    if (m.logprobs && v.topLogprobs > 0) body.logprobs = v.topLogprobs;
    return { url: `${baseUrl}/completions`, body: applyUpstream(m, body) };
  }
  const messages = [];
  if (v.system) messages.push({ role: 'system', content: v.system });
  messages.push({ role: 'user', content: v.prompt });
  if (v.prefix) messages.push({ role: 'assistant', content: v.prefix }, { role: 'user', content: CONTINUE_INSTRUCTION });
  const body = { ...common, messages };
  if (m.logprobs && v.topLogprobs > 0) { body.logprobs = true; body.top_logprobs = v.topLogprobs; }
  return { url: `${baseUrl}/chat/completions`, body: applyUpstream(m, body) };
}

// Chat-shaped logprobs (`logprobs.content[]`) carry the text too, so when they are present they are the only source of
// token events; the delta text is not emitted again. Without them, the plain text becomes one untinted token.
const fromChatLogprobs = (entries) => entries.map(e => ({ type: 'token', text: e.token, logprob: e.logprob, top: (e.top_logprobs || []).map(t => ({ text: t.token, logprob: t.logprob })) }));
const plainToken = (text) => (text ? [{ type: 'token', text, logprob: null, top: null }] : []);

function chatTokens(choice) {
  const lp = choice.logprobs?.content;
  if (Array.isArray(lp) && lp.length) return fromChatLogprobs(lp);
  return plainToken(choice.delta?.content);
}

function completionTokens(choice) {
  const lp = choice.logprobs;
  if (lp && Array.isArray(lp.tokens) && lp.tokens.length) {
    return lp.tokens.map((tok, i) => ({
      type: 'token', text: tok, logprob: lp.token_logprobs?.[i] ?? null,
      top: lp.top_logprobs?.[i] ? Object.entries(lp.top_logprobs[i]).map(([text, logprob]) => ({ text, logprob })).sort((a, b) => b.logprob - a.logprob) : null,
    }));
  }
  // OpenRouter may normalize the legacy shape to the chat one.
  if (Array.isArray(lp?.content) && lp.content.length) return fromChatLogprobs(lp.content);
  return plainToken(choice.text);
}

const UPSTREAM_ERROR_MESSAGES = {
  429: 'The model is busy right now. Try again in a moment.',
  402: 'The model provider budget is exhausted.',
};
const upstreamErrorMessage = (code) => UPSTREAM_ERROR_MESSAGES[Number(code)] || 'The model returned an error. Try another model.';

/**
 * Async generator: upstream SSE ReadableStream → normalized events.
 * Always ends with a `done` event, even after an error, so the caller can reconcile spend.
 * When upstream omits usage, tokens are estimated: completion = tokens yielded, prompt = ceil(promptChars / 3).
 */
export async function* normalizeUpstream(stream, model, { promptChars = 0 } = {}) {
  const reader = stream.getReader();
  const dec = new TextDecoder();
  let buf = '', usage = null, finish = null, sawDone = false, tokenCount = 0, errored = false, exhausted = false;

  // Turn one raw `data:` payload into zero or more normalized events, updating the closure state.
  const toEvents = (raw) => {
    if (raw.trim() === '[DONE]') { sawDone = true; return []; }
    let json;
    try { json = JSON.parse(raw); } catch { console.warn('openrouter: skipping unparseable SSE payload', `${raw.length} chars`); return []; } // length only: the payload could echo prompt text
    if (json.error) {
      console.error('openrouter: upstream error', JSON.stringify(json.error).slice(0, 500));
      errored = true;
      return [{ type: 'error', message: upstreamErrorMessage(json.error.code) }];
    }
    if (json.usage) usage = json.usage;
    const out = [];
    for (const choice of json.choices || []) {
      if (choice.finish_reason) finish = choice.finish_reason;
      const toks = model.endpoint === 'completion' ? completionTokens(choice) : chatTokens(choice);
      tokenCount += toks.length;
      out.push(...toks);
    }
    return out;
  };

  try {
    while (!errored) {
      const { value, done } = await reader.read();
      if (done) break;
      buf += dec.decode(value, { stream: true });
      const { events, rest } = parseSSE(buf);
      buf = rest;
      for (const raw of events) { for (const ev of toEvents(raw)) yield ev; if (errored) break; }
    }
    if (!errored) {
      // A final block with no trailing blank line is still a complete event once the stream ends.
      buf += dec.decode();
      for (const raw of parseSSE(buf + '\n\n').events) { for (const ev of toEvents(raw)) yield ev; if (errored) break; }
    }
    exhausted = true;
  } catch (err) {
    console.error('openrouter: upstream read failed', err?.message || err);
    errored = true;
    yield { type: 'error', message: 'The connection to the model dropped.' };
  } finally {
    // Upstream fully read: just release. Errored, or the consumer stopped iterating early: cancel so the socket is freed.
    if (exhausted && !errored) reader.releaseLock(); else reader.cancel().catch(() => {});
  }

  const prompt = usage?.prompt_tokens ?? Math.ceil(promptChars / 3);
  const completion = usage?.completion_tokens ?? tokenCount;
  const cost = typeof usage?.cost === 'number' ? usage.cost : estimateCost(model, prompt, completion);
  yield { type: 'done', usage: { prompt, completion }, cost, finish: sawDone ? finish : (finish ?? 'truncated') };
}
