/**
 * Tiny observable store. `set(patch)` shallow-merges and notifies every subscriber with `(state, patchKeys)`,
 * so a chapter can ignore patches that do not touch what it renders. `get()` returns a shallow copy.
 */
export function createStore(initial = {}) {
  let state = { ...initial };
  const subscribers = new Set();
  return {
    get() { return { ...state }; },
    set(patch) {
      const keys = Object.keys(patch);
      state = { ...state, ...patch };
      const snapshot = { ...state };
      for (const fn of [...subscribers]) {
        try { fn(snapshot, keys); }
        catch (err) { console.error('store: subscriber failed', err); }
      }
    },
    subscribe(fn) {
      subscribers.add(fn);
      return () => { subscribers.delete(fn); };
    },
  };
}
