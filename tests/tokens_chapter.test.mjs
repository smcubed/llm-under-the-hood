import { test } from 'node:test';
import assert from 'node:assert/strict';
import { tokenCaption, reportedCaption, isApproximateTokenizer, pickText, DEMO_WORDS } from '../site/chapters/tokens.js';
import { getModel } from '../site/models.js';

test('tokenCaption bolds the count and pluralizes both numbers', () => {
  assert.deepEqual(tokenCaption(9, 30), { lead: '9 tokens', tail: ' for 30 characters. The model never sees letters or words, only these token IDs.' });
  assert.equal(tokenCaption(1, 1).lead, '1 token');
  assert.match(tokenCaption(1, 1).tail, /^ for 1 character\./);
});
test('reportedCaption', () => {
  assert.equal(reportedCaption(12), 'The model reported 12 prompt tokens for this prompt.');
  assert.equal(reportedCaption(1), 'The model reported 1 prompt token for this prompt.');
});
test('isApproximateTokenizer is false only for models with an exact vendored tokenizer', () => {
  assert.equal(isApproximateTokenizer(getModel('openai/gpt-4o-mini')), false);
  assert.equal(isApproximateTokenizer(getModel('openai/gpt-3.5-turbo-0613')), false);
  assert.equal(isApproximateTokenizer(getModel('openai/gpt-6-luna')), true, 'OpenAI, but its tokenizer is not published');
  assert.equal(isApproximateTokenizer(getModel('meta-llama/llama-3.3-70b-instruct')), true);
  assert.equal(isApproximateTokenizer(getModel('anthropic/claude-haiku-5.5')), true);
  assert.equal(isApproximateTokenizer(undefined), true);
});
test('pickText uses the prompt when it has content, else the example', () => {
  assert.deepEqual(pickText('hello', 'ex'), { text: 'hello', example: false });
  assert.deepEqual(pickText('   ', 'ex'), { text: 'ex', example: true });
  assert.deepEqual(pickText(undefined, 'ex'), { text: 'ex', example: true });
});
test('demo words are the three from the plan', () => {
  assert.deepEqual(DEMO_WORDS, ['hyponatremia', 'warfarin', 'banana']);
});
