/**
 * Small DOM helpers shared by the chapters. Everything here is plain DOM; the pure parts are tested in tests/dom.test.mjs.
 *
 * Safety rule: never build DOM from model or student text with anything but `text:` / `tokenChip`; no innerHTML.
 * `el()` enforces the cheap parts of that rule: an `on*` attribute must be a function (a string handler throws),
 * an `href`/`src`-style value that starts with `javascript:` throws, and `srcdoc` is never set.
 */

const SVG_NS = 'http://www.w3.org/2000/svg';
const URL_ATTRS = new Set(['href', 'src', 'xlink:href', 'action', 'formaction', 'poster', 'data']);

function applyAttrs(node, attrs) {
  for (const [key, value] of Object.entries(attrs)) {
    if (value === null || value === undefined || value === false) continue;
    const lower = key.toLowerCase();
    if (lower.startsWith('on')) {
      if (typeof value !== 'function') throw new TypeError(`el: "${key}" must be a function, not a string`);
      node.addEventListener(lower.slice(2), value);
    } else if (key === 'class') node.className = value;
    else if (key === 'text') node.textContent = value;
    else if (key === 'dataset') Object.assign(node.dataset, value);
    else if (key === 'style' && typeof value === 'object') Object.assign(node.style, value);
    else if (lower === 'srcdoc') throw new TypeError('el: srcdoc is never set');
    else if (URL_ATTRS.has(lower) && String(value).trim().toLowerCase().startsWith('javascript:')) throw new TypeError(`el: "${key}" must not be a javascript: URL`);
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
 * or (nested) arrays; null/false children are skipped. Strings always become text nodes, never markup.
 */
export function el(tag, attrs = {}, ...children) {
  const node = document.createElement(tag);
  applyAttrs(node, attrs);
  appendChildren(node, children);
  return node;
}

/**
 * Replace `node`'s content with `kids`, with the same child rules as `el` (null/undefined/false skipped, arrays
 * flattened, strings become text nodes). Use this instead of `node.replaceChildren(...)` whenever a child is
 * conditional: the native method stringifies null into the text "null".
 */
export function setChildren(node, ...kids) {
  node.replaceChildren();
  appendChildren(node, kids);
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

/** Set a status line: `text` becomes its textContent and the node is hidden when the text is empty. */
export function setStatus(node, text) {
  node.textContent = text || '';
  node.hidden = !text;
}

/** Set a live region (`role="status"` / `aria-live`): the node stays in the DOM, visible and simply empty when there is
 *  no text, because screen readers only announce changes inside a region that is already present and not hidden. */
export function setLiveStatus(node, text) {
  node.textContent = text || '';
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

/** One token chip. `extra` merges into the attributes (e.g. `title`, `tabindex`, handlers); `extra.class` is appended. */
export function tokenChip(token, i, extra = {}) {
  const { leadingSpace, text } = displayToken(token.text);
  const { class: extraClass, ...rest } = extra;
  const attrs = {
    class: `chip ${chipClass(i)}${extraClass ? ` ${extraClass}` : ''}`,
    title: Number.isInteger(token.id) ? `token id ${token.id}` : undefined,
    ...rest,
  };
  return el('span', attrs, leadingSpace ? el('span', { class: 'sp', 'aria-hidden': 'true', text: '␣' }) : null, text);
}

/**
 * A row of token chips that batches appends into a DocumentFragment flushed on the next animation frame (setTimeout 0
 * where requestAnimationFrame does not exist, as in tests), so a fast stream does not lay out once per token.
 * → { append(tokenText, { className, title, dataset, attrs }) → chip, insert(node), reset(), flush(), count }
 * `attrs` are extra attributes passed through to `tokenChip` (e.g. tabindex, role). `insert` queues a plain node
 * (a marker between chips) in order without numbering it.
 */
export function chipRow(root) {
  const schedule = typeof requestAnimationFrame === 'function' ? requestAnimationFrame : (fn) => setTimeout(fn, 0);
  let frag = null, scheduled = false, count = 0;
  const flush = () => {
    scheduled = false;
    if (frag) { root.append(frag); frag = null; }
  };
  const queue = (node) => {
    if (!frag) frag = document.createDocumentFragment();
    frag.append(node);
    if (!scheduled) { scheduled = true; schedule(flush); }
    return node;
  };
  return {
    append(tokenText, { className, title, dataset, attrs } = {}) {
      const chip = tokenChip({ text: tokenText }, count, { class: className, title, dataset, ...(attrs || {}) });
      count += 1;
      return queue(chip);
    },
    insert: queue,
    reset() { frag = null; count = 0; root.replaceChildren(); },
    flush,
    get count() { return count; },
  };
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
