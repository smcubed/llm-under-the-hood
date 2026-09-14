/** Small DOM helpers shared by the chapters. Everything here is plain DOM; the pure parts are tested in tests/dom.test.mjs. */

const SVG_NS = 'http://www.w3.org/2000/svg';

function applyAttrs(node, attrs) {
  for (const [key, value] of Object.entries(attrs)) {
    if (value === null || value === undefined || value === false) continue;
    if (key === 'class') node.className = value;
    else if (key === 'text') node.textContent = value;
    else if (key === 'dataset') Object.assign(node.dataset, value);
    else if (key.startsWith('on') && typeof value === 'function') node.addEventListener(key.slice(2).toLowerCase(), value);
    else if (key === 'style' && typeof value === 'object') Object.assign(node.style, value);
    else node.setAttribute(key, value === true ? '' : String(value));
  }
}

function appendChildren(node, children) {
  for (const child of children.flat(Infinity)) {
    if (child === null || child === undefined || child === false) continue;
    node.append(typeof child === 'string' || typeof child === 'number' ? document.createTextNode(String(child)) : child);
  }
}

/**
 * el('button', { class: 'x', dataset: { i: 1 }, onClick: fn, 'aria-label': 'Go', text: 'Go' }, ...children)
 * Attribute values of null/undefined/false are skipped; `true` sets an empty attribute. Children may be strings, nodes,
 * or (nested) arrays; null/false children are skipped.
 */
export function el(tag, attrs = {}, ...children) {
  const node = document.createElement(tag);
  applyAttrs(node, attrs);
  appendChildren(node, children);
  return node;
}

/** Same as `el` for SVG elements (created in the SVG namespace). `class` is set via setAttribute for SVG. */
export function svg(tag, attrs = {}, ...children) {
  const node = document.createElementNS(SVG_NS, tag);
  const { class: cls, ...rest } = attrs;
  if (cls) node.setAttribute('class', cls);
  applyAttrs(node, rest);
  appendChildren(node, children);
  return node;
}

/**
 * How a token's text is shown on screen: a leading space is reported separately (renderers draw a visible marker),
 * undecodable bytes (U+FFFD) become a middle dot, and newlines become a return arrow so the chip stays on one line.
 * → { leadingSpace: boolean, text: string }
 */
export function displayToken(text) {
  const s = String(text ?? '');
  const leadingSpace = s.startsWith(' ');
  const body = (leadingSpace ? s.slice(1) : s).replace(/�/g, '·').replace(/\r?\n/g, '↵');
  return { leadingSpace, text: body };
}

/** Six chip colours, cycling. */
export function chipClass(i) {
  return `chip-${(i % 6) + 1}`;
}

/** One token chip. `extra` merges into the attributes (e.g. `title`, `tabindex`, handlers). */
export function tokenChip(token, i, extra = {}) {
  const { leadingSpace, text } = displayToken(token.text);
  const attrs = { class: `chip ${chipClass(i)}`, title: Number.isInteger(token.id) ? `token id ${token.id}` : undefined, ...extra };
  if (extra.class) attrs.class = `chip ${chipClass(i)} ${extra.class}`;
  return el('span', attrs, leadingSpace ? el('span', { class: 'sp', 'aria-hidden': 'true', text: '␣' }) : null, text);
}

export function prefersReducedMotion() {
  return typeof window !== 'undefined' && !!window.matchMedia?.('(prefers-reduced-motion: reduce)').matches;
}

/** Trailing debounce. The returned function has `.cancel()`; `.flush()` runs a pending call now. */
export function debounce(fn, ms, { setTimer = setTimeout, clearTimer = clearTimeout } = {}) {
  let timer = null, pending = null;
  const debounced = (...args) => {
    pending = args;
    if (timer !== null) clearTimer(timer);
    timer = setTimer(() => { timer = null; const a = pending; pending = null; fn(...a); }, ms);
  };
  debounced.cancel = () => { if (timer !== null) clearTimer(timer); timer = null; pending = null; };
  debounced.flush = () => { if (timer !== null) { clearTimer(timer); timer = null; const a = pending; pending = null; fn(...a); } };
  return debounced;
}

/** Replace `root`'s content with a `.notice` message and an optional Retry button. Returns the notice element. */
export function notice(root, message, { retry } = {}) {
  const box = el('div', { class: 'notice notice-inline', role: 'status' },
    el('span', { text: message }),
    retry ? el('button', { type: 'button', class: 'secondary', onClick: retry, text: 'Retry' }) : null);
  root.replaceChildren(box);
  return box;
}
