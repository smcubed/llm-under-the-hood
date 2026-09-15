import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createStore } from '../site/store.js';
import { createRun } from '../site/run.js';

test('nothing runs until runId becomes > 0; each change starts a run with a fresh signal', () => {
  const store = createStore({ runId: 0, prompt: 'a' });
  const runs = [];
  createRun(store, (ctx) => runs.push(ctx));
  assert.equal(runs.length, 0);
  store.set({ prompt: 'b' });
  assert.equal(runs.length, 0);
  store.set({ runId: 1 });
  assert.equal(runs.length, 1);
  assert.equal(runs[0].runId, 1);
  assert.equal(runs[0].state.prompt, 'b');
  assert.equal(runs[0].signal.aborted, false);
  assert.equal(runs[0].isCurrent(), true);
  store.set({ runId: 2 });
  assert.equal(runs.length, 2);
  assert.equal(runs[0].signal.aborted, true, 'the previous run is aborted');
  assert.equal(runs[0].isCurrent(), false);
  assert.equal(runs[1].signal.aborted, false);
  assert.equal(runs[1].isCurrent(), true);
});

test('a store already holding runId > 0 starts a run at creation; the same runId again does not', () => {
  const store = createStore({ runId: 7 });
  const runs = [];
  createRun(store, (ctx) => runs.push(ctx.runId));
  assert.deepEqual(runs, [7]);
  store.set({ runId: 7 });
  assert.deepEqual(runs, [7]);
  store.set({ results: {} });
  assert.deepEqual(runs, [7]);
});

test('dispose callbacks run when the run is replaced and when the runner is disposed; a throwing one does not stop the rest', () => {
  const store = createStore({ runId: 0 });
  const log = [];
  const errors = [];
  const origError = console.error;
  console.error = (...a) => errors.push(a);
  try {
    const runner = createRun(store, (ctx) => {
      ctx.onDispose(() => log.push(`dispose ${ctx.runId} a`));
      ctx.onDispose(() => { throw new Error('boom'); });
      ctx.onDispose(() => log.push(`dispose ${ctx.runId} b`));
      ctx.onDispose('not a function');
    });
    store.set({ runId: 1 });
    assert.deepEqual(log, []);
    store.set({ runId: 2 });
    assert.deepEqual(log, ['dispose 1 a', 'dispose 1 b']);
    assert.equal(errors.length, 1);
    runner.dispose();
    assert.deepEqual(log, ['dispose 1 a', 'dispose 1 b', 'dispose 2 a', 'dispose 2 b']);
    store.set({ runId: 3 });
    assert.deepEqual(log.length, 4, 'after dispose the store is no longer watched');
  } finally {
    console.error = origError;
  }
});

test('a late result can check isCurrent() against the store instead of a captured value', () => {
  const store = createStore({ runId: 0 });
  let ctx = null;
  createRun(store, (c) => { ctx = c; });
  store.set({ runId: 10 });
  const first = ctx;
  store.set({ runId: 11 });
  assert.equal(first.isCurrent(), false);
  assert.equal(ctx.isCurrent(), true);
  assert.equal(first.signal.aborted, true);
});
