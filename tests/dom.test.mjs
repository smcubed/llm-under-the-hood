import { test, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { el, svg, displayToken, chipClass, debounce, tokenChip, notice, setStatus, chipRow } from '../site/dom.js';
import { installFakeDom, fakeNode } from './helpers/fake-dom.mjs';

let dom;
beforeEach(() => { dom = installFakeDom(); });
afterEach(() => { dom.restore(); });

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

test('el: strings are always text nodes, never markup', () => {
  const node = el('span', { text: '<img onerror=x>' });
  assert.equal(node.children.length, 0);
  assert.equal(node.textContent, '<img onerror=x>');
  const withChild = el('span', {}, '<b>bold</b>');
  assert.equal(withChild.children[0].nodeType, 3);
  assert.equal(withChild.children[0].textContent, '<b>bold</b>');
});

test('el: a string handler throws, javascript: URLs throw, srcdoc throws', () => {
  assert.throws(() => el('a', { onclick: 'x' }), TypeError);
  assert.throws(() => el('button', { onClick: 'alert(1)' }), TypeError);
  assert.throws(() => el('a', { href: 'javascript:alert(1)' }), TypeError);
  assert.throws(() => el('a', { href: '  JavaScript:alert(1)' }), TypeError);
  assert.throws(() => el('img', { src: 'javascript:x' }), TypeError);
  assert.throws(() => el('iframe', { srcdoc: '<p>x</p>' }), TypeError);
  assert.equal(el('a', { href: 'https://example.org/' }).attributes.href, 'https://example.org/');
  assert.equal(el('a', { href: '#top' }).attributes.href, '#top');
});

test('the fake DOM refuses HTML-string APIs', () => {
  const node = el('div');
  assert.throws(() => { node.innerHTML = '<b>x</b>'; }, /innerHTML/);
  assert.throws(() => { node.outerHTML = '<b>x</b>'; }, /innerHTML/);
  assert.throws(() => node.insertAdjacentHTML('beforeend', '<b>x</b>'), /innerHTML/);
});

test('setStatus sets the text and hides the node when empty', () => {
  const node = el('p');
  setStatus(node, 'loading…');
  assert.equal(node.textContent, 'loading…');
  assert.equal(node.hidden, false);
  setStatus(node, '');
  assert.equal(node.textContent, '');
  assert.equal(node.hidden, true);
  setStatus(node, undefined);
  assert.equal(node.hidden, true);
});

test('tokenChip: an undefined extra class does not wipe the base classes', () => {
  const chip = tokenChip({ text: 'a' }, 2, { class: undefined, title: undefined });
  assert.equal(chip.className, 'chip chip-3');
  assert.equal(tokenChip({ text: 'a' }, 0, { class: 'band-high' }).className, 'chip chip-1 band-high');
});

test('chipRow batches appends into one flush and reset clears everything', async () => {
  const root = el('span');
  const row = chipRow(root);
  const a = row.append(' the', { className: 'band-high', title: 'p 0.9', dataset: { i: 0 } });
  const b = row.append('cat', { attrs: { tabindex: 0 } });
  assert.equal(row.count, 2);
  assert.equal(root.children.length, 0, 'nothing is in the DOM before the flush');
  await new Promise(r => setTimeout(r, 5));
  assert.deepEqual(root.children, [a, b]);
  assert.equal(a.className, 'chip chip-1 band-high');
  assert.equal(a.attributes.title, 'p 0.9');
  assert.deepEqual(a.dataset, { i: 0 });
  assert.equal(a.textContent, '␣the');
  assert.equal(b.className, 'chip chip-2');
  assert.equal(b.attributes.tabindex, '0');
  row.append('x');
  row.reset();
  assert.equal(row.count, 0);
  await new Promise(r => setTimeout(r, 5));
  assert.equal(root.children.length, 0, 'a pending fragment is dropped by reset');
  row.append('y');
  row.flush();
  assert.equal(root.children.length, 1);
  assert.equal(root.children[0].className, 'chip chip-1', 'numbering restarts after reset');
});
