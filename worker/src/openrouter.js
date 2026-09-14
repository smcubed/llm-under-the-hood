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
