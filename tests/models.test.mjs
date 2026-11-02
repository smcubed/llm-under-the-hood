import { test } from 'node:test';
import assert from 'node:assert/strict';
import { MODELS, DEFAULT_MODEL, AUTOCOMPLETE_MODEL, LIMITS, getModel, estimateCost, eraGroup } from '../site/models.js';

test('ladder has the ten approved models with required fields', () => {
  const ids = MODELS.map(m => m.id);
  assert.deepEqual(ids, [
    'openai/gpt-3.5-turbo-0613', 'openai/gpt-4', 'openai/gpt-4o-mini', 'openai/gpt-5-nano', 'openai/gpt-6-luna',
    'anthropic/claude-haiku-5.5', 'google/gemini-3.5-flash-lite',
    'meta-llama/llama-3.3-70b-instruct', 'google/gemma-4-26b-a4b-it', 'meta-llama/llama-3.1-8b-instruct',
  ]);
  for (const m of MODELS) {
    for (const k of ['id','label','year','provider','open','logprobs','endpoint','tokenizer','bucket','price','exactTokenizer'])
      assert.ok(k in m, `${m.id} missing ${k}`);
    assert.ok(['chat','completion'].includes(m.endpoint));
    assert.ok(['o200k','cl100k'].includes(m.tokenizer));
    assert.equal(typeof m.price.in, 'number'); assert.equal(typeof m.price.out, 'number');
    assert.equal(typeof m.exactTokenizer, 'boolean', `${m.id} exactTokenizer`);
    if (m.exactTokenizer) assert.equal(m.provider, 'OpenAI', `${m.id}: only OpenAI models use the vendored encodings exactly`);
  }
  // Being OpenAI is necessary but not sufficient: GPT-6 Luna's tokenizer is unpublished, so it is approximated.
  assert.deepEqual(MODELS.filter(m => m.exactTokenizer).map(m => m.id), ['openai/gpt-3.5-turbo-0613', 'openai/gpt-4', 'openai/gpt-4o-mini', 'openai/gpt-5-nano']);
});
test('upstream, when present, has only omit/extra keys of the right types', () => {
  for (const m of MODELS) {
    if (!('upstream' in m)) continue;
    assert.ok(Object.keys(m.upstream).every(k => ['omit', 'extra'].includes(k)), `${m.id} upstream keys: ${Object.keys(m.upstream)}`);
    if ('omit' in m.upstream) assert.ok(Array.isArray(m.upstream.omit) && m.upstream.omit.every(k => typeof k === 'string'), `${m.id} upstream.omit`);
    if ('extra' in m.upstream) assert.ok(m.upstream.extra && typeof m.upstream.extra === 'object' && !Array.isArray(m.upstream.extra), `${m.id} upstream.extra`);
    assert.ok(Object.isFrozen(m.upstream), `${m.id} upstream is frozen`);
  }
  // Reasoning models reject `temperature` and need minimal effort to write anything within max_tokens.
  for (const id of ['openai/gpt-5-nano', 'openai/gpt-6-luna'])
    assert.deepEqual(getModel(id).upstream, { omit: ['temperature'], extra: { reasoning: { effort: 'minimal' } } }, id);
  assert.deepEqual(getModel('anthropic/claude-haiku-5.5').upstream, { omit: ['temperature'] });
  assert.equal('upstream' in getModel('openai/gpt-4o-mini'), false);
});
test('every open-weights model that shows probabilities, and the autocomplete model, routes only to providers that return them', () => {
  const routed = MODELS.filter(m => (m.open && m.logprobs) || m.id === AUTOCOMPLETE_MODEL);
  assert.deepEqual(routed.map(m => m.id), ['meta-llama/llama-3.3-70b-instruct', 'google/gemma-4-26b-a4b-it', 'meta-llama/llama-3.1-8b-instruct']);
  for (const m of routed) {
    assert.equal(m.upstream?.extra?.provider?.require_parameters, true, `${m.id} provider.require_parameters`);
    assert.ok(Object.isFrozen(m.upstream.extra.provider), `${m.id} provider routing is frozen`);
  }
});
test('only the autocomplete model is kept out of the pickers', () => {
  assert.deepEqual(MODELS.filter(m => m.picker === false).map(m => m.id), [AUTOCOMPLETE_MODEL]);
  for (const m of MODELS) if ('picker' in m) assert.equal(m.picker, false, `${m.id}: picker is only ever set to false`);
});
test('default model exists and supports logprobs', () => {
  assert.equal(getModel(DEFAULT_MODEL).logprobs, true);
});
test('getModel returns undefined for unknown id', () => assert.equal(getModel('nope/x'), undefined));
test('limits are the design values', () => {
  assert.deepEqual(LIMITS, { promptChars: 200, systemChars: 400, prefixChars: 1500, maxTokens: 200, topLogprobs: 10, temperatureMax: 1.5 });
});
test('autocomplete model exists, uses the completion endpoint, and shares its probabilities', () => {
  assert.equal(AUTOCOMPLETE_MODEL, 'meta-llama/llama-3.1-8b-instruct');
  assert.equal(getModel(AUTOCOMPLETE_MODEL).endpoint, 'completion');
  assert.equal(getModel(AUTOCOMPLETE_MODEL).logprobs, true, 'chapter 5 shows its first guesses');
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
  assert.equal(eraGroup(getModel('openai/gpt-3.5-turbo-0613')), 'Early (2023)');
  assert.equal(eraGroup(getModel('openai/gpt-4')), 'Early (2023)');
  assert.equal(eraGroup(getModel('openai/gpt-4o-mini')), 'Recent (2024)');
  assert.equal(eraGroup(getModel('openai/gpt-5-nano')), 'Current (2025–2026)');
  assert.equal(eraGroup(getModel('anthropic/claude-haiku-5.5')), 'Current (2025–2026)');
  assert.equal(eraGroup(getModel('google/gemini-3.5-flash-lite')), 'Current (2025–2026)');
  assert.equal(eraGroup(getModel('meta-llama/llama-3.3-70b-instruct')), 'Open weights', 'open weights win over the 2024 year');
  assert.equal(eraGroup(getModel('google/gemma-4-26b-a4b-it')), 'Open weights', 'open weights win over the 2026 year');
  assert.deepEqual([...new Set(MODELS.map(eraGroup))], ['Early (2023)', 'Recent (2024)', 'Current (2025–2026)', 'Open weights']);
});
