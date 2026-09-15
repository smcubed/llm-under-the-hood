/**
 * Chapter 5: from autocomplete to assistant. Two panes run the same prompt on every runId: the left one on the 2022
 * completion model (it continues the text), the right one on the student's chosen chat model (it answers). A system
 * prompt control above the panes (presets or a custom instruction) writes `store.system`, which chapters 4 and 6 also
 * use, and "Run both again" re-runs just these two panes with it. Each pane footer shows latency, tokens and cost, plus
 * the model's first three guesses for its first token when it shares them. Follows the chapter contract in tokens.js;
 * the streaming panes come from pane.js. Publishes `results.assistant = { runId, left, right }` (model ids).
 */
import { AUTOCOMPLETE_MODEL, DEFAULT_MODEL, LIMITS, getModel } from '../models.js';
import { el } from '../dom.js';
import { createRun } from '../run.js';
import { createOutputPane } from '../pane.js';
import { tokenLabelText } from '../bars.js';

export const LEFT_LABEL = 'GPT-3.5 Instruct, 2022 (autocomplete)';
export const LEFT_CAPTION = 'It continued your text. It was never taught to answer.';
export const RIGHT_CAPTION = 'Trained afterwards on examples of helpful answers, so it treats your text as a request.';
export const IDLE_NOTE = 'Press "Run it" above and both models take your prompt here.';
export const MAX_TOKENS = 80;
export const TOP = 3;
export const TEMPERATURE = 0.7;
export const SYSTEM_PRESETS = Object.freeze([
  { key: 'none', label: 'None', text: '' },
  { key: 'nurse', label: 'Nurse educator', text: 'You are a nurse educator. Answer at a sixth-grade reading level in two short sentences.' },
  { key: 'terse', label: 'Terse decision support', text: 'You are a terse clinical decision support tool. Bullet points only. No preamble.' },
  { key: 'custom', label: 'Custom…', text: null },
]);

// ---- Pure helpers (tested in tests/assistant_chapter.test.mjs) -----------------------------------------------------

/** The chat model for the right pane: the chosen one, unless that is the instruct model (or unknown), then the default. */
export function pickAssistantModel(chosenId) {
  if (!chosenId || chosenId === AUTOCOMPLETE_MODEL || !getModel(chosenId)) return DEFAULT_MODEL;
  return chosenId;
}

/** "First guesses: a · b · c" from a first token's alternatives, or a note that none were shared. */
export function firstGuessesText(top) {
  if (!Array.isArray(top) || top.length === 0) return 'First guesses: (no alternatives shared)';
  return `First guesses: ${top.slice(0, TOP).map(t => tokenLabelText(t.text)).join(' · ')}`;
}

/** Which preset chip matches a system prompt text: 'none' for empty, a preset key for its exact text, else 'custom'. */
export function presetFor(system) {
  const s = system || '';
  return SYSTEM_PRESETS.find(p => p.text === s)?.key ?? 'custom';
}

// ---- DOM ----------------------------------------------------------------------------------------------------------

export function mount(root, store) {
  const viz = root.querySelector('.viz');
  if (!viz) return;

  // ---- System prompt control -------------------------------------------------------------------------------------
  const radios = new Map();
  const chips = SYSTEM_PRESETS.map((p) => {
    const input = el('input', { type: 'radio', name: 'assistant-system', value: p.key });
    radios.set(p.key, input);
    return el('label', { class: 'system-chip' }, input, p.label);
  });
  const custom = el('textarea', { id: 'assistant-system-custom', rows: 2, maxlength: LIMITS.systemChars, placeholder: 'Type an instruction for the model, for example: Answer as a pharmacist would.' });
  const counter = el('span', { class: 'counter-inline', text: `0 / ${LIMITS.systemChars}` });
  const customBox = el('div', { class: 'system-custom', hidden: true },
    el('label', { for: 'assistant-system-custom', class: 'small', text: 'Custom system prompt' }), custom, el('p', { class: 'counter' }, counter));
  const rerunBtn = el('button', { type: 'button', class: 'primary compact', text: 'Run both again', disabled: true, title: 'Run the prompt through both models with this system prompt' });
  const shared = el('span', { class: 'muted small', text: 'The same system prompt is used in chapters 4 and 6.' });
  const control = el('div', { class: 'system-control' },
    el('fieldset', { class: 'system-chips' }, el('legend', { text: 'System prompt (a hidden instruction sent before your text)' }), ...chips),
    customBox,
    el('div', { class: 'system-actions' }, rerunBtn, shared));

  // ---- Panes ------------------------------------------------------------------------------------------------------
  const paneBlock = (title, caption) => {
    const titleEl = el('h4', { class: 'pane-title', text: title });
    const body = el('div');
    const guesses = el('p', { class: 'first-guesses small muted' });
    const wrap = el('article', { class: 'pane' }, el('div', { class: 'pane-head' }, titleEl), el('p', { class: 'pane-caption small muted', text: caption }), body, guesses);
    return { wrap, titleEl, body, guesses };
  };
  const left = paneBlock(LEFT_LABEL, LEFT_CAPTION);
  const right = paneBlock('', RIGHT_CAPTION);
  const panes = el('div', { class: 'panes', hidden: true }, left.wrap, right.wrap);
  const idle = el('p', { class: 'placeholder', text: IDLE_NOTE });
  viz.replaceChildren(control, idle, panes);

  // ---- State ------------------------------------------------------------------------------------------------------
  let ctx = null, prompt = '', system = store.get().system || '', rightModel = getModel(DEFAULT_MODEL), localRun = 0;
  const leftModel = getModel(AUTOCOMPLETE_MODEL);

  const makePane = (block, getModelFn) => createOutputPane(block.body, {
    getModel: getModelFn,
    getPrefixText: () => prompt,
    showConsidered: false,
    forkable: false,
    alternatives: false,
    footer: true,
    onToken: (t, i) => { if (i === 0) block.guesses.textContent = firstGuessesText(t.top); },
  });
  const leftPane = makePane(left, () => leftModel);
  const rightPane = makePane(right, () => rightModel);

  // ---- System prompt wiring --------------------------------------------------------------------------------------
  const syncCounter = () => { counter.textContent = `${custom.value.length} / ${LIMITS.systemChars}`; };
  const setSystem = (text) => {
    system = text;
    if (store.get().system !== text) store.set({ system: text });
  };
  const applyPreset = (key) => {
    const preset = SYSTEM_PRESETS.find(p => p.key === key);
    customBox.hidden = key !== 'custom';
    if (key === 'custom') { setSystem(custom.value); custom.focus?.(); }
    else setSystem(preset?.text ?? '');
  };
  for (const [key, input] of radios) input.addEventListener('change', () => { if (input.checked) applyPreset(key); });
  custom.addEventListener('input', () => { syncCounter(); if (radios.get('custom').checked) setSystem(custom.value); });
  // Initial state from the store (a preset if it matches, otherwise the custom field holds the text).
  const initialKey = presetFor(system);
  radios.get(initialKey).checked = true;
  if (initialKey === 'custom') { custom.value = system; customBox.hidden = false; }
  syncCounter();

  // ---- Runs -------------------------------------------------------------------------------------------------------
  const runBoth = () => {
    if (!ctx) return;
    localRun += 1;
    const myRun = localRun;
    const localCtx = { signal: ctx.signal, isCurrent: () => ctx.isCurrent() && localRun === myRun };
    const params = (model) => ({ model: model.id, prompt, system, maxTokens: MAX_TOKENS, topLogprobs: TOP, temperature: TEMPERATURE, prefix: '' });
    for (const [pane, block] of [[leftPane, left], [rightPane, right]]) { pane.reset(); block.guesses.textContent = ''; }
    right.titleEl.textContent = rightModel.label;
    leftPane.start(localCtx, params(leftModel));
    rightPane.start(localCtx, params(rightModel));
    store.setResult('assistant', { runId: ctx.runId, left: leftModel.id, right: rightModel.id });
  };
  rerunBtn.addEventListener('click', () => { if (!rerunBtn.disabled) runBoth(); });

  createRun(store, (runCtx) => {
    ctx = runCtx;
    prompt = runCtx.state.prompt;
    system = runCtx.state.system || '';
    rightModel = getModel(pickAssistantModel(runCtx.state.modelId));
    idle.hidden = true;
    panes.hidden = false;
    rerunBtn.disabled = false;
    runCtx.onDispose(() => { leftPane.reset(); rightPane.reset(); });
    runBoth();
  });
}
