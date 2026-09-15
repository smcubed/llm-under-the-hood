/**
 * Chapter 3: every word looks at the others. Panel A draws real GPT-2 attention rows from data/attention.json as
 * arcs above a token row; Panel B fans equal-weight lines across the student's own tokens as an honest sketch.
 * No API calls; the only async work is the data fetch and the tokenizer load. Follows the chapter contract in tokens.js.
 */
import { loadTokenizer, tokenize } from '../tokenize.js';
import { getModel } from '../models.js';
import { el, svg, tokenChip, chipClass, displayToken, debounce, loadWithRetry, prefersReducedMotion, setStatus } from '../dom.js';
import { pickText, FALLBACK_EXAMPLE, EXAMPLE_NOTE } from './tokens.js';

const DATA_URL = 'data/attention.json';
export const ARC_H = 110;          // SVG height above the token row
export const STEP_MS = 500;        // Panel B animation step
const PROMPT_DEBOUNCE_MS = 300;
export const MODEL_NOTE = 'GPT-2, a 2019 model small enough to inspect. Bigger models do the same thing across hundreds of heads.';
export const SKETCH_CAPTION = 'Your prompt: each token can look at every token before it. We are not showing real weights here; hosted models do not share them.';
export const LOADING_NOTE = 'Loading examples…';

/** Quadratic arc from x1 to x2 on the baseline, bulging up by `height`. Always starts with M. */
export function arcPath(x1, x2, baseY, height) {
  const mx = (x1 + x2) / 2;
  const f = (n) => Number(n.toFixed(1));
  return `M ${f(x1)} ${f(baseY)} Q ${f(mx)} ${f(baseY - height)} ${f(x2)} ${f(baseY)}`;
}

/** Scale so the largest entry is 1. All zeros (or empty) come back unchanged, never NaN. */
export function normalizeRow(row) {
  const max = Math.max(0, ...row);
  return max > 0 ? row.map(v => v / max) : row.map(() => 0);
}

/** How high an arc between two x positions should rise: longer arcs rise higher, capped to the SVG. */
export function arcHeight(x1, x2, maxH = ARC_H - 8) {
  return Math.min(maxH, 18 + Math.abs(x1 - x2) * 0.3);
}

const isWordy = (t) => /^[A-Za-z0-9]/.test(t.trim());
/** The whole word a token belongs to, when the tokenizer split it: wordAt(tokens, 10) → "dizzy" for " dizz","y". */
export function wordAt(tokens, i) {
  let a = i, b = i;
  while (a > 0 && !tokens[a].startsWith(' ') && isWordy(tokens[a]) && isWordy(tokens[a - 1])) a--;
  while (b + 1 < tokens.length && !tokens[b + 1].startsWith(' ') && isWordy(tokens[b + 1]) && isWordy(tokens[b])) b++;
  return tokens.slice(a, b + 1).join('').trim();
}

/** Caption segments for a highlight; `strong` marks the bolded words. */
export function highlightCaption(sentence, h, totalHeads) {
  const pct = Math.round(h.weight * 100);
  return [
    { text: `In one of GPT-2's ${totalHeads} attention heads (layer ${h.layer}, head ${h.head}), ` },
    { text: wordAt(sentence.tokens, h.from), strong: true },
    { text: ` puts ${pct}% of its attention on ` },
    { text: wordAt(sentence.tokens, h.to), strong: true },
    { text: '.' },
  ];
}

export function highlightLabel(sentence, h) {
  return `${wordAt(sentence.tokens, h.from)} → ${wordAt(sentence.tokens, h.to)}`;
}

let dataPromise = null;
export function loadAttention({ fetcher = fetch, url = DATA_URL } = {}) {
  if (!dataPromise) {
    dataPromise = fetcher(url).then((r) => { if (!r.ok) throw new Error(`HTTP ${r.status}`); return r.json(); })
      .catch((err) => { dataPromise = null; throw err; });
  }
  return dataPromise;
}

/** x-centre of each chip relative to the stage, from live layout. Zeros when nothing is laid out yet. */
function measureCenters(stage, chips) {
  const s = stage.getBoundingClientRect();
  return chips.map((c) => { const r = c.getBoundingClientRect(); return r.left - s.left + r.width / 2; });
}

/** A scrollable stage: an SVG for arcs sitting directly above a non-wrapping token row. */
function makeStage(label) {
  const arcs = svg('svg', { class: 'arcs', height: ARC_H, 'aria-hidden': 'true' });
  const row = el('div', { class: 'arc-row', role: 'group', 'aria-label': label });
  const stage = el('div', { class: 'arc-stage' }, arcs, row);
  const scroll = el('div', { class: 'arc-scroll' }, stage);
  const fit = () => { const w = Math.max(1, stage.getBoundingClientRect().width || 1); arcs.setAttribute('width', w); arcs.setAttribute('viewBox', `0 0 ${w} ${ARC_H}`); };
  return { scroll, stage, arcs, row, fit };
}

export function mount(root, store) {
  const viz = root.querySelector('.viz');
  if (!viz) return;
  const example = document.querySelector('.starter')?.textContent.trim() || FALLBACK_EXAMPLE;

  // ---- Panel A: real GPT-2 data --------------------------------------------------------------------------------
  const tablist = el('div', { class: 'tabs', role: 'tablist', 'aria-label': 'Sentences' });
  const A = makeStage('Sentence tokens');
  const showRow = el('div', { class: 'show-row' });
  const captionA = el('p', { class: 'caption' });
  const statusA = el('div', { class: 'status muted small', role: 'status' });
  const tabpanel = el('div', { role: 'tabpanel', id: 'attn-real-panel' }, A.scroll, showRow, captionA);
  const panelA = el('div', { class: 'panel', id: 'attn-real' },
    el('h3', { class: 'panel-title', text: 'Two sentences, real weights' }),
    statusA, tablist, tabpanel,
    el('p', { class: 'muted small', text: MODEL_NOTE }));

  let data = null, sentenceIndex = 0, highlightIndex = 0, chipsA = [];

  const drawA = () => {
    if (!data) return;
    const sentence = data.sentences[sentenceIndex];
    const h = sentence.highlights[highlightIndex];
    A.fit();
    const xs = measureCenters(A.stage, chipsA);
    const baseY = ARC_H - 2;
    const norm = normalizeRow(h.row.slice(0, h.from));
    A.arcs.replaceChildren(...norm.map((v, j) => svg('path', {
      class: j === h.to ? 'arc arc-to' : 'arc',
      d: arcPath(xs[h.from], xs[j], baseY, arcHeight(xs[h.from], xs[j])),
      'stroke-width': (1 + 6 * v).toFixed(2),
      opacity: (0.12 + 0.88 * v).toFixed(2),
    })));
    chipsA.forEach((c, i) => {
      c.classList.toggle('is-to', i === h.to);
      c.classList.toggle('is-active', i === h.from);
      if (c.tagName === 'BUTTON') c.setAttribute('aria-pressed', i === h.from ? 'true' : 'false');
    });
    for (const b of showRow.querySelectorAll('button')) b.setAttribute('aria-pressed', Number(b.dataset.h) === highlightIndex ? 'true' : 'false');
    captionA.replaceChildren(...highlightCaption(sentence, h, data.layers * data.heads).map(seg => seg.strong ? el('strong', { text: seg.text }) : seg.text));
  };

  const buildSentence = () => {
    const sentence = data.sentences[sentenceIndex];
    const froms = new Map(sentence.highlights.map((h, k) => [h.from, k]));
    chipsA = sentence.tokens.map((text, i) => {
      const { leadingSpace, text: shown } = displayToken(text);
      const marker = leadingSpace ? el('span', { class: 'sp', 'aria-hidden': 'true', text: '␣' }) : null;
      if (froms.has(i)) {
        return el('button', { type: 'button', class: `chip ${chipClass(i)} is-from`, 'aria-pressed': 'false',
          title: 'Show where this token looks', onClick: () => { highlightIndex = froms.get(i); drawA(); } }, marker, shown);
      }
      return el('span', { class: `chip ${chipClass(i)}` }, marker, shown);
    });
    A.row.replaceChildren(...chipsA);
    showRow.replaceChildren(el('span', { class: 'muted small', text: 'Show:' }), ...sentence.highlights.map((h, k) =>
      el('button', { type: 'button', class: 'secondary small-btn', dataset: { h: k }, 'aria-pressed': 'false', text: highlightLabel(sentence, h),
        onClick: () => { highlightIndex = k; drawA(); } })));
    for (const t of tablist.children) {
      const selected = Number(t.dataset.s) === sentenceIndex;
      t.setAttribute('aria-selected', selected ? 'true' : 'false');
      t.tabIndex = selected ? 0 : -1;
      if (selected) tabpanel.setAttribute('aria-labelledby', t.id);
    }
    drawA();
    requestAnimationFrame?.(drawA); // measure again once the chips have laid out
  };

  const buildA = () => {
    tablist.replaceChildren(...data.sentences.map((s, k) =>
      el('button', { type: 'button', role: 'tab', class: 'tab', id: `attn-tab-${k}`, dataset: { s: k }, 'aria-selected': 'false', 'aria-controls': 'attn-real-panel', text: `Sentence ${k + 1}`,
        onClick: () => { sentenceIndex = k; highlightIndex = 0; buildSentence(); },
        onKeydown: (e) => {
          if (e.key !== 'ArrowRight' && e.key !== 'ArrowLeft') return;
          e.preventDefault();
          sentenceIndex = (k + (e.key === 'ArrowRight' ? 1 : data.sentences.length - 1)) % data.sentences.length;
          highlightIndex = 0; buildSentence(); tablist.children[sentenceIndex]?.focus();
        } })));
    buildSentence();
  };

  // ---- Panel B: the student's tokens, illustrative -------------------------------------------------------------
  const B = makeStage('Your prompt as tokens');
  const statusB = el('p', { class: 'status muted small', role: 'status' });
  const panelB = el('div', { class: 'panel' },
    el('h3', { class: 'panel-title', text: 'Your prompt, the shape of the process' }),
    B.scroll, statusB, el('p', { class: 'caption', text: SKETCH_CAPTION }));

  let chipsB = [], timer = null, step = 0, seqB = 0, fanPending = false;

  const drawFan = (i) => {
    B.fit();
    const xs = measureCenters(B.stage, chipsB);
    const baseY = ARC_H - 2;
    B.arcs.replaceChildren(...Array.from({ length: i }, (_, j) => svg('path', { class: 'arc arc-sketch', d: arcPath(xs[i], xs[j], baseY, arcHeight(xs[i], xs[j])) })));
    chipsB.forEach((c, k) => { c.classList.toggle('is-active', k === i); c.classList.toggle('is-seen', k < i); });
  };

  const stopFan = () => { if (timer !== null) clearInterval(timer); timer = null; };

  const startFan = () => {
    stopFan();
    const n = chipsB.length;
    if (n === 0) return;
    if (prefersReducedMotion() || n === 1) { step = n - 1; drawFan(step); return; }
    step = 1;
    drawFan(step);
    timer = setInterval(() => {
      step += 1;
      if (step >= n) { step = n - 1; stopFan(); }
      drawFan(step);
    }, STEP_MS);
  };

  // The fan needs real chip positions, so it waits until the stage has been laid out (width > 0).
  const startFanWhenVisible = () => {
    if (B.stage.getBoundingClientRect().width > 0) { fanPending = false; startFan(); }
    else fanPending = true;
  };

  const renderB = async () => {
    const my = ++seqB;
    const state = store.get();
    const tokenizerName = getModel(state.modelId)?.tokenizer || 'o200k';
    const { text, example: usingExample } = pickText(state.prompt, example);
    const published = state.results?.tokens;
    let tokens = published?.text === text && published?.tokenizer === tokenizerName ? published.tokens : null;
    if (!tokens) {
      try { tokens = tokenize(await loadTokenizer(tokenizerName), text); }
      catch (err) { console.error('attention: tokenizer failed', err); setStatus(statusB, 'Could not load the tokenizer.'); return; }
    }
    if (my !== seqB) return;
    chipsB = tokens.map((t, i) => tokenChip(t, i));
    B.row.replaceChildren(...chipsB);
    setStatus(statusB, usingExample ? EXAMPLE_NOTE : '');
    startFanWhenVisible();
    requestAnimationFrame?.(() => { if (my === seqB && !fanPending) drawFan(step); });
  };

  // ---- Mount ----------------------------------------------------------------------------------------------------
  viz.replaceChildren(panelA, panelB);
  const load = async () => {
    data = await loadWithRetry(statusA, loadAttention, { note: LOADING_NOTE, failMsg: 'Could not load the attention data.' });
    statusA.hidden = true;
    buildA();
  };
  load();
  renderB();

  if (typeof ResizeObserver !== 'undefined') {
    // One observer per stage so a resize of one panel does not redraw the other.
    new ResizeObserver(() => { drawA(); }).observe(A.stage);
    new ResizeObserver((entries) => {
      if (!chipsB.length) return;
      const width = entries[0]?.contentRect?.width ?? B.stage.getBoundingClientRect().width;
      if (fanPending) { if (width > 0) startFanWhenVisible(); return; }
      drawFan(step);
    }).observe(B.stage);
  }
  const debouncedB = debounce(renderB, PROMPT_DEBOUNCE_MS);
  store.subscribe((state, keys) => {
    if (keys.includes('runId') || keys.includes('modelId')) { debouncedB.cancel(); renderB(); return; }
    if (keys.includes('prompt')) debouncedB();
  });
}
