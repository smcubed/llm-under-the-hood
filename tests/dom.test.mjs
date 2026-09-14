import { test, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { el, svg, displayToken, chipClass, debounce, tokenChip, notice } from '../site/dom.js';

/** A tiny stand-in for the DOM: enough of createElement/append/setAttribute for these helpers. */
function fakeNode(tagName, ns = null) {
  const node = {
    tagName, ns, attributes: {}, className: '', dataset: {}, style: {}, children: [], listeners: {}, _text: '',
    setAttribute(k, v) { node.attributes[k] = v; },
    getAttribute(k) { return node.attributes[k]; },
    append(...kids) { node.children.push(...kids); },
    replaceChildren(...kids) { node.children = kids; },
    addEventListener(type, fn) { (node.listeners[type] ||= []).push(fn); },
    get textContent() { return node._text || node.children.map(c => c.textContent ?? '').join(''); },
    set textContent(v) { node._text = v; node.children = []; },
  };
  return node;
}
const realDocument = globalThis.document;
beforeEach(() => {
  globalThis.document = {
    createElement: (tag) => fakeNode(tag),
    createElementNS: (ns, tag) => fakeNode(tag, ns),
    createTextNode: (text) => ({ nodeType: 3, textContent: text }),
  };
});
afterEach(() => { globalThis.document = realDocument; });

test('displayToken: leading space is split out, U+FFFD becomes a dot, newline becomes a return arrow', () => {
  assert.deepEqual(displayToken(' patient'), { leadingSpace: true, text: 'patient' });
  assert.deepEqual(displayToken('The'), { leadingSpace: false, text: 'The' });
  assert.deepEqual(displayToken('�'), { leadingSpace: false, text: '·' });
  assert.deepEqual(displayToken('\n'), { leadingSpace: false, text: '↵' });
  assert.deepEqual(displayToken('  two'), { leadingSpace: true, text: ' two' }, 'only the first space is a marker');
  assert.deepEqual(displayToken(undefined), { leadingSpace: false, text: '' });
});

test('chipClass cycles through six classes', () => {
  assert.deepEqual([0, 1, 5, 6, 7, 13].map(chipClass), ['chip-1', 'chip-2', 'chip-6', 'chip-1', 'chip-2', 'chip-2']);
});

test('el: sets class, dataset, aria attributes, text, handlers; skips null/false; flattens children', () => {
  const clicks = [];
  const node = el('button', { class: 'x', dataset: { i: 1 }, 'aria-label': 'Go', onClick: () => clicks.push(1), hidden: false, disabled: true, title: null }, 'a', null, [el('span', { text: 'b' }), ['c']]);
  assert.equal(node.tagName, 'button');
  assert.equal(node.className, 'x');
  assert.deepEqual(node.dataset, { i: 1 });
  assert.equal(node.attributes['aria-label'], 'Go');
  assert.equal(node.attributes.disabled, '');
  assert.ok(!('hidden' in node.attributes) && !('title' in node.attributes));
  assert.equal(node.listeners.click.length, 1);
  node.listeners.click[0]();
  assert.deepEqual(clicks, [1]);
  assert.equal(node.children.length, 3);
  assert.equal(node.textContent, 'abc');
});

test('svg creates namespaced nodes and sets class as an attribute', () => {
  const node = svg('circle', { class: 'pt', cx: 1, r: 2 });
  assert.equal(node.ns, 'http://www.w3.org/2000/svg');
  assert.equal(node.attributes.class, 'pt');
  assert.equal(node.attributes.cx, '1');
});

test('tokenChip renders the id in the title and a space marker for a leading space', () => {
  const chip = tokenChip({ id: 42, text: ' hy' }, 6, { tabindex: 0 });
  assert.equal(chip.className, 'chip chip-1');
  assert.equal(chip.attributes.title, 'token id 42');
  assert.equal(chip.attributes.tabindex, '0');
  assert.equal(chip.children[0].className, 'sp');
  assert.equal(chip.textContent, '␣hy');
  const plain = tokenChip({ id: 1, text: 'The' }, 0);
  assert.equal(plain.children.length, 1);
  assert.equal(plain.textContent, 'The');
});

test('debounce: only the last call in a burst runs, after the delay; cancel and flush work', () => {
  const timers = new Map(); let nextId = 1;
  const setTimer = (fn, ms) => { const id = nextId++; timers.set(id, fn); return id; };
  const clearTimer = (id) => timers.delete(id);
  const fire = () => { for (const [id, fn] of [...timers]) { timers.delete(id); fn(); } };
  const seen = [];
  const d = debounce((x) => seen.push(x), 150, { setTimer, clearTimer });
  d(1); d(2); d(3);
  assert.equal(timers.size, 1, 'earlier timers are cleared');
  assert.deepEqual(seen, []);
  fire();
  assert.deepEqual(seen, [3]);
  d(4); d.cancel(); fire();
  assert.deepEqual(seen, [3]);
  d(5); d.flush();
  assert.deepEqual(seen, [3, 5]);
  assert.equal(timers.size, 0);
});

test('debounce with real timers runs once', async () => {
  const seen = [];
  const d = debounce((x) => seen.push(x), 5);
  d('a'); d('b');
  await new Promise(r => setTimeout(r, 25));
  assert.deepEqual(seen, ['b']);
});

test('notice replaces the root content with a message and an optional Retry button', () => {
  const root = fakeNode('div');
  const retries = [];
  const box = notice(root, 'Could not load.', { retry: () => retries.push(1) });
  assert.equal(root.children[0], box);
  assert.equal(box.attributes.role, 'status');
  assert.equal(box.children[0].textContent, 'Could not load.');
  assert.equal(box.children[1].textContent, 'Retry');
  box.children[1].listeners.click[0]();
  assert.deepEqual(retries, [1]);
  notice(root, 'Plain');
  assert.equal(root.children[0].children.length, 1);
});
