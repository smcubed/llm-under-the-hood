import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { buildUpstream, normalizeUpstream, parseSSE, CONTINUE_INSTRUCTION } from '../worker/src/openrouter.js';
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
test('buildUpstream: always asks upstream to stream, even when the client asked for stream:false', () => {
  const v = { ...base, model: getModel('openai/gpt-4o-mini'), stream: false };
  assert.equal(buildUpstream(v, 'x').body.stream, true);
  const c = { ...base, model: getModel('openai/gpt-3.5-turbo-instruct'), stream: false };
  assert.equal(buildUpstream(c, 'x').body.stream, true);
});
test('buildUpstream: system and prefix become system + assistant-so-far + an explicit continue instruction', () => {
  const v = { ...base, model: getModel('openai/gpt-4o-mini'), system: 'Be brief.', prefix: ' A CT' };
  const { body } = buildUpstream(v, 'x');
  assert.deepEqual(body.messages, [
    { role: 'system', content: 'Be brief.' },
    { role: 'user', content: 'The patient presented with' },
    { role: 'assistant', content: ' A CT' },
    { role: 'user', content: CONTINUE_INSTRUCTION },
  ]);
  assert.equal(body.messages.length, 4);
});
test('buildUpstream: chat prefix without a system prompt is user, assistant, continue; no prefix means no continue message', () => {
  const { body } = buildUpstream({ ...base, model: getModel('anthropic/claude-haiku-4.5'), prefix: ' A CT' }, 'x');
  assert.deepEqual(body.messages.map(m => m.role), ['user', 'assistant', 'user']);
  assert.equal(body.messages.at(-1).content, CONTINUE_INSTRUCTION);
  assert.match(CONTINUE_INSTRUCTION, /continue/i);
  const plain = buildUpstream({ ...base, model: getModel('anthropic/claude-haiku-4.5') }, 'x').body;
  assert.deepEqual(plain.messages.map(m => m.role), ['user']);
});
test('buildUpstream: per-model upstream params drop omitted keys and merge extras (gpt-5-mini)', () => {
  const { body } = buildUpstream({ ...base, model: getModel('openai/gpt-5-mini'), topLogprobs: 0 }, 'x');
  assert.equal('temperature' in body, false);
  assert.equal(body.reasoning?.effort, 'minimal');
  assert.equal(body.max_tokens, 50); assert.equal(body.stream, true); assert.equal(body.model, 'openai/gpt-5-mini');
  // Other models are untouched.
  const other = buildUpstream({ ...base, model: getModel('openai/gpt-4o-mini') }, 'x').body;
  assert.equal(other.temperature, 0.7); assert.equal('reasoning' in other, false);
  const legacy = buildUpstream({ ...base, model: getModel('openai/gpt-3.5-turbo-instruct') }, 'x').body;
  assert.equal(legacy.temperature, 0.7); assert.equal('reasoning' in legacy, false);
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

test('parseSSE joins multiple data: lines in one block with newlines', () => {
  const { events } = parseSSE('data: line one\ndata: line two\n\ndata: {"z":1}\n\n');
  assert.deepEqual(events, ['line one\nline two', '{"z":1}']);
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
async function collectText(text, modelId, opts) {
  const out = []; for await (const e of normalizeUpstream(new Response(text).body, getModel(modelId), opts)) out.push(e);
  return out;
}
test('normalize maps an upstream error object to a fixed message keyed on code, never the raw text', async () => {
  const errOf = async (code) => collectText(`data: {"error":{"message":"internal detail ${code}","code":${code}}}\n\n`, 'openai/gpt-4o-mini');
  const busy = await errOf(429);
  assert.equal(busy[0].type, 'error'); assert.equal(busy[0].message, 'The model is busy right now. Try again in a moment.');
  assert.equal(busy.at(-1).type, 'done');
  assert.equal((await errOf(402))[0].message, 'The model provider budget is exhausted.');
  const other = await errOf(500);
  assert.equal(other[0].message, 'The model returned an error. Try another model.');
  assert.doesNotMatch(JSON.stringify(other), /internal detail/);
});

test('normalize: a chat chunk carrying BOTH delta.content and logprobs.content emits one event per logprob entry, not both', async () => {
  const body = 'data: {"choices":[{"delta":{"content":" CT scan"},"logprobs":{"content":[{"token":" CT","logprob":-0.5,"top_logprobs":[]},{"token":" scan","logprob":-0.1,"top_logprobs":[]}]}}]}\n\ndata: [DONE]\n\n';
  const ev = await collectText(body, 'openai/gpt-4o-mini');
  assert.deepEqual(ev.filter(e => e.type === 'token').map(e => e.text), [' CT', ' scan']);
  assert.equal(ev.at(-1).usage.completion, 2);
});
test('normalize: a chat chunk with delta.content and an empty logprobs.content emits the delta text once', async () => {
  const body = 'data: {"choices":[{"delta":{"content":" CT"},"logprobs":{"content":[]}}]}\n\ndata: [DONE]\n\n';
  const ev = await collectText(body, 'openai/gpt-4o-mini');
  assert.deepEqual(ev.filter(e => e.type === 'token'), [{ type: 'token', text: ' CT', logprob: null, top: null }]);
});
test('normalize: the completion endpoint also accepts a chat-shaped logprobs.content[] (OpenRouter may normalize)', async () => {
  const body = 'data: {"choices":[{"text":" chest","logprobs":{"content":[{"token":" chest","logprob":-0.3,"top_logprobs":[{"token":" chest","logprob":-0.3},{"token":" CT","logprob":-1.5}]}]},"finish_reason":null}]}\n\ndata: [DONE]\n\n';
  const ev = await collectText(body, 'openai/gpt-3.5-turbo-instruct');
  assert.equal(ev[0].text, ' chest'); assert.equal(ev[0].logprob, -0.3);
  assert.deepEqual(ev[0].top, [{ text: ' chest', logprob: -0.3 }, { text: ' CT', logprob: -1.5 }]);
  assert.equal(ev.filter(e => e.type === 'token').length, 1);
});
test('normalize: an unparseable payload is skipped and the warning logs only its length, never its content', async () => {
  const orig = console.warn; const calls = [];
  console.warn = (...a) => calls.push(a.map(String).join(' '));
  try {
    const ev = await collectText('data: {"secret":"patient-name-here"\n\ndata: {"choices":[{"delta":{"content":"ok"}}]}\n\ndata: [DONE]\n\n', 'anthropic/claude-haiku-4.5');
    assert.deepEqual(ev.filter(e => e.type === 'token').map(e => e.text), ['ok']);
  } finally { console.warn = orig; }
  assert.equal(calls.length, 1);
  assert.doesNotMatch(calls[0], /patient-name-here|secret/);
  assert.match(calls[0], /\b29\b/, 'reports the payload length');
});

// I1: no usage block → estimate from what we saw; no [DONE] → finish 'truncated'
test('normalize estimates usage when upstream omits it and marks a stream that ended without [DONE] as truncated', async () => {
  const body = 'data: {"choices":[{"delta":{"content":"Hi"}}]}\n\ndata: {"choices":[{"delta":{"content":" there"}}]}\n\n';
  const ev = await collectText(body, 'anthropic/claude-haiku-4.5', { promptChars: 30 });
  assert.equal(ev.length, 3);
  const done = ev.at(-1);
  assert.equal(done.type, 'done');
  assert.deepEqual(done.usage, { prompt: 10, completion: 2 });
  assert.ok(Math.abs(done.cost - (10 * 1 + 2 * 5) / 1e6) < 1e-15);
  assert.equal(done.finish, 'truncated');
});
test('normalize keeps the upstream finish reason when [DONE] arrives', async () => {
  const ev = await collect('chat_plain.sse', 'anthropic/claude-haiku-4.5');
  assert.equal(ev.at(-1).finish, 'stop');
});

// I2: last block without a trailing blank line must still be processed
test('normalize processes a trailing SSE block that lacks the final blank line', async () => {
  const text = (await fx('chat_plain.sse')).replace(/\n\ndata: \[DONE\]\n\n$/, '');
  assert.ok(!text.endsWith('\n\n'), 'fixture variant should end mid-block');
  const ev = await collectText(text, 'anthropic/claude-haiku-4.5', { promptChars: 5 });
  const done = ev.at(-1);
  assert.deepEqual(done.usage, { prompt: 12, completion: 4 });
  assert.equal(done.finish, 'stop');
});

// I3: upstream read error mid-stream → error event, then done with estimates
test('normalize turns an upstream read failure into an error event followed by done', async () => {
  const enc = new TextEncoder(); let pulls = 0;
  const stream = new ReadableStream({
    pull(c) {
      pulls++;
      if (pulls === 1) return c.enqueue(enc.encode('data: {"choices":[{"delta":{"content":"A CT"}}]}\n\n'));
      throw new Error('socket hang up');
    },
  });
  const out = []; for await (const e of normalizeUpstream(stream, getModel('anthropic/claude-haiku-4.5'), { promptChars: 9 })) out.push(e);
  assert.equal(out[0].type, 'token'); assert.equal(out[0].text, 'A CT');
  assert.deepEqual(out[1], { type: 'error', message: 'The connection to the model dropped.' });
  const done = out[2];
  assert.equal(done.type, 'done'); assert.deepEqual(done.usage, { prompt: 3, completion: 1 }); assert.equal(done.finish, 'truncated');
  assert.ok(Math.abs(done.cost - (3 * 1 + 1 * 5) / 1e6) < 1e-15);
  assert.equal(out.length, 3);
});

// M7: chunk boundaries anywhere must not change the result
test('normalize gives identical events when the fixture arrives one byte at a time', async () => {
  const bytes = new TextEncoder().encode(await fx('chat_logprobs.sse'));
  let i = 0;
  const trickle = new ReadableStream({ pull(c) { if (i >= bytes.length) return c.close(); c.enqueue(bytes.slice(i, i + 1)); i++; } });
  const slow = []; for await (const e of normalizeUpstream(trickle, getModel('openai/gpt-4o-mini'))) slow.push(e);
  const fast = await collect('chat_logprobs.sse', 'openai/gpt-4o-mini');
  assert.deepEqual(slow, fast);
  assert.equal(slow.length, 3);
});
test('normalize cancels the upstream reader when the consumer stops iterating early', async () => {
  const enc = new TextEncoder(); let cancelled = false;
  const stream = new ReadableStream({
    pull(c) { c.enqueue(enc.encode('data: {"choices":[{"delta":{"content":"x"}}]}\n\n')); },
    cancel() { cancelled = true; },
  });
  for await (const e of normalizeUpstream(stream, getModel('openai/gpt-4o-mini'))) { if (e.type === 'token') break; }
  assert.equal(cancelled, true);
});
