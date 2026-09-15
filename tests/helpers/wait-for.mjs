/**
 * Poll `pred` until it returns a truthy value (returned) or `timeout` ms pass (throws). `step` is the pause between
 * polls: 0 (the default) yields one macrotask, which is enough for a scripted fetch → SSE read → DOM update chain.
 * A predicate that throws counts as false, so `waitFor(() => assert...)` style checks work too.
 */
export async function waitFor(pred, { timeout = 2000, step = 0, message } = {}) {
  const start = Date.now();
  for (;;) {
    let value = false;
    try { value = await pred(); } catch { value = false; }
    if (value) return value;
    if (Date.now() - start > timeout) throw new Error(message || `waitFor: condition not met within ${timeout} ms`);
    await new Promise(r => setTimeout(r, step));
  }
}
