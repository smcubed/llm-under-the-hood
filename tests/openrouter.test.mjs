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
