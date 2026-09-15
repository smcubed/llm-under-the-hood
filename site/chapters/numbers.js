/**
 * Chapter 2: tokens become numbers. An SVG scatter of ~300 words from data/embeddings.json (fetched once, cached in
 * module scope). Words from the prompt that are in the vocabulary are drawn larger with labels; hover or focus on any
 * point shows its five nearest neighbors. No API calls. Follows the chapter contract in tokens.js.
 */
import { el, svg, debounce, notice, prefersReducedMotion } from '../dom.js';
import { pickText, FALLBACK_EXAMPLE } from './tokens.js';

export const VIEW = { w: 600, h: 400, pad: 24 };
export const GROUPS = ['drug', 'anatomy', 'symptom', 'disease', 'test', 'people', 'place', 'food', 'everyday', 'verb', 'time'];
export const CAPTION = 'Each token becomes a list of 384 numbers. Flattened to two dimensions here. Words used in similar ways land near each other.';
export const NONE_ON_MAP = 'None of your words are on this small map; hover around anyway.';
export const LOADING_NOTE = 'Loading map…';
const DATA_URL = 'data/embeddings.json';
const PROMPT_DEBOUNCE_MS = 150;

/** Unique lowercase words with punctuation stripped; possessive 's is dropped so "grandmother's" matches "grandmother". */
export function promptWords(prompt) {
  const cleaned = String(prompt ?? '').toLowerCase().replace(/['’]s\b/g, '');
  return [...new Set(cleaned.split(/[^a-z]+/).filter(Boolean))];
}

/** Map [-1, 1] coordinates to the SVG viewBox (y up). → { cx, cy } */
export function project(x, y) {
  const { w, h, pad } = VIEW;
  const cx = pad + ((x + 1) / 2) * (w - 2 * pad);
  const cy = h - pad - ((y + 1) / 2) * (h - 2 * pad);
  return { cx: Number(cx.toFixed(1)), cy: Number(cy.toFixed(1)) };
}

/** Which prompt words exist in the vocabulary, in prompt order. */
export function matchWords(words, vocab) {
  const set = vocab instanceof Set ? vocab : new Set(vocab);
  return words.filter(w => set.has(w));
}

export function mapStatus(hits) {
  if (!hits.length) return NONE_ON_MAP;
  const n = hits.length;
  return `${n} of your words ${n === 1 ? 'is' : 'are'} on the map: ${hits.join(', ')}.`;
}

export function neighborLabel(word, group, neighbors = []) {
  const near = neighbors.map(n => `${n.w} ${n.s.toFixed(2)}`).join(', ');
  return `${word} (${group}). Nearest: ${near || 'none listed'}.`;
}

let dataPromise = null;
/** Fetch the map once; a failed fetch is not cached so Retry can succeed. */
export function loadEmbeddings({ fetcher = fetch, url = DATA_URL } = {}) {
  if (!dataPromise) {
    dataPromise = fetcher(url).then((r) => {
      if (!r.ok) throw new Error(`HTTP ${r.status}`);
      return r.json();
    }).catch((err) => { dataPromise = null; throw err; });
  }
  return dataPromise;
}

export function mount(root, store) {
  const viz = root.querySelector('.viz');
  if (!viz) return;
  const example = document.querySelector('.starter')?.textContent.trim() || FALLBACK_EXAMPLE;
  let data = null, points = new Map();

  const tip = el('div', { class: 'map-tip', role: 'tooltip', hidden: true });
  const pointsLayer = svg('g', { class: 'points' });
  const labelsLayer = svg('g', { class: 'labels' });
  const map = svg('svg', { class: 'map', viewBox: `0 0 ${VIEW.w} ${VIEW.h}`, width: '100%', role: 'group', 'aria-label': 'Word map: about 300 words placed by meaning' }, pointsLayer, labelsLayer);
  const wrap = el('div', { class: 'map-wrap' }, map, tip);
  const legend = el('ul', { class: 'legend', 'aria-label': 'Word groups' });
  const caption = el('p', { class: 'caption', text: CAPTION });
  const status = el('p', { class: 'status muted small', role: 'status' });
  const stage = el('div');

  const showTip = (pt) => {
    const { w, g } = pt.word;
    tip.replaceChildren(
      el('strong', { text: w }), el('span', { class: 'muted', text: ` · ${g}` }),
      el('ol', { class: 'tip-list' }, (data.neighbors[w] || []).map(n => el('li', {}, el('span', { text: n.w }), el('span', { class: 'muted tip-score', text: n.s.toFixed(2) })))),
    );
    tip.hidden = false;
    const wr = wrap.getBoundingClientRect?.() || { left: 0, top: 0, width: VIEW.w };
    const wrapWidth = wr.width || VIEW.w;
    const scale = wrapWidth / VIEW.w;
    const x = pt.cx * scale, y = pt.cy * scale;
    const tipWidth = tip.offsetWidth || 180; // measured now that it is visible
    tip.style.left = `${Math.min(Math.max(x, 8), Math.max(8, wrapWidth - tipWidth - 8))}px`;
    // Below the point in the top half of the map, above it in the bottom half, so the card's overflow never clips it.
    const below = pt.cy < VIEW.h / 2;
    tip.style.top = `${below ? y + 12 : y - 12}px`;
    tip.style.transform = below ? 'none' : 'translateY(-100%)';
  };
  const hideTip = () => { tip.hidden = true; };
  // One set of delegated listeners on the layer instead of four per point.
  const pointFor = (target) => { const g = target?.closest?.('.pt'); return g ? points.get(g.getAttribute('data-w')) : null; };
  pointsLayer.addEventListener('mouseover', (e) => { const pt = pointFor(e.target); if (pt) showTip(pt); });
  pointsLayer.addEventListener('mouseout', (e) => { const pt = pointFor(e.target); if (pt && !pt.g.contains(e.relatedTarget)) hideTip(); });
  pointsLayer.addEventListener('focusin', (e) => { const pt = pointFor(e.target); if (pt) showTip(pt); });
  pointsLayer.addEventListener('focusout', (e) => { if (!pointFor(e.relatedTarget)) hideTip(); });
  wrap.addEventListener('keydown', (e) => { if (e.key === 'Escape' && !tip.hidden) { e.preventDefault(); hideTip(); } });

  const build = () => {
    points = new Map();
    pointsLayer.replaceChildren();
    labelsLayer.replaceChildren();
    for (const word of data.words) {
      const { cx, cy } = project(word.x, word.y);
      const circle = svg('circle', { cx, cy, r: 4 });
      const g = svg('g', { class: 'pt', 'data-g': word.g, 'data-w': word.w, tabindex: 0, role: 'img', 'aria-label': neighborLabel(word.w, word.g, data.neighbors[word.w]) }, circle);
      const pt = { word, cx, cy, g, circle, label: null };
      pointsLayer.append(g);
      points.set(word.w, pt);
    }
    legend.replaceChildren(...GROUPS.filter(gr => data.words.some(w => w.g === gr)).map(gr =>
      el('li', { 'data-g': gr }, el('span', { class: 'swatch', 'aria-hidden': 'true' }), gr)));
    stage.replaceChildren(wrap, legend, caption, status);
    viz.replaceChildren(stage);
  };

  const highlight = () => {
    if (!data) return;
    const state = store.get();
    const { text } = pickText(state.prompt, example);
    const hits = matchWords(promptWords(text), points.keys());
    const hitSet = new Set(hits);
    labelsLayer.replaceChildren();
    for (const pt of points.values()) {
      const hit = hitSet.has(pt.word.w);
      pt.g.setAttribute('class', hit ? 'pt hit' : 'pt');
      pt.circle.setAttribute('r', hit ? 7 : 4);
      if (hit) {
        // Labels live in their own layer so they draw above every circle.
        const label = svg('text', { class: 'pt-label', x: pt.cx, y: pt.cy - 10, 'text-anchor': 'middle', text: pt.word.w });
        labelsLayer.append(label);
        if (prefersReducedMotion()) pt.g.setAttribute('class', 'pt hit still');
      }
    }
    status.textContent = mapStatus(hits);
    store.setResult('numbers', { runId: state.runId, hits });
  };

  const load = async () => {
    // A skeleton the size of the map keeps the page from jumping when the data lands.
    viz.replaceChildren(el('div', { class: 'map-skeleton', 'aria-hidden': 'true' }), el('p', { class: 'status muted small', role: 'status', text: LOADING_NOTE }));
    try {
      data = await loadEmbeddings();
    } catch (err) {
      console.error('numbers: could not load embeddings', err);
      notice(viz, 'Could not load the word map.', { retry: load });
      return;
    }
    build();
    highlight();
  };

  const debounced = debounce(highlight, PROMPT_DEBOUNCE_MS);
  store.subscribe((state, keys) => {
    if (keys.includes('runId')) { debounced.cancel(); highlight(); return; }
    if (keys.includes('prompt')) debounced();
  });
  load();
}
