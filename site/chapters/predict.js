/**
 * Chapter 4: pick the next word. One `maxTokens: 1` call fetches the model's top guesses for the token after the
 * prompt (bars), the temperature slider rescales them client-side, "Roll the dice" samples one, and "Keep going"
 * streams a continuation token by token with a side panel of what the model considered at each step. Clicking an
 * output token forks the text at that point. Follows the chapter contract in tokens.js; the run lifecycle (abort on a
 * new runId, ignore stale results) comes from run.js. Publishes `results.predict = { runId, usage, cost, model }` once
 * per run, from the first call whose `prefix` is empty, so the tokens chapter can show the reported prompt-token count.
 */
import { generate } from '../api.js';
import { getModel, LIMITS } from '../models.js';
import { withProbs, rescale, sample, band } from '../probs.js';
import { el, displayToken, chipRow, notice, setStatus } from '../dom.js';
import { openPopover, closePopover } from '../popover.js';
import { createRun } from '../run.js';

export const HEADING = "The model's top guesses for the next token";
export const HALLUCINATION_CAPTION = 'Notice the red tokens read just as smoothly as the green ones. That is what a hallucination looks like from the inside.';
export const COMPLETION_NOTE = 'This model just continues the text.';
export const IDLE_NOTE = 'Press "Run it" above and the model\'s guesses for the next token appear here.';
export const CONSIDERED_IDLE = 'Press "Keep going" to watch each step.';
export const CONTINUE_TOKENS = 120;
export const STEP_TOP = 5;
export const DEFAULT_TEMPERATURE = 0.7;

// ---- Pure helpers (tested in tests/predict_helpers.test.mjs) --------------------------------------------------------

/** The output text so far. */
export function joinTokens(tokens) {
  return tokens.map(t => t.text).join('');
}

/** Truncate at `index` and put the alternative there; it keeps that step's alternatives so it can be re-forked. */
export function forkAt(tokens, index, altText) {
  if (!Number.isInteger(index) || index < 0 || index >= tokens.length) throw new RangeError('forkAt: index out of range');
  return [...tokens.slice(0, index), { text: altText, logprob: null, top: tokens[index].top }];
}

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

/** The output line's status text. */
export function statusText(finish, streaming, paused) {
  if (streaming) return 'Writing…';
  if (paused) return 'Paused';
  if (finish === 'stop') return 'Finished (stop)';
  if (finish === 'length') return 'Cut off at the token limit';
  if (finish === 'truncated') return 'Connection dropped, partial output kept';
  if (finish) return `Finished (${finish})`;
  return '';
}

export function formatPercent(p) {
  if (!Number.isFinite(p) || p <= 0) return '0%';
  const pct = p * 100;
  if (pct < 0.1) return '<0.1%';
  return `${pct < 10 ? pct.toFixed(1) : Math.round(pct)}%`;
}

const rowOf = (text, p, other = false) => {
  const { leadingSpace, text: shown } = displayToken(text);
  return { text, label: other ? 'everything else' : (leadingSpace ? '␣' : '') + shown, p, percent: formatPercent(p), other };
};

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

/** Confidence band for an output token from its own logprob. */
export function tokenBand(token) {
  return band(typeof token.logprob === 'number' ? Math.exp(token.logprob) : null);
}

export function noProbsMessage(model) {
  return `${model.label} does not share its probabilities. You can still watch it write.`;
}

// ---- DOM ----------------------------------------------------------------------------------------------------------

/** A token's text as a label: visible space marker plus the display text. */
function labelSpan(text, cls) {
  const { leadingSpace, text: shown } = displayToken(text);
  return el('span', { class: cls }, leadingSpace ? el('span', { class: 'sp', 'aria-hidden': 'true', text: '␣' }) : null, shown);
}

function makeBar(text, { other = false } = {}) {
  const fill = el('span', { class: 'bar-fill', style: { width: '0%' } });
  const pct = el('span', { class: 'bar-pct', text: '0%' });
  const label = other ? el('span', { class: 'bar-label', text: 'everything else' }) : labelSpan(text, 'bar-label');
  const row = el('div', { class: `bar-row${other ? ' bar-other' : ''}` }, label, el('span', { class: 'bar-track', 'aria-hidden': 'true' }, fill), pct);
  return { row, fill, pct };
}

function paintBar(bar, p, percent, label, picked) {
  bar.fill.style.width = `${(p * 100).toFixed(2)}%`;
  bar.pct.textContent = percent;
  bar.row.classList.toggle('is-picked', picked);
  bar.row.setAttribute('aria-label', `${label}: ${percent}`);
}

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

  const outStatus = el('p', { class: 'status muted small', role: 'status' });
  const promptSpan = el('span', { class: 'out-prompt' });
  const arrow = el('span', { class: 'out-arrow', 'aria-hidden': 'true', text: '↳ ' });
  const chipsRoot = el('span', { class: 'out-chips', role: 'group', 'aria-label': 'Model output, one chip per token' });
  const outLine = el('div', { class: 'out-line' }, promptSpan, arrow, chipsRoot);
  const completionNote = el('p', { class: 'muted small', text: COMPLETION_NOTE, hidden: true });
  const outBlock = el('div', { class: 'out-block' }, outStatus, outLine, completionNote);
  const miniNote = el('p', { class: 'muted small', text: CONSIDERED_IDLE });
  const miniBars = el('div', { class: 'bars mini-bars', 'aria-label': 'Alternatives at the latest step' });
  const considered = el('aside', { class: 'considered' }, el('h4', { text: 'What it considered' }), miniNote, miniBars);
  const sideGrid = el('div', { class: 'side-panel' }, outBlock, considered);

  const confToggle = el('input', { type: 'checkbox', checked: true });
  const confLabel = el('label', { class: 'inline-label' }, confToggle, 'Color by confidence');
  const legendItem = (key, text) => el('li', {}, el('span', { class: `swatch swatch-${key}`, 'aria-hidden': 'true' }), text);
  const legend = el('ul', { class: 'conf-legend', 'aria-label': 'Confidence legend' },
    legendItem('high', 'green: 60% or more'), legendItem('mid', 'amber: 25–60%'), legendItem('low', 'red: under 25%'));
  const legendRow = el('div', { class: 'legend-row' }, confLabel, legend);
  const hallucination = el('p', { class: 'caption', text: HALLUCINATION_CAPTION });

  const idle = el('p', { class: 'placeholder', text: IDLE_NOTE });
  const stage = el('div', { class: 'predict', hidden: true },
    el('h3', { class: 'panel-title', text: HEADING }), status, noProbs, barsBox, barsCap, controls, errorSlot, sideGrid, legendRow, hallucination);
  viz.replaceChildren(idle, stage);

  // ---- State ------------------------------------------------------------------------------------------------------
  let ctx = null, model = null, prompt = '', system = '';
  let first = null;              // { top: [{text, logprob}], text }
  let tokens = [];               // [{ text, logprob, top }]
  let phase = 'idle';            // idle | loading | ready | streaming | paused | done | error
  let finish = null, armed = false, published = false;
  let temperature = DEFAULT_TEMPERATURE, sliderTouched = false;
  let pickedIndex = null, forkIndex = null;
  let controller = null, lastAction = null;
  let bars = [];
  const out = chipRow(chipsRoot);

  const hasProbs = () => Boolean(first?.top?.length);

  // ---- Rendering --------------------------------------------------------------------------------------------------
  const renderControls = () => {
    const streaming = phase === 'streaming';
    const tooLong = joinTokens(tokens).length > LIMITS.prefixChars;
    const why = model && !model.logprobs ? `${model.label} does not share its probabilities, so there is nothing to rescale or roll.` : '';
    slider.disabled = !hasProbs();
    tempLabel.title = why;
    rollBtn.disabled = !hasProbs() || streaming;
    rollBtn.title = why || 'Sample one token from the bars at this temperature';
    goBtn.textContent = phase === 'paused' ? 'Resume' : 'Keep going';
    goBtn.disabled = !armed || streaming || tooLong;
    goBtn.title = tooLong ? 'The continuation is as long as the server allows.' : (phase === 'paused' ? 'Ask for more from the current text' : 'Let the model write up to 120 more tokens');
    stepBtn.disabled = goBtn.disabled;
    pauseBtn.disabled = !streaming;
    confToggle.disabled = !model?.logprobs;
    confLabel.title = why;
    setStatus(outStatus, statusText(finish, streaming, phase === 'paused'));
  };

  const showError = (err) => {
    console.error('predict: request failed', err);
    notice(errorSlot, err?.message || 'Something went wrong. Try again.', { retry: () => lastAction?.() });
  };

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
    // Widths start at 0 and are set on the next frame so the CSS transition animates them in.
    const paint = () => renderBars(sliderTouched ? temperature : null);
    if (typeof requestAnimationFrame === 'function') requestAnimationFrame(paint); else paint();
  };

  const appendChip = (t, i) => {
    if (i === forkIndex) out.append('forked here', { className: 'fork-marker', title: 'You picked a different token here', attrs: { role: 'note' } });
    const forkable = Array.isArray(t.top) && t.top.length > 0;
    out.append(t.text, {
      className: `out-tok band-${tokenBand(t)}${forkable ? ' can-fork' : ''}`,
      title: forkable ? 'Click to see what else it considered' : undefined,
      dataset: { i },
      attrs: forkable ? { role: 'button', tabindex: 0, 'aria-haspopup': 'dialog', 'aria-expanded': 'false' } : {},
    });
  };

  const renderOutput = () => {
    out.reset();
    tokens.forEach(appendChip);
    out.flush();
  };

  const showConsidered = (top, chosen) => {
    if (!top) {
      miniBars.replaceChildren();
      setStatus(miniNote, 'This model does not share what else it considered.');
      return;
    }
    miniNote.hidden = true;
    const { items } = withProbs(top);
    miniBars.replaceChildren(...items.slice(0, STEP_TOP).map((x) => {
      const bar = makeBar(x.text);
      const p = Number.isFinite(x.p) ? x.p : 0;
      paintBar(bar, p, formatPercent(p), rowOf(x.text, p).label, x.text === chosen);
      return bar.row;
    }));
  };

  // ---- Requests ---------------------------------------------------------------------------------------------------
  /** One streamed call. Events and completion are ignored once this request is paused, superseded, or its run is gone. */
  const request = async (opts, { onToken, onDone, onError }) => {
    const myCtx = ctx;
    controller?.abort();
    const my = new AbortController();
    controller = my;
    const stale = () => my.signal.aborted || !myCtx.isCurrent();
    let done = null;
    try {
      done = await generate({ model: model.id, prompt, system, ...opts }, {
        signal: my.signal,
        onEvent: (ev) => { if (!stale() && ev.type === 'token') onToken(ev); },
      });
    } catch (err) {
      if (stale()) return;
      onError(err);
      return;
    }
    if (stale()) return;
    onDone(done);
  };

  const publish = (done) => {
    if (published || !done) return;
    published = true;
    store.setResult('predict', { runId: ctx.runId, usage: done.usage, cost: done.cost, model: model.id });
  };

  const fetchFirst = () => {
    lastAction = fetchFirst;
    phase = 'loading';
    armed = false;
    first = null;
    errorSlot.replaceChildren();
    setStatus(status, 'Asking the model for its guesses…');
    renderControls();
    request({ maxTokens: 1, topLogprobs: LIMITS.topLogprobs, temperature: 0, prefix: '' }, {
      onToken: (ev) => { first = { top: Array.isArray(ev.top) ? ev.top : [], text: ev.text }; },
      onDone: (done) => {
        setStatus(status, '');
        publish(done);
        armed = true;
        phase = 'ready';
        if (hasProbs()) buildBars();
        else showNoProbs(`${model.label} did not return any probabilities this time. You can still watch it write.`);
        renderControls();
      },
      onError: (err) => { setStatus(status, ''); phase = 'error'; showError(err); renderControls(); },
    });
  };

  const continueFrom = (maxTokens) => {
    lastAction = () => continueFrom(maxTokens);
    closePopover();
    const prefix = joinTokens(tokens);
    phase = 'streaming';
    finish = null;
    errorSlot.replaceChildren();
    renderControls();
    request({ maxTokens, topLogprobs: STEP_TOP, temperature, prefix }, {
      onToken: (ev) => {
        const t = { text: ev.text, logprob: typeof ev.logprob === 'number' ? ev.logprob : null, top: Array.isArray(ev.top) && ev.top.length ? ev.top : null };
        tokens.push(t);
        appendChip(t, tokens.length - 1);
        showConsidered(t.top, t.text);
      },
      onDone: (done) => {
        finish = done?.finish ?? 'truncated';
        phase = 'done';
        if (prefix === '') publish(done);
        renderControls();
      },
      onError: (err) => { phase = 'error'; showError(err); renderControls(); },
    });
  };

  const pause = () => {
    if (phase !== 'streaming') return;
    phase = 'paused';
    controller?.abort();
    controller = null;
    renderControls();
  };

  const restartDice = () => {
    die.classList.remove('dice');
    void die.offsetWidth; // restart the keyframes
    die.classList.add('dice');
  };

  const roll = () => {
    if (!hasProbs() || phase === 'streaming') return;
    const dist = rescale(first.top, temperature);
    const pick = sample(dist, Math.random);
    if (!pick) return;
    const i = dist.indexOf(pick);
    const raw = first.top[i];
    pickedIndex = i;
    forkIndex = null;
    finish = null;
    phase = 'ready';
    tokens = [{ text: raw.text, logprob: raw.logprob, top: first.top }];
    sliderTouched = true; // the bars now show the distribution the pick was drawn from
    renderBars(temperature);
    restartDice();
    renderOutput();
    showConsidered(first.top, raw.text);
    renderControls();
  };

  const fork = (index, altText) => {
    if (phase === 'streaming') { controller?.abort(); controller = null; }
    tokens = forkAt(tokens, index, altText);
    forkIndex = index;
    renderOutput();
    continueFrom(CONTINUE_TOKENS);
  };

  const openFork = (chip) => {
    const i = Number(chip.dataset.i);
    const tok = tokens[i];
    if (!tok?.top) return;
    const { items } = withProbs(tok.top);
    const list = el('div', { class: 'fork-list' },
      el('p', { class: 'small muted fork-title', text: 'At this step it also considered:' }),
      ...items.map((alt) => {
        const isCurrent = alt.text === tok.text;
        return el('button', { type: 'button', class: `fork-alt${isCurrent ? ' is-current' : ''}`, 'aria-current': isCurrent ? 'true' : undefined,
          title: isCurrent ? 'Write again from here' : 'Use this token instead and keep writing',
          onClick: () => { closePopover(); fork(i, alt.text); } },
        labelSpan(alt.text, 'fork-label'), el('span', { class: 'muted fork-pct', text: formatPercent(alt.p) }));
      }));
    openPopover(chip, list, { label: 'Other tokens it considered' });
  };

  // ---- Wiring -----------------------------------------------------------------------------------------------------
  slider.addEventListener('input', () => {
    temperature = Number(slider.value);
    tempOut.textContent = formatTemperature(temperature);
    sliderTouched = true;
    renderBars(temperature);
  });
  rollBtn.addEventListener('click', roll);
  goBtn.addEventListener('click', () => continueFrom(CONTINUE_TOKENS));
  stepBtn.addEventListener('click', () => continueFrom(1));
  pauseBtn.addEventListener('click', pause);
  confToggle.addEventListener('change', () => outLine.classList.toggle('confidence-off', !confToggle.checked));
  chipsRoot.addEventListener('click', (e) => {
    const chip = e.target.closest?.('.can-fork');
    if (chip && chipsRoot.contains(chip)) openFork(chip);
  });
  chipsRoot.addEventListener('keydown', (e) => {
    if (e.key !== 'Enter' && e.key !== ' ') return;
    const chip = e.target.closest?.('.can-fork');
    if (!chip) return;
    e.preventDefault();
    openFork(chip);
  });

  createRun(store, (runCtx) => {
    ctx = runCtx;
    model = getModel(runCtx.state.modelId);
    prompt = runCtx.state.prompt;
    system = runCtx.state.system || '';
    if (!model) return;
    // Reset everything from the previous run.
    first = null; tokens = []; phase = 'idle'; finish = null; armed = false; published = false;
    sliderTouched = false; pickedIndex = null; forkIndex = null; controller = null; bars = [];
    closePopover();
    idle.hidden = true;
    stage.hidden = false;
    promptSpan.textContent = prompt;
    outLine.classList.toggle('is-completion', model.endpoint === 'completion');
    completionNote.hidden = model.endpoint !== 'completion';
    out.reset();
    miniBars.replaceChildren();
    setStatus(miniNote, CONSIDERED_IDLE);
    errorSlot.replaceChildren();
    barsBox.replaceChildren();
    barsCap.textContent = '';
    runCtx.onDispose(() => { controller?.abort(); controller = null; closePopover(); });

    if (!model.logprobs) {
      showNoProbs(noProbsMessage(model));
      armed = true;
      phase = 'ready';
      renderControls();
      return;
    }
    fetchFirst();
  });
  renderControls();
}
