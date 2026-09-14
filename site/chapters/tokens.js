/**
 * Chapter contract (every chapter module follows this):
 * - `mount(root, store)` is called once; it subscribes to the store once and renders into `root.querySelector('.viz')`.
 * - The chapter keeps one AbortController per in-flight request and aborts it when `runId` changes.
 * - Async results carry the `runId` captured when they started; a result whose runId no longer matches
 *   `store.get().runId` is ignored, so a stale response never overwrites a newer run.
 * - Anything other chapters need is published with `store.setResult(key, value)`, never by mutating state directly.
 */
// Stub until Task 15 lands: only marks the slot.
export function mount(root) {
  const viz = root.querySelector('.viz');
  if (!viz) return;
  const note = document.createElement('p');
  note.className = 'placeholder';
  note.textContent = 'Coming in a later step: the token chips.';
  viz.replaceChildren(note);
}
