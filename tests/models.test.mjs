import { test } from 'node:test';
import assert from 'node:assert/strict';
import { MODELS, DEFAULT_MODEL, LIMITS, getModel } from '../site/models.js';

test('ladder has the eight approved models with required fields', () => {
  const ids = MODELS.map(m => m.id);
  assert.deepEqual(ids, [
    'openai/gpt-3.5-turbo-instruct', 'openai/gpt-3.5-turbo', 'openai/gpt-4', 'openai/gpt-4o-mini',
    'anthropic/claude-haiku-4.5', 'openai/gpt-5-mini', 'google/gemini-3.5-flash-lite',
    'meta-llama/llama-3.3-70b-instruct',
  ]);
  for (const m of MODELS) {
    for (const k of ['id','label','year','provider','open','logprobs','endpoint','tokenizer','bucket','price'])
      assert.ok(k in m, `${m.id} missing ${k}`);
    assert.ok(['chat','completion'].includes(m.endpoint));
    assert.ok(['o200k','cl100k'].includes(m.tokenizer));
    assert.equal(typeof m.price.in, 'number'); assert.equal(typeof m.price.out, 'number');
  }
});
test('default model exists and supports logprobs', () => {
  assert.equal(getModel(DEFAULT_MODEL).logprobs, true);
});
test('getModel returns undefined for unknown id', () => assert.equal(getModel('nope/x'), undefined));
test('limits are the design values', () => {
  assert.deepEqual(LIMITS, { promptChars: 200, systemChars: 400, prefixChars: 1500, maxTokens: 200, topLogprobs: 10, temperatureMax: 1.5 });
});
