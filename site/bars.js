/**
 * Probability bars shared by the prediction chapter (top guesses, "what it considered") and the output panes
 * (alternatives popover). Pure helpers first (tested in tests/bars.test.mjs), then the small DOM pieces.
 */
import { withProbs, rescale } from './probs.js';
import { el, displayToken } from './dom.js';

export function formatPercent(p) {
  if (!Number.isFinite(p) || p <= 0) return '0%';
  const pct = p * 100;
  if (pct < 0.1) return '<0.1%';
  return `${pct < 10 ? pct.toFixed(1) : Math.round(pct)}%`;
}

/** A token's text as a plain label: a visible space marker plus the display form. */
export function tokenLabelText(text) {
  const { leadingSpace, text: shown } = displayToken(text);
  return (leadingSpace ? '␣' : '') + shown;
}

const rowOf = (text, p, other = false) => ({ text, label: other ? 'everything else' : tokenLabelText(text), p, percent: formatPercent(p), other });

/**
 * Rows for the bar chart. `T` null → the raw model probabilities plus a grey "everything else" row for the mass
 * outside the shown set; `T` a number → the shown set rescaled at that temperature (sums to 1, no remainder row).
 * → [{ text, label, p, percent, other }]
 */
export function barRows(top, T = null) {
  if (T === null || T === undefined) {
    const { items, other } = withProbs(top);
    return [...items.map(x => rowOf(x.text, Number.isFinite(x.p) ? x.p : 0)), rowOf(null, other, true)];
  }
  return rescale(top, T).map(x => rowOf(x.text, x.p));
}

// ---- DOM ----------------------------------------------------------------------------------------------------------

/** A token's text as a label element: visible space marker plus the display text. */
export function tokenLabel(text, cls) {
  const { leadingSpace, text: shown } = displayToken(text);
  return el('span', { class: cls }, leadingSpace ? el('span', { class: 'sp', 'aria-hidden': 'true', text: '␣' }) : null, shown);
}

/** One bar row with its fill and percentage nodes, so it can be repainted (animated) without rebuilding. */
export function makeBar(text, { other = false } = {}) {
  const fill = el('span', { class: 'bar-fill', style: { width: '0%' } });
  const pct = el('span', { class: 'bar-pct', text: '0%' });
  const label = other ? el('span', { class: 'bar-label', text: 'everything else' }) : tokenLabel(text, 'bar-label');
  const row = el('div', { class: `bar-row${other ? ' bar-other' : ''}` }, label, el('span', { class: 'bar-track', 'aria-hidden': 'true' }, fill), pct);
  return { row, fill, pct };
}

export function paintBar(bar, p, percent, label, picked = false) {
  bar.fill.style.width = `${(p * 100).toFixed(2)}%`;
  bar.pct.textContent = percent;
  bar.row.classList.toggle('is-picked', Boolean(picked));
  bar.row.setAttribute('aria-label', `${label}: ${percent}`);
}

/**
 * Replace `container`'s content with painted bars for `rows` (from `barRows`, or any [{text, p, percent?, label?, other?}]).
 * `picked` is the text of the row to highlight (or an index); `limit` caps the number of rows. Returns the bars.
 */
export function renderBars(container, rows, { picked = null, limit = Infinity } = {}) {
  const shown = rows.slice(0, limit);
  const bars = shown.map((r, i) => {
    const bar = makeBar(r.text, { other: Boolean(r.other) });
    const p = Number.isFinite(r.p) ? r.p : 0;
    const isPicked = typeof picked === 'number' ? picked === i : picked !== null && !r.other && r.text === picked;
    paintBar(bar, p, r.percent ?? formatPercent(p), r.label ?? (r.other ? 'everything else' : tokenLabelText(r.text)), isPicked);
    return bar;
  });
  container.replaceChildren(...bars.map(b => b.row));
  return bars;
}
