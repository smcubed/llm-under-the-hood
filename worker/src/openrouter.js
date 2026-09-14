import { estimateCost } from '../../site/models.js';
import { parseSSE } from '../../site/sse.js';

// One copy of the SSE splitter serves both the Worker and the browser client (site/api.js).
export { parseSSE };

export function buildUpstream(v, baseUrl) {
  const m = v.model;
  // Always stream upstream so one code path handles every model; the router collects events when the client asked for stream:false.
  const common = { model: m.id, max_tokens: v.maxTokens, temperature: v.temperature, stream: true, usage: { include: true } };
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
    try { json = JSON.parse(raw); } catch { console.warn('openrouter: skipping unparseable SSE payload', raw.slice(0, 200)); return []; }
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
