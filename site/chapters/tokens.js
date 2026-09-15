/**
 * Chapter contract (every chapter module follows this):
 * - `mount(root, store)` is called once; it subscribes to the store once and renders into `root.querySelector('.viz')`.
 * - The chapter keeps one AbortController per in-flight request and aborts it when `runId` changes.
 * - Async results carry the `runId` captured when they started; a result whose runId no longer matches
 *   `store.get().runId` is ignored, so a stale response never overwrites a newer run.
 * - Anything other chapters need is published with `store.setResult(key, value)`, never by mutating state directly.
 *
 * Chapter 1: words become tokens. No API calls; the only async work is loading a vendored tokenizer bundle, so
 * staleness is tracked with a render sequence number instead of an AbortController. Publishes
 * `results.tokens = { runId, text, example, tokenizer, tokens: [{id, text}] }` for the attention chapter.
 */
import { loadTokenizer, tokenize } from '../tokenize.js';
import { getModel } from '../models.js';
import { el, tokenChip, debounce, setStatus } from '../dom.js';

export const DEMO_WORDS = ['hyponatremia', 'warfarin', 'banana'];
export const FALLBACK_EXAMPLE = 'The patient presented with chest pain and';
const PROMPT_DEBOUNCE_MS = 150;

const plural = (n, word) => `${n} ${word}${n === 1 ? '' : 's'}`;

/** → { lead: 'N tokens', tail: ' for M characters. The model never sees …' } so the renderer can bold the count. */
export function tokenCaption(n, chars) {
  return { lead: plural(n, 'token'), tail: ` for ${plural(chars, 'character')}. The model never sees letters or words, only these token IDs.` };
}

export function reportedCaption(k) {
  return `The model reported ${plural(k, 'prompt token')} for this prompt.`;
}

/** Models without `exactTokenizer` (everyone but OpenAI) are approximated with o200k; see models.js. */
export function isApproximateTokenizer(model) {
  return !model?.exactTokenizer;
}

export const APPROXIMATION_NOTE = 'This model uses its own tokenizer, so this split is an approximation.';
export const EXAMPLE_NOTE = 'Showing an example until you type your own.';

/** The text to tokenize: the prompt when it has content, otherwise the example. → { text, example } */
export function pickText(prompt, example) {
  const p = String(prompt ?? '');
  return p.trim() ? { text: p, example: false } : { text: example, example: true };
}

const loaded = new Set();

export function mount(root, store) {
  const viz = root.querySelector('.viz');
  if (!viz) return;
  const example = document.querySelector('.starter')?.textContent.trim() || FALLBACK_EXAMPLE;

  const status = el('p', { class: 'status muted small', role: 'status' });
  const row = el('div', { class: 'token-row', 'aria-label': 'Your prompt as tokens' });
  const caption = el('p', { class: 'caption' });
  const reported = el('p', { class: 'caption muted small' });
  const demoGrid = el('div', { class: 'demo-grid' });
  const demo = el('div', { class: 'demo' }, el('p', { class: 'small muted demo-title', text: 'Three words through the same tokenizer:' }), demoGrid);
  viz.replaceChildren(status, row, caption, reported, demo);

  let seq = 0;

  const renderReported = () => {
    const state = store.get();
    const model = getModel(state.modelId);
    // Only the count reported for this run; a stale result from an earlier prompt would mislead.
    const predict = state.results?.predict;
    const k = predict?.runId === state.runId ? predict.usage?.prompt : undefined;
    const parts = [];
    if (Number.isFinite(k)) parts.push(reportedCaption(k));
    if (isApproximateTokenizer(model)) parts.push(APPROXIMATION_NOTE);
    reported.textContent = parts.join(' ');
    reported.hidden = parts.length === 0;
  };

  const render = async () => {
    const my = ++seq;
    const state = store.get();
    const model = getModel(state.modelId);
    const name = model?.tokenizer || 'o200k';
    const { text, example: usingExample } = pickText(state.prompt, example);
    setStatus(status, loaded.has(name) ? (usingExample ? EXAMPLE_NOTE : '') : 'Loading tokenizer…');
    let enc;
    try {
      enc = await loadTokenizer(name);
    } catch (err) {
      if (my !== seq) return;
      setStatus(status, 'Could not load the tokenizer. Reload the page to try again.');
      console.error('tokens: tokenizer failed to load', err);
      return;
    }
    loaded.add(name);
    if (my !== seq) return;
    setStatus(status, usingExample ? EXAMPLE_NOTE : '');

    const tokens = tokenize(enc, text);
    row.replaceChildren(...tokens.map((t, i) => tokenChip(t, i)));
    const c = tokenCaption(tokens.length, text.length);
    caption.replaceChildren(el('strong', { text: c.lead }), c.tail);
    demoGrid.replaceChildren(...DEMO_WORDS.flatMap((word) => [
      el('span', { class: 'demo-word', text: word }),
      el('span', { class: 'demo-chips' }, tokenize(enc, word).map((t, i) => tokenChip(t, i))),
    ]));
    renderReported();
    store.setResult('tokens', { runId: state.runId, text, example: usingExample, tokenizer: name, tokens });
  };

  const debounced = debounce(render, PROMPT_DEBOUNCE_MS);
  store.subscribe((state, keys) => {
    if (keys.includes('runId') || keys.includes('modelId')) { debounced.cancel(); render(); return; }
    if (keys.includes('prompt')) { debounced(); return; }
    if (keys.includes('results')) renderReported();
  });
  render();
}
