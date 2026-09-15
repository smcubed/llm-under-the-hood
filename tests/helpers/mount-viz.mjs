/**
 * A chapter root for the fake DOM: `<section><div class="viz"></div></section>` appended to the document body, the
 * shape `mount(root, store)` expects, plus the query helpers every chapter test uses.
 *   mountViz(dom) → { root, viz, q(selector), button(text) }
 */
export function mountViz(dom) {
  const viz = dom.document.createElement('div'); viz.className = 'viz';
  const root = dom.document.createElement('section'); root.append(viz);
  dom.document.body.append(root);
  const q = (sel) => viz.querySelector(sel);
  const button = (text) => viz.querySelectorAll('button').find(b => b.textContent.trim() === text);
  return { root, viz, q, button };
}
