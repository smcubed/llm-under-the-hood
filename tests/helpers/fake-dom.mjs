/**
 * A tiny stand-in for the DOM: enough of createElement / append / setAttribute / listeners / classList for the
 * helpers and chapter modules under test. Every HTML-string API (innerHTML, outerHTML, insertAdjacentHTML) throws,
 * so a test fails loudly if any code ever reaches for one.
 */

function makeClassList(node) {
  const list = () => node.className.split(/\s+/).filter(Boolean);
  const write = (names) => { node.className = names.join(' '); };
  return {
    add(...names) { const cur = list(); for (const n of names) if (!cur.includes(n)) cur.push(n); write(cur); },
    remove(...names) { write(list().filter(n => !names.includes(n))); },
    contains(name) { return list().includes(name); },
    toggle(name, force) {
      const has = list().includes(name);
      const want = force === undefined ? !has : Boolean(force);
      if (want && !has) this.add(name); else if (!want && has) this.remove(name);
      return want;
    },
  };
}

/**
 * A small selector matcher: compound selectors (`button.x#id[type=range]:not(.y):empty`) joined by descendant (space)
 * or child (`>`) combinators, plus comma-separated lists. Enough for tests; not a full engine.
 */
function matchCompound(node, compound) {
  if (!node || node.nodeType !== 1) return false;
  const re = /([a-zA-Z][\w-]*|\*)|\.([\w-]+)|#([\w-]+)|\[([\w-]+)(?:=(?:"([^"]*)"|'([^']*)'|([^\]]*)))?\]|:not\(([^)]*)\)|:(empty|disabled|checked)/gy;
  let m, consumed = 0;
  while ((m = re.exec(compound)) !== null) {
    consumed = re.lastIndex;
    const [, tag, cls, id, attr, v1, v2, v3, notSel, pseudo] = m;
    if (tag !== undefined) { if (tag !== '*' && node.tagName.toLowerCase() !== tag.toLowerCase()) return false; }
    else if (cls !== undefined) { if (!node.classList.contains(cls)) return false; }
    else if (id !== undefined) { if (node.attributes.id !== id) return false; }
    else if (attr !== undefined) {
      if (!(attr in node.attributes)) return false;
      const want = v1 ?? v2 ?? v3;
      if (want !== undefined && node.attributes[attr] !== want) return false;
    } else if (notSel !== undefined) { if (matchCompound(node, notSel.trim())) return false; }
    else if (pseudo === 'empty') { if (node.children.length) return false; }
    else if (pseudo === 'disabled') { if (!node.disabled) return false; }
    else if (pseudo === 'checked') { if (!node.checked) return false; }
  }
  if (consumed !== compound.length) throw new Error(`fake DOM: unsupported selector "${compound}"`);
  return true;
}
const matches = (node, selector) => selector.split(',').some((alt) => {
  const parts = alt.trim().split(/\s*(>)\s*|\s+/).filter(Boolean);
  let n = node, i = parts.length - 1;
  if (!matchCompound(n, parts[i])) return false;
  i--;
  while (i >= 0) {
    let childOnly = false;
    if (parts[i] === '>') { childOnly = true; i--; }
    n = n.parentNode;
    if (childOnly) { if (!matchCompound(n, parts[i])) return false; i--; continue; }
    while (n && n.nodeType === 1 && !matchCompound(n, parts[i])) n = n.parentNode;
    if (!n || n.nodeType !== 1) return false;
    i--;
  }
  return true;
});
function* walk(node) {
  for (const child of node.children || []) { yield child; yield* walk(child); }
}

function adopt(parent, kid) {
  if (kid === null || kid === undefined) return;
  if (typeof kid === 'string' || typeof kid === 'number') kid = { nodeType: 3, textContent: String(kid), parentNode: null };
  if (kid.nodeType === 11) { const moved = kid.children.splice(0); for (const k of moved) adopt(parent, k); return; }
  if (kid.parentNode) kid.parentNode.children = kid.parentNode.children.filter(c => c !== kid);
  kid.parentNode = parent;
  parent.children.push(kid);
}

const forbidHtml = () => { throw new Error('fake DOM: HTML-string APIs are not allowed (innerHTML/outerHTML/insertAdjacentHTML)'); };

export function fakeFragment() {
  const frag = { nodeType: 11, children: [], parentNode: null };
  frag.append = (...kids) => { for (const k of kids) adopt(frag, k); };
  return frag;
}

export function fakeNode(tagName, ns = null, doc = null) {
  const node = {
    nodeType: 1, tagName, ns, attributes: {}, className: '', dataset: {}, style: {}, children: [], listeners: {}, _text: '', _hidden: false,
    parentNode: null, disabled: false, checked: false, tabIndex: -1, value: '', rect: null,
    /** `hidden` is mirrored to the attribute in both directions, as in a real element. */
    get hidden() { return node._hidden; },
    set hidden(v) { node._hidden = Boolean(v); if (node._hidden) node.attributes.hidden = ''; else delete node.attributes.hidden; },
    get isConnected() { for (let n = node; n; n = n.parentNode) if (n === doc?.documentElement) return true; return false; },
    setAttribute(k, v) {
      node.attributes[k] = String(v);
      if (k === 'hidden') node._hidden = true; else if (k === 'disabled') node.disabled = true;
      else if (k === 'checked') node.checked = true; else if (k === 'value') node.value = String(v);
    },
    getAttribute(k) { return k in node.attributes ? node.attributes[k] : null; },
    removeAttribute(k) { delete node.attributes[k]; if (k === 'hidden') node._hidden = false; },
    hasAttribute(k) { return k in node.attributes; },
    append(...kids) { for (const k of kids) adopt(node, k); },
    prepend(...kids) { const rest = node.children.splice(0); for (const k of kids) adopt(node, k); for (const k of rest) node.children.push(k); },
    replaceChildren(...kids) { for (const c of node.children) c.parentNode = null; node.children = []; node.append(...kids); },
    remove() { if (node.parentNode) { node.parentNode.children = node.parentNode.children.filter(c => c !== node); node.parentNode = null; } },
    contains(other) { for (let n = other; n; n = n.parentNode) if (n === node) return true; return false; },
    closest(selector) { for (let n = node; n && n.nodeType === 1; n = n.parentNode) if (matches(n, selector)) return n; return null; },
    matches(selector) { return matches(node, selector); },
    querySelector(selector) { for (const n of walk(node)) if (matches(n, selector)) return n; return null; },
    querySelectorAll(selector) { return [...walk(node)].filter(n => matches(n, selector)); },
    addEventListener(type, fn) { (node.listeners[type] ||= []).push(fn); },
    removeEventListener(type, fn) { node.listeners[type] = (node.listeners[type] || []).filter(f => f !== fn); },
    /** Fire `type` on this node, then bubble to ancestors (and the document) unless `stopPropagation` is called.
     *  A `click` on a disabled control is dropped, as browsers do. */
    dispatch(type, event = {}) {
      const ev = { type, target: node, defaultPrevented: false, preventDefault() { ev.defaultPrevented = true; }, stopPropagation() { ev.stopped = true; }, ...event };
      if (type === 'click' && node.disabled) return ev;
      for (let n = node; n && !ev.stopped; n = n.parentNode) { ev.currentTarget = n; for (const fn of [...(n.listeners?.[type] || [])]) fn(ev); }
      if (!ev.stopped && doc) { ev.currentTarget = doc; for (const fn of [...(doc.listeners[type] || [])]) fn(ev); }
      return ev;
    },
    focus() { if (doc) doc.activeElement = node; },
    blur() { if (doc && doc.activeElement === node) doc.activeElement = doc.body; },
    /** A small nonzero box by default so layout-dependent code (popover placement) sees a real anchor; set `rect` to override. */
    getBoundingClientRect() { return node.rect || { left: 0, top: 0, right: 100, bottom: 20, width: 100, height: 20 }; },
    get offsetWidth() { return node.rect?.width || 0; },
    get offsetHeight() { return node.rect?.height || 0; },
    get textContent() { return node._text || node.children.map(c => c.textContent ?? '').join(''); },
    set textContent(v) { node._text = String(v ?? ''); for (const c of node.children) c.parentNode = null; node.children = []; },
    get innerHTML() { forbidHtml(); },
    set innerHTML(_) { forbidHtml(); },
    get outerHTML() { forbidHtml(); },
    set outerHTML(_) { forbidHtml(); },
    insertAdjacentHTML() { forbidHtml(); },
  };
  node.classList = makeClassList(node);
  return node;
}

export function createFakeDocument() {
  const doc = { nodeType: 9, listeners: {}, activeElement: null, parentNode: null };
  doc.createElement = (tag) => fakeNode(tag, null, doc);
  doc.createElementNS = (ns, tag) => fakeNode(tag, ns, doc);
  doc.createTextNode = (text) => ({ nodeType: 3, textContent: String(text), parentNode: null });
  doc.createDocumentFragment = fakeFragment;
  doc.addEventListener = (type, fn) => { (doc.listeners[type] ||= []).push(fn); };
  doc.removeEventListener = (type, fn) => { doc.listeners[type] = (doc.listeners[type] || []).filter(f => f !== fn); };
  doc.dispatch = (type, event = {}) => { const ev = { type, target: doc, ...event }; for (const fn of [...(doc.listeners[type] || [])]) fn(ev); return ev; };
  doc.documentElement = fakeNode('html', null, doc);
  doc.documentElement.clientWidth = 1024;
  doc.body = fakeNode('body', null, doc);
  doc.documentElement.append(doc.body);
  doc.activeElement = doc.body;
  doc.getElementById = (id) => doc.documentElement.querySelector(`#${id}`);
  doc.querySelector = (sel) => doc.documentElement.querySelector(sel);
  doc.querySelectorAll = (sel) => doc.documentElement.querySelectorAll(sel);
  return doc;
}

export function createFakeWindow() {
  const win = { scrollX: 0, scrollY: 0, innerWidth: 1024, innerHeight: 768, listeners: {} };
  win.addEventListener = (type, fn) => { (win.listeners[type] ||= []).push(fn); };
  win.removeEventListener = (type, fn) => { win.listeners[type] = (win.listeners[type] || []).filter(f => f !== fn); };
  win.dispatch = (type, event = {}) => { for (const fn of [...(win.listeners[type] || [])]) fn({ type, ...event }); };
  return win;
}

/** Install `document` and `window` fakes on globalThis; call the returned `restore()` in afterEach. */
export function installFakeDom() {
  const saved = { document: globalThis.document, window: globalThis.window };
  const document = createFakeDocument();
  const window = createFakeWindow();
  window.document = document;
  globalThis.document = document;
  globalThis.window = window;
  return {
    document, window,
    restore() {
      if (saved.document === undefined) delete globalThis.document; else globalThis.document = saved.document;
      if (saved.window === undefined) delete globalThis.window; else globalThis.window = saved.window;
    },
  };
}
