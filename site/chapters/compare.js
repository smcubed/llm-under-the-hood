/**
 * Chapter 6: compare the eras. Three model pickers, a prompt field (prefilled from the main prompt until the student
 * edits it) with four suggested comparison prompts, a read-only echo of the shared system prompt from chapter 5, and
 * "Compare" / "Stop all". The three panes stream concurrently, each with a header (label, year, provider, open weights,
 * blurb, a cost warning for GPT-4), confidence tints and hover/click alternatives for probability-sharing models, and
 * a footer with latency, tokens and cost. Errors stay in their pane. Runs are local to this chapter (they do not depend
 * on the global runId); nothing is published to results.
 */
import { LIMITS, getModel } from '../models.js';
import { buildModelSelect } from '../model-select.js';
import { el } from '../dom.js';
import { createOutputPane } from '../pane.js';

export const DEFAULT_PICKS = Object.freeze(['openai/gpt-3.5-turbo', 'anthropic/claude-haiku-4.5', 'meta-llama/llama-3.3-70b-instruct']);
export const SUGGESTED_PROMPTS = Object.freeze([
  'Who won the Nobel Prize in Medicine last year?',
  'A 70 kg adult takes 500 mg acetaminophen every 4 hours. What is the daily total, and is it safe?',
  'Cite one peer-reviewed paper showing aspirin prevents migraines.',
  "What is today's date?",
]);
export const MAX_TOKENS = 120;
export const TOP = 5;
export const TEMPERATURE = 0.7;
export const GPT4_COST_NOTE = 'about 100× the cost of GPT-4o mini';
export const IDLE_NOTE = 'Pick up to three models, check the prompt, and press "Compare".';
export const ECHO_CHARS = 60;

// ---- Pure helpers (tested in tests/compare_chapter.test.mjs) -------------------------------------------------------

/** The read-only echo of chapter 5's system prompt, cut to its first 60 characters. */
export function systemEchoText(system) {
  const s = (system || '').trim();
  if (!s) return 'System prompt: none';
  return `System prompt: “${s.length > ECHO_CHARS ? `${s.slice(0, ECHO_CHARS).trimEnd()}…` : s}”`;
}

// ---- DOM ----------------------------------------------------------------------------------------------------------

export function mount(root, store) {
  const viz = root.querySelector('.viz');
  if (!viz) return;

  // ---- Controls ---------------------------------------------------------------------------------------------------
  const selects = DEFAULT_PICKS.map((id, i) => {
    const select = el('select', { id: `compare-model-${i + 1}`, name: `compare-model-${i + 1}` });
    buildModelSelect(select, { selected: id });
    return select;
  });
  const picks = el('div', { class: 'model-picks' }, ...selects.map((s, i) => el('div', { class: 'field' }, el('label', { for: s.id, text: `Model ${i + 1}` }), s)));
  const field = el('textarea', { id: 'compare-prompt', rows: 2, maxlength: LIMITS.promptChars, 'aria-describedby': 'compare-counter', autocomplete: 'off', placeholder: 'A question for all three models.' });
  const counter = el('span', { id: 'compare-counter', text: `0 / ${LIMITS.promptChars}` });
  const suggested = el('div', { class: 'suggested', role: 'group', 'aria-label': 'Suggested comparison prompts' },
    ...SUGGESTED_PROMPTS.map(text => el('button', { type: 'button', class: 'starter', text, onClick: () => { field.value = text; touched = true; syncPrompt(); field.focus?.(); } })));
  const promptBox = el('div', { class: 'compare-prompt' },
    el('label', { for: 'compare-prompt', text: `Prompt for all three (up to ${LIMITS.promptChars} characters)` }), field, el('p', { class: 'counter' }, counter), suggested);
  const echoText = el('span');
  const echo = el('p', { class: 'system-echo small muted' }, echoText, ' · ', el('a', { href: '#ch-assistant', text: 'change it in chapter 5' }));
  const compareBtn = el('button', { type: 'button', class: 'primary compact', text: 'Compare' });
  const stopBtn = el('button', { type: 'button', class: 'secondary', text: 'Stop all', disabled: true });
  const controls = el('div', { class: 'compare-controls' }, picks, promptBox, echo, el('div', { class: 'compare-actions' }, compareBtn, stopBtn));

  // ---- Panes ------------------------------------------------------------------------------------------------------
  const slots = selects.map((select) => {
    const head = el('div', { class: 'pane-head' });
    const blurb = el('p', { class: 'pane-blurb small muted' });
    const costNote = el('p', { class: 'pane-cost-note small', hidden: true, text: GPT4_COST_NOTE });
    const body = el('div');
    const wrap = el('article', { class: 'pane' }, head, blurb, costNote, body);
    const slot = { select, head, blurb, costNote, body, wrap, model: getModel(select.value), pane: null };
    slot.pane = createOutputPane(body, {
      getModel: () => slot.model,
      getPrefixText: () => '',
      showConsidered: false,
      forkable: false,
      alternatives: true,
      footer: true,
      onChange: renderButtons,
    });
    return slot;
  });
  const grid = el('div', { class: 'panes compare-grid' }, ...slots.map(s => s.wrap));
  const idle = el('p', { class: 'placeholder', text: IDLE_NOTE });
  viz.replaceChildren(controls, idle, grid);

  // ---- State ------------------------------------------------------------------------------------------------------
  let touched = false, localRun = 0, controller = null, ran = false;

  function renderButtons() {
    const streaming = slots.some(s => s.pane.phase === 'streaming');
    compareBtn.disabled = field.value.trim().length === 0;
    stopBtn.disabled = !streaming;
  }
  const renderHead = (slot) => {
    const m = slot.model;
    slot.head.replaceChildren(
      el('h4', { class: 'pane-title', text: m.label }),
      el('span', { class: 'badge badge-year', text: String(m.year) }),
      el('span', { class: 'pane-provider', text: m.provider }),
      m.open ? el('span', { class: 'badge badge-open', text: 'open weights' }) : null,
      m.bucket === 'gpt4' ? el('span', { class: 'badge badge-cost', title: GPT4_COST_NOTE, text: '$$$' }) : null);
    slot.blurb.textContent = m.blurb || '';
    slot.costNote.hidden = m.bucket !== 'gpt4';
  };
  const syncPrompt = () => {
    counter.textContent = `${field.value.length} / ${LIMITS.promptChars}`;
    renderButtons();
  };

  const compare = () => {
    const prompt = field.value.trim();
    if (!prompt) return;
    localRun += 1;
    const myRun = localRun;
    controller?.abort();
    controller = new AbortController();
    const ctx = { signal: controller.signal, isCurrent: () => localRun === myRun };
    const system = store.get().system || '';
    ran = true;
    idle.hidden = true;
    grid.hidden = false;
    for (const slot of slots) {
      slot.model = getModel(slot.select.value) || slot.model;
      renderHead(slot);
      slot.pane.reset();
      slot.pane.start(ctx, { model: slot.model.id, prompt, system, maxTokens: MAX_TOKENS, topLogprobs: TOP, temperature: TEMPERATURE, prefix: '' });
    }
    renderButtons();
  };
  const stopAll = () => {
    controller?.abort();
    for (const slot of slots) slot.pane.stop();
    renderButtons();
  };

  // ---- Wiring -----------------------------------------------------------------------------------------------------
  for (const slot of slots) {
    renderHead(slot);
    slot.select.addEventListener('change', () => {
      slot.model = getModel(slot.select.value) || slot.model;
      renderHead(slot);
      slot.pane.reset(); // old output would now sit under the wrong header
    });
  }
  field.addEventListener('input', () => { touched = true; syncPrompt(); });
  compareBtn.addEventListener('click', () => { if (!compareBtn.disabled) compare(); });
  stopBtn.addEventListener('click', () => { if (!stopBtn.disabled) stopAll(); });

  const setEcho = (system) => { echoText.textContent = systemEchoText(system); };
  store.subscribe((state, keys) => {
    if (keys.includes('system')) setEcho(state.system);
    if (keys.includes('runId') && state.runId && !touched) { field.value = state.prompt || ''; syncPrompt(); }
  });
  const initial = store.get();
  setEcho(initial.system);
  field.value = initial.prompt || '';
  grid.hidden = !ran;
  syncPrompt();
}
