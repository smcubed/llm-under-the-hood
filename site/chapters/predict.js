/**
 * Chapter 4: pick the next word. One `maxTokens: 1` call fetches the model's top guesses for the token after the
 * prompt (bars), the temperature slider rescales them client-side, "Roll the dice" samples one, and "Keep going"
 * streams a continuation token by token with a side panel of what the model considered at each step. Clicking an
 * output token forks the text at that point. Follows the chapter contract in tokens.js; the run lifecycle (abort on a
 * new runId, ignore stale results) comes from run.js, the streamed output line from pane.js. Publishes
 * `results.predict = { runId, usage, cost, model }` once per run from the one-token first call, which is made for
 * every model (models without probabilities just get no bars), so the tokens chapter can show the reported prompt-token
 * count right away.
 */
import { getModel, LIMITS } from '../models.js';
import { rescale, sample } from '../probs.js';
import { el, notice, prefersReducedMotion, setLiveStatus } from '../dom.js';
import { closePopoverWithin } from '../popover.js';
import { createRun } from '../run.js';
import { request } from '../stream.js';
import { barRows, makeBar, paintBar } from '../bars.js';
import { createOutputPane, joinTokens, forkAt, STEP_TOP, CONSIDERED_IDLE } from '../pane.js';

export const HEADING = "The model's top guesses for the next token";
export const HALLUCINATION_CAPTION = 'Notice the red tokens read just as smoothly as the green ones. That is what a hallucination looks like from the inside.';
export const COMPLETION_NOTE = 'This model just continues the text.';
export const IDLE_NOTE = 'Press "Run it" above and the model\'s guesses for the next token appear here.';
export const CONTINUE_TOKENS = 120;
export const DEFAULT_TEMPERATURE = 0.7;
export { STEP_TOP, CONSIDERED_IDLE };

// ---- Pure helpers (tested in tests/predict_helpers.test.mjs) --------------------------------------------------------

export function temperatureCaption(T) {
  if (T < 0.3) return 'Nearly always picks the favorite';
  if (T <= 1.0) return 'Usually the favorite, sometimes a surprise';
  return 'Anything goes';
}

export function formatTemperature(T) {
  return Number(T).toFixed(1);
}

/** Caption under the bars: says whether they are the raw model probabilities or the rescaled shown set. */
export function barsCaption(T) {
  if (T === null || T === undefined) return 'Raw probabilities from the model. Move the slider to rescale them.';
  return `Rescaled at temperature ${formatTemperature(T)}. ${temperatureCaption(T)}.`;
}

export function noProbsMessage(model) {
  return `${model.short} does not share its probabilities. You can still watch it write.`;
}

export function noProbsThisTime(model) {
  return `${model.short} did not return any probabilities this time. You can still watch it write.`;
}

// ---- DOM ----------------------------------------------------------------------------------------------------------

export function mount(root, store) {
  const viz = root.querySelector('.viz');
  if (!viz) return;

  // ---- Build the DOM once ----------------------------------------------------------------------------------------
  const status = el('p', { class: 'status muted small', role: 'status' });
  const noProbs = el('div', { class: 'nolog-card', hidden: true });
  const barsBox = el('div', { class: 'bars', 'aria-label': 'Top guesses for the next token' });
  const barsCap = el('p', { class: 'caption small muted' });

  const slider = el('input', { type: 'range', id: 'predict-temp', min: 0, max: LIMITS.temperatureMax, step: 0.1, value: DEFAULT_TEMPERATURE });
  const tempOut = el('output', { class: 'temp-value', for: 'predict-temp', text: formatTemperature(DEFAULT_TEMPERATURE) });
  const tempLabel = el('label', { class: 'inline-label' }, 'Temperature', slider, tempOut);
  const die = el('span', { class: 'die', 'aria-hidden': 'true', text: '🎲' });
  const rollBtn = el('button', { type: 'button', class: 'secondary' }, die, ' Roll the dice');
  const goBtn = el('button', { type: 'button', class: 'primary compact', text: 'Keep going' });
  const pauseBtn = el('button', { type: 'button', class: 'secondary', text: 'Pause', disabled: true });
  const stepBtn = el('button', { type: 'button', class: 'secondary', text: 'Step', title: 'One more token' });
  const controls = el('div', { class: 'predict-controls' }, tempLabel, rollBtn, goBtn, pauseBtn, stepBtn);
  const errorSlot = el('div', { class: 'error-slot' });

  const paneRoot = el('div');
  const confToggle = el('input', { type: 'checkbox', checked: true });
  const confLabel = el('label', { class: 'inline-label' }, confToggle, 'Color by confidence');
  const legendItem = (key, text) => el('li', {}, el('span', { class: `swatch swatch-${key}`, 'aria-hidden': 'true' }), text);
  const legend = el('ul', { class: 'conf-legend', 'aria-label': 'Confidence legend' },
    legendItem('high', 'green: 60% or more'), legendItem('mid', 'amber: 25–60%'), legendItem('low', 'red: under 25%'));
  const legendRow = el('div', { class: 'legend-row' }, confLabel, legend);
  const hallucination = el('p', { class: 'caption', text: HALLUCINATION_CAPTION });

  const idle = el('p', { class: 'placeholder', text: IDLE_NOTE });
  const stage = el('div', { class: 'predict', hidden: true },
    el('h3', { class: 'panel-title', text: HEADING }), status, noProbs, barsBox, barsCap, controls, errorSlot, paneRoot, legendRow, hallucination);
  viz.replaceChildren(idle, stage);

  // ---- State ------------------------------------------------------------------------------------------------------
  let ctx = null, model = null, prompt = '', system = '';
  let first = null;              // { top: [{text, logprob}], text }
  let loading = false, armed = false, published = false;
  let temperature = DEFAULT_TEMPERATURE, sliderTouched = false;
  let pickedIndex = null;
  let firstReq = null;
  let bars = [];

  const hasProbs = () => Boolean(first?.top?.length);

  const pane = createOutputPane(paneRoot, {
    getModel: () => model,
    getPrefixText: () => prompt,
    showConsidered: true,
    forkable: true,
    footer: false,
    completionNote: COMPLETION_NOTE,
    onChange: () => renderControls(),
    onFork: (index, altText) => {
      if (index >= pane.tokens.length) return;
      pane.setTokens(forkAt(pane.tokens, index, altText), { forkIndex: index });
      continueFrom(CONTINUE_TOKENS);
    },
  });

  // ---- Rendering --------------------------------------------------------------------------------------------------
  function renderControls() {
    const streaming = pane.phase === 'streaming', paused = pane.phase === 'paused';
    const tooLong = joinTokens(pane.tokens).length > LIMITS.prefixChars;
    const why = model && !model.logprobs ? `${model.short} does not share its probabilities, so there is nothing to rescale or roll.` : '';
    slider.disabled = !hasProbs();
    tempLabel.title = why;
    rollBtn.disabled = !hasProbs() || streaming;
    rollBtn.title = why || 'Sample one token from the bars at this temperature';
    goBtn.textContent = paused ? 'Resume' : 'Keep going';
    goBtn.disabled = !armed || streaming || loading || tooLong;
    goBtn.title = tooLong ? 'The continuation is as long as the server allows.' : (paused ? 'Ask for more from the current text' : 'Let the model write up to 120 more tokens');
    stepBtn.disabled = goBtn.disabled;
    pauseBtn.disabled = !streaming;
    confToggle.disabled = !model?.logprobs;
    confLabel.title = why;
  }

  const showNoProbs = (message) => {
    noProbs.textContent = message;
    noProbs.hidden = false;
    barsBox.hidden = true;
    barsCap.hidden = true;
  };

  const renderBars = (T) => {
    if (!hasProbs() || !bars.length) return;
    const rows = barRows(first.top, T);
    bars.forEach((bar, i) => {
      const r = rows[i];
      bar.row.hidden = !r;
      if (r) paintBar(bar, r.p, r.percent, r.label, pickedIndex === i);
    });
    barsCap.textContent = barsCaption(T);
  };

  const buildBars = () => {
    noProbs.hidden = true;
    barsBox.hidden = false;
    barsCap.hidden = false;
    bars = [...first.top.map(t => makeBar(t.text)), makeBar(null, { other: true })];
    barsBox.replaceChildren(...bars.map(b => b.row));
    // Widths start at 0 and are set on the next frame so the CSS transition animates them in; with reduced motion
    // they are painted at once.
    const paint = () => renderBars(sliderTouched ? temperature : null);
    if (typeof requestAnimationFrame === 'function' && !prefersReducedMotion()) requestAnimationFrame(paint); else paint();
  };

  // ---- Requests ---------------------------------------------------------------------------------------------------
  const publish = (done) => {
    if (published || !done) return;
    published = true;
    store.setResult('predict', { runId: ctx.runId, usage: done.usage, cost: done.cost, model: model.id });
  };

  const fetchFirst = () => {
    firstReq?.abort();
    loading = true;
    armed = false;
    first = null;
    errorSlot.replaceChildren();
    setLiveStatus(status, 'Asking the model for its guesses…');
    renderControls();
    firstReq = request(ctx, { model: model.id, prompt, system, maxTokens: 1, topLogprobs: LIMITS.topLogprobs, temperature: 0, prefix: '' }, {
      onToken: (ev) => { first = { top: Array.isArray(ev.top) ? ev.top : [], text: ev.text }; },
      onDone: (done) => {
        firstReq = null;
        setLiveStatus(status, '');
        publish(done);
        loading = false;
        armed = true;
        if (hasProbs()) buildBars();
        else showNoProbs(model.logprobs ? noProbsThisTime(model) : noProbsMessage(model));
        renderControls();
      },
      onError: (message, fromStream, err) => {
        firstReq = null;
        console.error('predict: first call failed', err);
        setLiveStatus(status, '');
        loading = false;
        notice(errorSlot, message, { retry: fetchFirst });
        renderControls();
      },
    });
  };

  const continueFrom = (maxTokens) => {
    closePopoverWithin(root);
    errorSlot.replaceChildren();
    pane.start(ctx, { model: model.id, prompt, system, maxTokens, topLogprobs: STEP_TOP, temperature, prefix: joinTokens(pane.tokens) });
  };

  const restartDice = () => {
    if (prefersReducedMotion()) return;
    die.classList.remove('dice');
    void die.offsetWidth; // restart the keyframes
    die.classList.add('dice');
  };

  const roll = () => {
    if (!hasProbs() || pane.phase === 'streaming') return;
    const dist = rescale(first.top, temperature);
    const pick = sample(dist, Math.random);
    if (!pick) return;
    closePopoverWithin(root);
    pane.clearNotice();
    const i = dist.indexOf(pick);
    const raw = first.top[i];
    pickedIndex = i;
    sliderTouched = true; // the bars now show the distribution the pick was drawn from
    renderBars(temperature);
    restartDice();
    pane.setTokens([{ text: raw.text, logprob: raw.logprob, top: first.top }]);
    renderControls();
  };

  // ---- Wiring -----------------------------------------------------------------------------------------------------
  slider.addEventListener('input', () => {
    temperature = Number(slider.value);
    tempOut.textContent = formatTemperature(temperature);
    sliderTouched = true;
    renderBars(temperature);
  });
  rollBtn.addEventListener('click', roll);
  goBtn.addEventListener('click', () => { if (!goBtn.disabled) continueFrom(CONTINUE_TOKENS); });
  stepBtn.addEventListener('click', () => { if (!stepBtn.disabled) continueFrom(1); });
  pauseBtn.addEventListener('click', () => pane.pause());
  confToggle.addEventListener('change', () => pane.setConfidence(confToggle.checked));

  createRun(store, (runCtx) => {
    ctx = runCtx;
    model = getModel(runCtx.state.modelId);
    prompt = runCtx.state.prompt;
    system = runCtx.state.system || '';
    if (!model) return;
    // Reset everything from the previous run.
    firstReq?.abort(); firstReq = null;
    first = null; loading = false; armed = false; published = false;
    sliderTouched = false; pickedIndex = null; bars = [];
    pane.reset();
    pane.setPrompt(prompt);
    idle.hidden = true;
    stage.hidden = false;
    noProbs.hidden = true;
    barsBox.hidden = false;
    barsCap.hidden = false;
    errorSlot.replaceChildren();
    barsBox.replaceChildren();
    barsCap.textContent = '';
    runCtx.onDispose(() => { firstReq?.abort(); firstReq = null; closePopoverWithin(root); });
    fetchFirst();
  });
  renderControls();
}
