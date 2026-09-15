import { test, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { installFakeDom } from './helpers/fake-dom.mjs';
import { openPopover, closePopover, closePopoverWithin, isPopoverOpen, popoverAnchor } from '../site/popover.js';
import { el } from '../site/dom.js';

const tick = () => new Promise(r => setTimeout(r, 0));
let dom;
beforeEach(() => { dom = installFakeDom(); });
afterEach(() => { closePopover(); dom.restore(); });

function anchor() {
  const a = el('button', { type: 'button', text: 'chip' });
  a.rect = { left: 100, top: 20, right: 140, bottom: 40, width: 40, height: 20 };
  dom.document.body.append(a);
  return a;
}

test('opens below the anchor as a dialog, marks the anchor expanded, and takes focus', () => {
  const a = anchor();
  const pop = openPopover(a, el('p', { text: 'alternatives' }), { label: 'Alternatives' });
  assert.equal(isPopoverOpen(), true);
  assert.equal(pop.attributes.role, 'dialog');
  assert.equal(pop.attributes['aria-label'], 'Alternatives');
  assert.equal(pop.parentNode, dom.document.body);
  assert.equal(pop.style.top, '46px');
  assert.equal(pop.style.left, '100px');
  assert.equal(a.attributes['aria-expanded'], 'true');
  assert.equal(dom.document.activeElement, pop);
});

test('a pointer press during the opening dispatch does not close it; a later outside press does', async () => {
  const a = anchor();
  const outside = el('div');
  dom.document.body.append(outside);
  openPopover(a, el('p', { text: 'x' }));
  outside.dispatch('pointerdown');
  assert.equal(isPopoverOpen(), true, 'the listener is not armed until the current event has finished');
  await tick();
  outside.dispatch('pointerdown');
  assert.equal(isPopoverOpen(), false);
  assert.equal(a.attributes['aria-expanded'], 'false');
  assert.equal(dom.document.listeners.pointerdown.length, 0, 'the document listener is removed');
});

test('a press inside the popover or on the anchor keeps it open; Escape closes and restores focus', async () => {
  const a = anchor();
  const inner = el('button', { text: 'pick' });
  openPopover(a, el('div', {}, inner));
  await tick();
  inner.dispatch('pointerdown');
  a.dispatch('pointerdown');
  assert.equal(isPopoverOpen(), true);
  dom.document.dispatch('keydown', { key: 'Escape', preventDefault() {} });
  assert.equal(isPopoverOpen(), false);
  assert.equal(dom.document.activeElement, a, 'focus returns to the anchor');
});

test('opening a second popover closes the first; resize re-anchors; close cancels a pending arm', async () => {
  const a = anchor(), b = anchor();
  const p1 = openPopover(a, el('p'));
  const p2 = openPopover(b, el('p'));
  assert.equal(p1.parentNode, null);
  assert.equal(a.attributes['aria-expanded'], 'false');
  assert.equal(p2.parentNode, dom.document.body);
  b.rect = { ...b.rect, left: 300, bottom: 80 };
  dom.window.dispatch('resize');
  assert.equal(p2.style.left, '300px');
  assert.equal(p2.style.top, '86px');
  closePopover();
  await tick();
  assert.equal((dom.document.listeners.pointerdown || []).length, 0);
  assert.equal((dom.window.listeners.resize || []).length, 0);
});

test('the popover is kept inside the viewport on the right', () => {
  const a = anchor();
  a.rect = { left: 1000, top: 0, right: 1040, bottom: 20, width: 40, height: 20 };
  const pop = openPopover(a, el('p'));
  assert.equal(pop.style.left, `${1024 - 240 - 8}px`);
});

test('focus: false leaves focus where it was (hover-opened popovers must not steal it)', () => {
  const a = anchor();
  const pop = openPopover(a, el('p', { text: 'x' }), { focus: false });
  assert.equal(dom.document.activeElement, dom.document.body);
  assert.equal(pop.parentNode, dom.document.body);
  assert.equal(a.attributes['aria-expanded'], 'true');
  closePopover();
  assert.equal(dom.document.activeElement, dom.document.body, 'nothing to restore');
});

test('popoverAnchor reports the open anchor; closePopoverWithin only closes a popover anchored inside the root', () => {
  assert.equal(popoverAnchor(), null);
  const paneA = el('div'), paneB = el('div');
  dom.document.body.append(paneA, paneB);
  const a = el('button', { text: 'a' });
  paneB.append(a);
  openPopover(a, el('p'));
  assert.equal(popoverAnchor(), a);
  closePopoverWithin(paneA);
  assert.equal(isPopoverOpen(), true, 'another pane\'s reset leaves it alone');
  closePopoverWithin(paneB);
  assert.equal(isPopoverOpen(), false);
  assert.equal(popoverAnchor(), null);
  closePopoverWithin(paneB); // no-op when nothing is open
});
