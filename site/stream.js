/**
 * One streamed generation tied to a run. `request(ctx, params, handlers)` calls `generate(params)` with a signal that
 * aborts when either the run (`ctx.signal`) or this request (`abort()`) is aborted, and drops every callback once the
 * request is stale: aborted, or the run is no longer current (`ctx.isCurrent()`). So a late response from a previous
 * run, or from a paused stream, can never touch the DOM.
 *   ctx      { signal, isCurrent() }  (a run.js ctx, or any object with those two)
 *   handlers { onToken(ev), onDone(done), onError(message, fromStream, err) }
 * → { abort(), done: Promise<void> }   (`done` settles after the last handler ran; it never rejects)
 */
import { generate } from './api.js';

/**
 * A signal that aborts when any of `signals` does. Uses AbortSignal.any where available; the fallback attaches one
 * listener per input and removes all of them as soon as one fires (or attaches none when an input is already aborted),
 * so long-lived run signals do not accumulate listeners from finished requests.
 */
export function anySignal(signals) {
  const list = signals.filter(Boolean);
  if (typeof AbortSignal.any === 'function') return AbortSignal.any(list);
  const c = new AbortController();
  const already = list.find(s => s.aborted);
  if (already) { c.abort(already.reason); return c.signal; }
  const entries = [];
  const detach = () => { for (const { s, fn } of entries) s.removeEventListener('abort', fn); };
  for (const s of list) {
    const fn = () => { detach(); c.abort(s.reason); };
    entries.push({ s, fn });
    s.addEventListener('abort', fn);
  }
  return c.signal;
}

export const GENERIC_ERROR = 'Something went wrong. Try again.';

export function request(ctx, params, { onToken, onDone, onError } = {}) {
  const local = new AbortController();
  const signal = anySignal([ctx?.signal, local.signal]);
  // Stale once anything aborted the combined signal (this request or the run) or the run is no longer current.
  const stale = () => signal.aborted || (ctx?.isCurrent ? !ctx.isCurrent() : false);
  const done = (async () => {
    let result = null;
    try {
      result = await generate(params, {
        signal,
        onEvent: (ev) => { if (ev.type === 'token' && !stale()) onToken?.(ev); },
      });
    } catch (err) {
      if (stale()) return;
      onError?.(err?.message || GENERIC_ERROR, Boolean(err?.fromStream), err);
      return;
    }
    if (stale()) return;
    onDone?.(result);
  })();
  return { abort: () => local.abort(), done };
}
