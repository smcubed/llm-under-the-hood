import { test } from 'node:test';
import assert from 'node:assert/strict';
import { temperatureCaption, barsCaption, noProbsMessage, noProbsThisTime, formatTemperature } from '../site/chapters/predict.js';
import { getModel } from '../site/models.js';

test('temperatureCaption bands', () => {
  assert.equal(temperatureCaption(0), 'Nearly always picks the favorite');
  assert.equal(temperatureCaption(0.2), 'Nearly always picks the favorite');
  assert.equal(temperatureCaption(0.3), 'Usually the favorite, sometimes a surprise');
  assert.equal(temperatureCaption(0.7), 'Usually the favorite, sometimes a surprise');
  assert.equal(temperatureCaption(1.0), 'Usually the favorite, sometimes a surprise');
  assert.equal(temperatureCaption(1.1), 'Anything goes');
  assert.equal(temperatureCaption(1.5), 'Anything goes');
});

test('barsCaption says whether the bars are raw or rescaled', () => {
  assert.equal(barsCaption(null), 'Raw probabilities from the model. Move the slider to rescale them.');
  assert.equal(barsCaption(undefined), barsCaption(null));
  assert.equal(barsCaption(0.7), 'Rescaled at temperature 0.7. Usually the favorite, sometimes a surprise.');
  assert.equal(barsCaption(1.5), 'Rescaled at temperature 1.5. Anything goes.');
  assert.equal(formatTemperature(1), '1.0');
});

test('no-probability messages use the model\'s short name', () => {
  assert.equal(noProbsMessage(getModel('anthropic/claude-haiku-4.5')), 'Haiku 4.5 does not share its probabilities. You can still watch it write.');
  assert.equal(noProbsThisTime(getModel('openai/gpt-4o-mini')), 'GPT-4o mini did not return any probabilities this time. You can still watch it write.');
});
