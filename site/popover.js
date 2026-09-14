/**
 * One popover at a time, anchored below an element. Escape and a click outside close it; focus returns to the anchor
 * when it was inside the popover. The anchor gets aria-expanded; the popover is role="dialog".
 */
let current = null;

export function openPopover(anchorEl, contentEl, { label = 'Details' } = {}) {
  closePopover();
  const pop = document.createElement('div');
  pop.className = 'popover';
  pop.setAttribute('role', 'dialog');
  pop.setAttribute('aria-label', label);
  pop.tabIndex = -1;
  pop.append(contentEl);
  document.body.append(pop);

  const r = anchorEl.getBoundingClientRect();
  const width = pop.offsetWidth || 240;
  const left = Math.max(8, Math.min(r.left + window.scrollX, window.scrollX + document.documentElement.clientWidth - width - 8));
  pop.style.top = `${r.bottom + window.scrollY + 6}px`;
  pop.style.left = `${left}px`;
  anchorEl.setAttribute('aria-expanded', 'true');

  const onKey = (e) => { if (e.key === 'Escape') { e.preventDefault(); closePopover(); } };
  const onPointer = (e) => { if (!pop.contains(e.target) && !anchorEl.contains(e.target)) closePopover({ restoreFocus: false }); };
  document.addEventListener('keydown', onKey);
  document.addEventListener('pointerdown', onPointer);
  current = { pop, anchorEl, onKey, onPointer };
  pop.focus({ preventScroll: true });
  return pop;
}

export function closePopover({ restoreFocus = true } = {}) {
  if (!current) return;
  const { pop, anchorEl, onKey, onPointer } = current;
  current = null;
  document.removeEventListener('keydown', onKey);
  document.removeEventListener('pointerdown', onPointer);
  const hadFocus = pop.contains(document.activeElement) || document.activeElement === document.body;
  pop.remove();
  anchorEl.setAttribute('aria-expanded', 'false');
  if (restoreFocus && hadFocus && anchorEl.isConnected) anchorEl.focus({ preventScroll: true });
}

export function isPopoverOpen() { return current !== null; }
