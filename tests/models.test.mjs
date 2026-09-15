import { test } from 'node:test';
import assert from 'node:assert/strict';
import { MODELS, DEFAULT_MODEL, AUTOCOMPLETE_MODEL, LIMITS, getModel, estimateCost, eraGroup } from '../site/models.js';

test('ladder has the eight approved models with required fields', () => {
  const ids = MODELS.map(m => m.id);
  assert.deepEqual(ids, [
    'openai/gpt-3.5-turbo-instruct', 'openai/gpt-3.5-turbo', 'openai/gpt-4', 'openai/gpt-4o-mini',
    'anthropic/claude-haiku-4.5', 'openai/gpt-5-mini', 'google/gemini-3.5-flash-lite',
    'meta-llama/llama-3.3-70b-instruct',
  ]);
  for (const m of MODELS) {
    for (const k of ['id','label','year','provider','open','logprobs','endpoint','tokenizer','bucket','price','exactTokenizer'])
      assert.ok(k in m, `${m.id} missing ${k}`);
    assert.ok(['chat','completion'].includes(m.endpoint));
    assert.ok(['o200k','cl100k'].includes(m.tokenizer));
    assert.equal(typeof m.price.in, 'number'); assert.equal(typeof m.price.out, 'number');
    assert.equal(typeof m.exactTokenizer, 'boolean', `${m.id} exactTokenizer`);
    assert.equal(m.exactTokenizer, m.provider === 'OpenAI', `${m.id}: only OpenAI models use the vendored encodings exactly`);
  }
});
test('default model exists and supports logprobs', () => {
  assert.equal(getModel(DEFAULT_MODEL).logprobs, true);
});
test('getModel returns undefined for unknown id', () => assert.equal(getModel('nope/x'), undefined));
test('limits are the design values', () => {
  assert.deepEqual(LIMITS, { promptChars: 200, systemChars: 400, prefixChars: 1500, maxTokens: 200, topLogprobs: 10, temperatureMax: 1.5 });
});
test('autocomplete model exists and uses the completion endpoint', () => {
  assert.equal(getModel(AUTOCOMPLETE_MODEL).endpoint, 'completion');
});
test('model ids are unique', () => {
  assert.equal(new Set(MODELS.map(m => m.id)).size, MODELS.length);
});
test('estimateCost uses per-million prices and treats missing counts as 0', () => {
  const m = getModel('openai/gpt-4o-mini');
  assert.equal(estimateCost(m, 1e6, 1e6), 0.75);
  assert.equal(estimateCost(m, undefined, undefined), 0);
  assert.equal(estimateCost(m, 'abc', null), 0);
});
test('model entries, their prices, and the ladder are frozen', () => {
  assert.ok(Object.isFrozen(MODELS));
  for (const m of MODELS) { assert.ok(Object.isFrozen(m)); assert.ok(Object.isFrozen(m.price)); }
  assert.throws(() => { MODELS[0].price.in = 0; }, TypeError);
  assert.throws(() => { MODELS[0].label = 'x'; }, TypeError);
  assert.throws(() => { MODELS.push({}); }, TypeError);
});

test('eraGroup buckets by year with open weights in their own group', () => {
  assert.equal(eraGroup(getModel('openai/gpt-3.5-turbo-instruct')), 'Early (2022–2023)');
  assert.equal(eraGroup(getModel('openai/gpt-4')), 'Early (2022–2023)');
  assert.equal(eraGroup(getModel('openai/gpt-4o-mini')), 'Recent (2024)');
  assert.equal(eraGroup(getModel('anthropic/claude-haiku-4.5')), 'Current (2025–2026)');
  assert.equal(eraGroup(getModel('google/gemini-3.5-flash-lite')), 'Current (2025–2026)');
  assert.equal(eraGroup(getModel('meta-llama/llama-3.3-70b-instruct')), 'Open weights', 'open weights win over the 2024 year');
});
