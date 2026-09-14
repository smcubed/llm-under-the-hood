import { test } from 'node:test';
import assert from 'node:assert/strict';
import { validateGenerate } from '../worker/src/validate.js';

const good = { model: 'openai/gpt-4o-mini', prompt: 'The patient presented with', maxTokens: 50, temperature: 0.7, topLogprobs: 5, stream: true };

test('accepts a valid body and resolves the model', () => {
  const r = validateGenerate(good);
  assert.equal(r.ok, true);
  assert.equal(r.value.model.id, 'openai/gpt-4o-mini');
  assert.equal(r.value.system, '');
  assert.equal(r.value.prefix, '');
});
test('rejects unknown model', () => {
  const r = validateGenerate({ ...good, model: 'openai/gpt-4.1' });
  assert.equal(r.ok, false); assert.equal(r.status, 400); assert.match(r.message, /model/i);
});
test('rejects prompt over 200 chars and empty prompt', () => {
  assert.equal(validateGenerate({ ...good, prompt: 'x'.repeat(201) }).ok, false);
  assert.equal(validateGenerate({ ...good, prompt: '   ' }).ok, false);
});
test('rejects system over 400 and prefix over 1500', () => {
  assert.equal(validateGenerate({ ...good, system: 'x'.repeat(401) }).ok, false);
  assert.equal(validateGenerate({ ...good, prefix: 'x'.repeat(1501) }).ok, false);
});
test('clamps maxTokens, topLogprobs, temperature into range', () => {
  const r = validateGenerate({ ...good, maxTokens: 999, topLogprobs: 50, temperature: 9 });
  assert.equal(r.value.maxTokens, 200); assert.equal(r.value.topLogprobs, 10); assert.equal(r.value.temperature, 1.5);
  const r2 = validateGenerate({ ...good, maxTokens: 0, topLogprobs: -1, temperature: -1 });
  assert.equal(r2.value.maxTokens, 1); assert.equal(r2.value.topLogprobs, 0); assert.equal(r2.value.temperature, 0);
});
test('defaults: maxTokens 120, temperature 0.7, topLogprobs 5, stream true', () => {
  const r = validateGenerate({ model: 'openai/gpt-4o-mini', prompt: 'hi' });
  assert.deepEqual([r.value.maxTokens, r.value.temperature, r.value.topLogprobs, r.value.stream], [120, 0.7, 5, true]);
});
test('forces topLogprobs to 0 for models without logprobs', () => {
  const r = validateGenerate({ ...good, model: 'anthropic/claude-haiku-4.5' });
  assert.equal(r.value.topLogprobs, 0);
});
test('rejects non-object and non-string fields', () => {
  assert.equal(validateGenerate(null).ok, false);
  assert.equal(validateGenerate({ ...good, prompt: 42 }).ok, false);
});
test('non-string system or prefix → "must be text", not a length message', () => {
  const s = validateGenerate({ ...good, system: false });
  assert.equal(s.ok, false); assert.match(s.message, /must be text/); assert.doesNotMatch(s.message, /limited/);
  const p = validateGenerate({ ...good, prefix: 5 });
  assert.equal(p.ok, false); assert.match(p.message, /must be text/); assert.doesNotMatch(p.message, /too long/);
});
test('rejects non-string model and array bodies', () => {
  const m = validateGenerate({ ...good, model: 42 });
  assert.equal(m.ok, false); assert.match(m.message, /model/i);
  const a = validateGenerate([good]);
  assert.equal(a.ok, false);
});
