/**
 * Run lifecycle shared by the API-calling chapters. `createRun(store, onRun)` watches `runId`; each time it changes
 * (and once at creation if `runId > 0`) the previous run is torn down (its AbortController aborted, its dispose
 * callbacks run) and `onRun(ctx)` starts the new one with
 *   ctx = { signal, runId, isCurrent(), onDispose(fn), state }
 * where `isCurrent()` is true while the store still holds this runId, so a late response can be ignored.
 * Returns `{ dispose() }`, which unsubscribes and tears down the active run.
 */
export function createRun(store, onRun) {
  let controller = null, disposers = [], lastRunId = null;

  const teardown = () => {
    if (controller) controller.abort();
    controller = null;
    for (const fn of disposers.splice(0)) {
      try { fn(); } catch (err) { console.error('run: dispose callback failed', err); }
    }
  };

  const start = (state) => {
    teardown();
    const runId = state.runId;
    lastRunId = runId;
    controller = new AbortController();
    const ctx = {
      signal: controller.signal,
      runId,
      state,
      isCurrent: () => store.get().runId === runId,
      onDispose: (fn) => { if (typeof fn === 'function') disposers.push(fn); },
    };
    try { onRun(ctx); } catch (err) { console.error('run: onRun failed', err); }
  };

  const unsubscribe = store.subscribe((state, keys) => {
    if (keys.includes('runId') && state.runId !== lastRunId) start(state);
  });
  const initial = store.get();
  if (initial.runId > 0) start(initial);

  return { dispose() { unsubscribe(); teardown(); } };
}
