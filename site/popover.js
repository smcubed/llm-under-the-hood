/**
 * One popover at a time, anchored below an element. Escape and a pointer press outside close it; focus returns to the
 * anchor when the popover took it on open (`focus: true`, the default) and still held it. The anchor gets aria-expanded; the popover is role="dialog" and re-anchors on
 * window resize. The outside-press listener is attached on a `setTimeout(0)` so the pointer event that opened the
 * popover (still dispatching when `openPopover` runs) cannot close it in the same breath.
 *   openPopover(anchorEl, contentEl, { label, focus }) → popover element   (focus: false for hover-opened popovers)
 *   closePopover({ restoreFocus });  closePopoverWithin(root);  isPopoverOpen();  popoverAnchor()
 */
let current = null;

function place(pop, anchorEl) {
  const r = anchorEl.getBoundingClientRect();
  const width = pop.offsetWidth || 240;
  const left = Math.max(8, Math.min(r.left + window.scrollX, window.scrollX + document.documentElement.clientWidth - width - 8));
  pop.style.top = `${r.bottom + window.scrollY + 6}px`;
  pop.style.left = `${left}px`;
}

export function openPopover(anchorEl, contentEl, { label = 'Details', focus = true } = {}) {
  closePopover();
  const pop = document.createElement('div');
  pop.className = 'popover';
  pop.setAttribute('role', 'dialog');
  pop.setAttribute('aria-label', label);
  pop.tabIndex = -1;
  pop.append(contentEl);
  document.body.append(pop);
  place(pop, anchorEl);
  anchorEl.setAttribute('aria-expanded', 'true');

  const onKey = (e) => { if (e.key === 'Escape') { e.preventDefault(); closePopover(); } };
  const onPointer = (e) => { if (!pop.contains(e.target) && !anchorEl.contains(e.target)) closePopover({ restoreFocus: false }); };
  const onResize = () => place(pop, anchorEl);
  const entry = { pop, anchorEl, onKey, onPointer, onResize, tookFocus: focus, armed: false, timer: null };
  document.addEventListener('keydown', onKey);
  window.addEventListener('resize', onResize);
  entry.timer = setTimeout(() => {
    entry.timer = null;
    if (current !== entry) return;
    document.addEventListener('pointerdown', onPointer);
    entry.armed = true;
  }, 0);
  current = entry;
  if (focus) pop.focus({ preventScroll: true });
  return pop;
}

export function closePopover({ restoreFocus = true } = {}) {
  if (!current) return;
  const { pop, anchorEl, onKey, onPointer, onResize, tookFocus, armed, timer } = current;
  current = null;
  if (timer !== null) clearTimeout(timer);
  document.removeEventListener('keydown', onKey);
  if (armed) document.removeEventListener('pointerdown', onPointer);
  window.removeEventListener('resize', onResize);
  const hadFocus = pop.contains(document.activeElement) || document.activeElement === document.body;
  pop.remove();
  anchorEl.setAttribute('aria-expanded', 'false');
  if (restoreFocus && tookFocus && hadFocus && anchorEl.isConnected) anchorEl.focus({ preventScroll: true });
}

export function isPopoverOpen() { return current !== null; }

/** The element the open popover is anchored to, or null. */
export function popoverAnchor() { return current?.anchorEl ?? null; }

/** Close the popover only if its anchor is inside `root` (so one pane's reset cannot close another pane's popover). */
export function closePopoverWithin(root, opts) {
  if (current && root?.contains(current.anchorEl)) closePopover(opts);
}
