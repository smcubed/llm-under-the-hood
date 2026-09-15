import { test } from 'node:test';
import assert from 'node:assert/strict';
import { startMock, coveredTokens } from '../tools/mock_openrouter.mjs';
import { parseSSE } from '../worker/src/openrouter.js';
import { getModel, estimateCost } from '../site/models.js';

// Ephemeral port; fast token cadence so the suite stays quick (the real default is ~60 ms per token).
async function withMock(fn) {
  const server = await startMock(0, { tokenMs: 1 });
  const base = `http://127.0.0.1:${server.address().port}`;
  try { await fn(base); } finally { await new Promise(r => server.close(r)); }
}
const post = (base, path, body) => fetch(base + path, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) });
async function readSSE(res) {
  assert.match(res.headers.get('content-type'), /text\/event-stream/);
  const { events, rest } = parseSSE((await res.text()) + '\n\n');
  assert.equal(rest.trim(), '');
  return events;
}
const chatPrompt = 'The patient presented with';

test('chat: streams prompt-aware tokens with 5 top_logprobs, usage.cost on the last chunk, then [DONE]', async () => {
  await withMock(async (base) => {
    const res = await post(base, '/chat/completions', { model: 'openai/gpt-4o-mini', messages: [{ role: 'user', content: chatPrompt }], stream: true, logprobs: true, top_logprobs: 5 });
    assert.equal(res.status, 200);
    const events = await readSSE(res);
    assert.equal(events.at(-1), '[DONE]');
    const chunks = events.slice(0, -1).map(e => JSON.parse(e));
    const tokenChunks = chunks.filter(c => c.choices[0].delta?.content);
    assert.ok(tokenChunks.length >= 10 && tokenChunks.length <= 20, `10–20 tokens, got ${tokenChunks.length}`);
    for (const c of tokenChunks) {
      const lp = c.choices[0].logprobs.content[0];
      assert.equal(lp.token, c.choices[0].delta.content);
      assert.equal(lp.top_logprobs.length, 5);
      assert.equal(lp.top_logprobs[0].token, c.choices[0].delta.content, 'chosen token is listed first');
      assert.equal(new Set(lp.top_logprobs.map(t => t.token)).size, 5, 'alternatives are distinct');
      for (let i = 1; i < 5; i++) assert.ok(lp.top_logprobs[i].logprob < lp.top_logprobs[i - 1].logprob, 'logprobs decay');
    }
    // Realistic probabilities: the chosen token's confidence varies from step to step (green, amber and red bands all
    // appear) and the five shown alternatives never account for the whole distribution.
    const chosen = tokenChunks.map(c => c.choices[0].logprobs.content[0].logprob);
    assert.ok(new Set(chosen).size >= 3, `chosen logprobs vary: ${[...new Set(chosen)].join(', ')}`);
    assert.ok(chosen.some(l => Math.exp(l) >= 0.6) && chosen.some(l => Math.exp(l) < 0.6 && Math.exp(l) >= 0.25) && chosen.some(l => Math.exp(l) < 0.25), 'all three bands occur');
    for (const c of tokenChunks) {
      const total = c.choices[0].logprobs.content[0].top_logprobs.reduce((s, t) => s + Math.exp(t.logprob), 0);
      assert.ok(total <= 0.95, `shown probabilities leave a remainder (sum ${total.toFixed(3)})`);
    }
    const last = chunks.at(-1);
    assert.equal(last.choices[0].finish_reason, 'stop');
    assert.equal(last.usage.prompt_tokens, Math.ceil(chatPrompt.length / 4));
    assert.equal(last.usage.completion_tokens, tokenChunks.length);
    assert.ok(last.usage.cost > 0);
    assert.ok(Math.abs(last.usage.cost - estimateCost(getModel('openai/gpt-4o-mini'), last.usage.prompt_tokens, last.usage.completion_tokens)) < 1e-15);
    const text = tokenChunks.map(c => c.choices[0].delta.content).join('');
    assert.match(text, /scan|CT|chest/i, 'a clinical prompt gets the clinical continuation');
  });
});

test('chat without logprobs: no logprobs on chunks', async () => {
  await withMock(async (base) => {
    const res = await post(base, '/chat/completions', { model: 'anthropic/claude-haiku-4.5', messages: [{ role: 'user', content: 'Why is the sky blue?' }], stream: true });
    const chunks = (await readSSE(res)).slice(0, -1).map(e => JSON.parse(e));
    assert.ok(chunks.filter(c => c.choices[0].delta?.content).every(c => c.choices[0].logprobs == null));
    assert.ok(chunks.at(-1).usage.cost > 0);
  });
});

test('completions: legacy shape with tokens/token_logprobs/top_logprobs maps', async () => {
  await withMock(async (base) => {
    const res = await post(base, '/completions', { model: 'openai/gpt-3.5-turbo-instruct', prompt: chatPrompt, stream: true, logprobs: 5 });
    const events = await readSSE(res);
    assert.equal(events.at(-1), '[DONE]');
    const chunks = events.slice(0, -1).map(e => JSON.parse(e));
    const tokenChunks = chunks.filter(c => c.choices[0].text);
    assert.ok(tokenChunks.length >= 10);
    for (const c of tokenChunks) {
      const lp = c.choices[0].logprobs;
      assert.deepEqual(lp.tokens, [c.choices[0].text]);
      assert.equal(lp.token_logprobs.length, 1);
      assert.equal(Object.keys(lp.top_logprobs[0]).length, 5);
      assert.equal(lp.top_logprobs[0][c.choices[0].text], lp.token_logprobs[0]);
      assert.equal(c.choices[0].delta, undefined);
    }
    assert.equal(chunks.at(-1).usage.prompt_tokens, Math.ceil(chatPrompt.length / 4));
    assert.ok(chunks.at(-1).usage.cost > 0);
  });
});

test('max_tokens: 1 sends exactly one token and finish_reason length', async () => {
  await withMock(async (base) => {
    const res = await post(base, '/chat/completions', { model: 'openai/gpt-4o-mini', messages: [{ role: 'user', content: chatPrompt }], stream: true, max_tokens: 1, logprobs: true, top_logprobs: 5 });
    const chunks = (await readSSE(res)).slice(0, -1).map(e => JSON.parse(e));
    const tokenChunks = chunks.filter(c => c.choices[0].delta?.content);
    assert.equal(tokenChunks.length, 1);
    assert.equal(chunks.at(-1).choices[0].finish_reason, 'length');
    assert.equal(chunks.at(-1).usage.completion_tokens, 1);
    const res2 = await post(base, '/completions', { model: 'openai/gpt-3.5-turbo-instruct', prompt: chatPrompt, stream: true, max_tokens: 1 });
    const chunks2 = (await readSSE(res2)).slice(0, -1).map(e => JSON.parse(e));
    assert.equal(chunks2.filter(c => c.choices[0].text).length, 1);
  });
});

test('a prefix the client already wrote is not repeated: chat assistant message, completion prompt, and a used-up continuation', async () => {
  await withMock(async (base) => {
    const first = async (body, path = '/chat/completions') => {
      const chunks = (await readSSE(await post(base, path, { ...body, stream: true }))).slice(0, -1).map(e => JSON.parse(e));
      return chunks.filter(c => c.choices[0].delta?.content || c.choices[0].text).map(c => c.choices[0].delta?.content ?? c.choices[0].text);
    };
    const fresh = await first({ model: 'openai/gpt-4o-mini', messages: [{ role: 'user', content: chatPrompt }] });
    assert.deepEqual(fresh.slice(0, 3), [' a', ' CT', ' scan']);
    const resumed = await first({ model: 'openai/gpt-4o-mini', messages: [{ role: 'user', content: chatPrompt }, { role: 'assistant', content: ' a CT scan' }] });
    assert.deepEqual(resumed.slice(0, 3), [' of', ' the', ' chest,'], 'picks up after the assistant prefix');
    const forked = await first({ model: 'openai/gpt-4o-mini', messages: [{ role: 'user', content: chatPrompt }, { role: 'assistant', content: ' an MRI' }] });
    assert.deepEqual(forked.slice(0, 2), [' a', ' CT'], 'an unrelated prefix starts the canned text from the top');
    const legacy = await first({ model: 'openai/gpt-3.5-turbo-instruct', prompt: `${chatPrompt} a CT scan of`, logprobs: 5 }, '/completions');
    assert.deepEqual(legacy.slice(0, 2), [' the', ' chest,'], 'a completion prompt ending in canned text continues it');
    const whole = ' a CT scan of the chest, which showed a small pulmonary nodule in the right upper lobe, and the team recommended follow-up imaging in three months to watch for any change.';
    const exhausted = await first({ model: 'openai/gpt-4o-mini', messages: [{ role: 'user', content: chatPrompt }, { role: 'assistant', content: whole }] });
    assert.ok(exhausted.length >= 10, 'a used-up continuation moves on to the generic text instead of ending empty');
    assert.equal(exhausted[0], ' the');
    // A resumed stream continues the confidence cycle rather than restarting it at "green".
    const res = await post(base, '/chat/completions', { model: 'openai/gpt-4o-mini', messages: [{ role: 'user', content: chatPrompt }, { role: 'assistant', content: ' a' }], stream: true, logprobs: true, top_logprobs: 5 });
    const chunks = (await readSSE(res)).slice(0, -1).map(e => JSON.parse(e));
    assert.equal(chunks.find(c => c.choices[0].delta?.content).choices[0].logprobs.content[0].logprob, -0.6);
  });
});

test('coveredTokens counts the leading canned tokens a prefix already ends with', () => {
  const all = [' a', ' CT', ' scan'];
  assert.equal(coveredTokens(all, ''), 0);
  assert.equal(coveredTokens(all, 'The patient presented with a CT'), 2);
  assert.equal(coveredTokens(all, ' a CT scan'), 3);
  assert.equal(coveredTokens(all, ' an MRI'), 0);
  assert.equal(coveredTokens(all, 'scan'), 0, 'must match whole tokens from the start of the canned text');
});

test('stream:false returns one JSON completion object', async () => {
  await withMock(async (base) => {
    const res = await post(base, '/chat/completions', { model: 'openai/gpt-4o-mini', messages: [{ role: 'user', content: chatPrompt }], stream: false, logprobs: true, top_logprobs: 5 });
    assert.equal(res.status, 200); assert.match(res.headers.get('content-type'), /application\/json/);
    const j = await res.json();
    assert.equal(j.object, 'chat.completion');
    assert.ok(j.choices[0].message.content.length > 0);
    assert.equal(j.choices[0].logprobs.content.length, j.usage.completion_tokens);
    assert.ok(j.usage.cost > 0);
    const res2 = await post(base, '/completions', { model: 'openai/gpt-3.5-turbo-instruct', prompt: chatPrompt, stream: false });
    const j2 = await res2.json();
    assert.equal(j2.object, 'text_completion'); assert.ok(j2.choices[0].text.length > 0);
  });
});

test('model mock/error → 500; unknown route → 404', async () => {
  await withMock(async (base) => {
    const res = await post(base, '/chat/completions', { model: 'mock/error', messages: [{ role: 'user', content: 'hi' }], stream: true });
    assert.equal(res.status, 500); assert.ok((await res.json()).error);
    assert.equal((await post(base, '/nope', {})).status, 404);
  });
});

test('malformed bodies get an HTTP response and the server survives', async () => {
  await withMock(async (base) => {
    const raw = (body) => fetch(base + '/chat/completions', { method: 'POST', headers: { 'content-type': 'application/json' }, body });
    // Non-object JSON is refused; an object with odd field types is tolerated and still streams.
    const expected = { '': 400, 'null': 400, '5': 400, '[]': 400, '{"messages":"hi"}': 200, '{"prompt":""}': 200 };
    for (const [body, status] of Object.entries(expected)) {
      const res = await raw(body);
      assert.equal(res.status, status, `${JSON.stringify(body)} → ${res.status}`);
      await res.text();
    }
    // Same bodies against the legacy route, including the empty-prompt one which must still produce tokens.
    const expectedLegacy = { 'null': 400, '[]': 400, '{"prompt":""}': 200, '{"prompt":"","stream":false}': 200 };
    for (const [body, status] of Object.entries(expectedLegacy)) {
      const res = await fetch(base + '/completions', { method: 'POST', headers: { 'content-type': 'application/json' }, body });
      assert.equal(res.status, status, `${JSON.stringify(body)} → ${res.status}`);
      await res.text();
    }
    const okAfter = await post(base, '/chat/completions', { model: 'openai/gpt-4o-mini', messages: [{ role: 'user', content: chatPrompt }], stream: false });
    assert.equal(okAfter.status, 200, 'the server is still serving after bad bodies');
    assert.ok((await okAfter.json()).usage.completion_tokens >= 10);
    const big = await raw(JSON.stringify({ model: 'openai/gpt-4o-mini', messages: [{ role: 'user', content: 'x'.repeat(1_100_000) }] }));
    assert.equal(big.status, 413, 'bodies over 1e6 chars are refused');
    await big.text();
  });
});
