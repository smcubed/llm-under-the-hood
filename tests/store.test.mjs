import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createStore } from '../site/store.js';

test('get returns the initial state and set shallow-merges into it', () => {
  const store = createStore({ prompt: '', modelId: 'm', results: {} });
  store.set({ prompt: 'hi' });
  assert.deepEqual(store.get(), { prompt: 'hi', modelId: 'm', results: {} });
  store.set({ results: { predict: 1 } });
  assert.deepEqual(store.get(), { prompt: 'hi', modelId: 'm', results: { predict: 1 } });
});
test('subscribers get the merged state and the patch keys; unsubscribe stops notifications', () => {
  const store = createStore({ a: 1, b: 2 });
  const calls = [];
  const off = store.subscribe((state, keys) => calls.push([state, keys]));
  store.set({ a: 3, c: 4 });
  assert.equal(calls.length, 1);
  assert.deepEqual(calls[0][0], { a: 3, b: 2, c: 4 });
  assert.deepEqual(calls[0][1], ['a', 'c']);
  off();
  store.set({ b: 9 });
  assert.equal(calls.length, 1);
  assert.equal(store.get().b, 9);
});
test('get returns a snapshot: mutating it does not change the store', () => {
  const store = createStore({ a: 1 });
  store.get().a = 5;
  assert.equal(store.get().a, 1);
});
test('a subscriber that throws does not stop the others', () => {
  const store = createStore({ a: 1 });
  const seen = [];
  store.subscribe(() => { throw new Error('boom'); });
  store.subscribe((s) => seen.push(s.a));
  store.set({ a: 2 });
  assert.deepEqual(seen, [2]);
});
test('update(fn) sets fn(get()) synchronously and notifies with the returned keys', () => {
  const store = createStore({ n: 1, other: 'x' });
  const calls = [];
  store.subscribe((state, keys) => calls.push([state.n, keys]));
  store.update((s) => ({ n: s.n + 1 }));
  assert.equal(store.get().n, 2);
  assert.deepEqual(calls, [[2, ['n']]]);
});
test('setResult(key, value) merges one chapter result without touching the others', () => {
  const store = createStore({ results: { tokens: [1] } });
  const calls = [];
  store.subscribe((state, keys) => calls.push(keys));
  store.setResult('predict', { usage: { prompt: 7 } });
  assert.deepEqual(store.get().results, { tokens: [1], predict: { usage: { prompt: 7 } } });
  assert.deepEqual(calls, [['results']]);
  store.setResult('tokens', [2]);
  assert.deepEqual(store.get().results, { tokens: [2], predict: { usage: { prompt: 7 } } });
});
