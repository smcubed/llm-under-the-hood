/**
 * A streaming output pane shared by chapters 4, 5 and 6: one line of token chips (tinted by confidence), a live status
 * line, an optional "What it considered" side panel of mini bars, an inline error notice with Retry, an optional footer
 * (time to first token and total, tokens, cost), pause/resume/stop, and a popover on chips that lists the alternatives the model considered
 * at that step (read-only, or forkable: pick one and keep writing from there).
 *
 *   const pane = createOutputPane(root, { getModel, getPrefixText, showConsidered, forkable, alternatives, footer, ... });
 *   pane.start(ctx, params)   ctx: a run.js ctx (or { signal, isCurrent }); params: generate() params incl. prefix
 *   pane.pause() / pane.resume() / pane.stop() / pane.reset() / pane.setTokens(list, { forkIndex }) / pane.setPrompt(text)
 *   pane.tokens, pane.phase ('idle'|'streaming'|'paused'|'done'|'error'), pane.finish, pane.stats, pane.el
 *
 * All rendering goes through el()/tokenChip(); no innerHTML. Pure helpers are tested in tests/pane.test.mjs.
 */
import { withProbs, band } from './probs.js';
import { el, chipRow, notice, setChildren, setStatus, setLiveStatus } from './dom.js';
import { openPopover, closePopover, closePopoverWithin, popoverAnchor } from './popover.js';
import { request } from './stream.js';
import { renderBars, formatPercent, tokenLabel } from './bars.js';
import { formatCost, formatTiming, formatTokens } from './format.js';

export const STEP_TOP = 5;
export const CONSIDERED_IDLE = 'Press "Keep going" to watch each step.';
export const NO_CONSIDERED = 'This model does not share what else it considered.';

// ---- Pure helpers -------------------------------------------------------------------------------------------------

/** The output text so far. */
export function joinTokens(tokens) {
  return tokens.map(t => t.text).join('');
}

/** Truncate at `index` and put the alternative there; it keeps that step's alternatives so it can be re-forked. */
export function forkAt(tokens, index, altText) {
  if (!Number.isInteger(index) || index < 0 || index >= tokens.length) throw new RangeError('forkAt: index out of range');
  return [...tokens.slice(0, index), { text: altText, logprob: null, top: tokens[index].top }];
}

/** Confidence band for an output token from its own logprob. */
export function tokenBand(token) {
  return band(typeof token?.logprob === 'number' ? Math.exp(token.logprob) : null);
}

/** The status line's text. */
export function statusText(finish, streaming, paused) {
  if (streaming) return 'Writing…';
  if (paused) return 'Paused';
  if (finish === 'stop') return 'Finished (stop)';
  if (finish === 'length') return 'Cut off at the token limit';
  if (finish === 'truncated') return 'Connection dropped, partial output kept';
  if (finish === 'stopped') return 'Stopped';
  if (finish) return `Finished (${finish})`;
  return '';
}

/** Normalize a token event into the pane's token shape. */
export function toToken(ev) {
  return { text: ev.text, logprob: typeof ev.logprob === 'number' ? ev.logprob : null, top: Array.isArray(ev.top) && ev.top.length ? ev.top : null };
}

// ---- The pane -----------------------------------------------------------------------------------------------------

/** Monotonic milliseconds for the footer timings (performance.now where it exists, as it does in browsers and Node). */
const now = () => (typeof performance !== 'undefined' && typeof performance.now === 'function' ? performance.now() : Date.now());

export function createOutputPane(root, {
  getModel = () => null,
  getPrefixText = (params) => params?.prompt ?? '',
  showConsidered = true,
  consideredIdle = CONSIDERED_IDLE,
  forkable = true,
  alternatives = forkable,
  confidence = true,
  footer = false,
  completionNote = null,
  onChange = () => {},
  onToken = () => {},
  onDone = () => {},
  onError = () => {},
  onFork = null,
} = {}) {
  // ---- DOM --------------------------------------------------------------------------------------------------------
  const status = el('p', { class: 'status muted small', role: 'status' });
  const promptSpan = el('span', { class: 'out-prompt' });
  const arrow = el('span', { class: 'out-arrow', 'aria-hidden': 'true', text: '↳ ' });
  const chipsRoot = el('span', { class: 'out-chips', role: 'group', 'aria-label': 'Model output, one chip per token' });
  const outLine = el('div', { class: `out-line${confidence ? '' : ' confidence-off'}` }, promptSpan, arrow, chipsRoot);
  const noteEl = completionNote ? el('p', { class: 'muted small completion-note', text: completionNote, hidden: true }) : null;
  const outBlock = el('div', { class: 'out-block' }, status, outLine, noteEl);
  const miniNote = el('p', { class: 'muted small', text: consideredIdle });
  const miniBars = el('div', { class: 'bars mini-bars', 'aria-label': 'Alternatives at the latest step' });
  const considered = showConsidered ? el('aside', { class: 'considered' }, el('h4', { text: 'What it considered' }), miniNote, miniBars) : null;
  const body = showConsidered ? el('div', { class: 'side-panel' }, outBlock, considered) : outBlock;
  const errorSlot = el('div', { class: 'error-slot' });
  const footLatency = el('span', { class: 'foot-item foot-latency' });
  const footTokens = el('span', { class: 'foot-item foot-tokens' });
  const footCost = el('span', { class: 'foot-item foot-cost' });
  const foot = footer ? el('p', { class: 'pane-foot muted small', hidden: true }, footLatency, footTokens, footCost) : null;
  setChildren(root, body, errorSlot, foot);
  root.classList.add('out-pane');
  const out = chipRow(chipsRoot);

  // ---- State ------------------------------------------------------------------------------------------------------
  let tokens = [];
  let phase = 'idle', finish = null, forkIndex = null;
  let current = null, lastCtx = null, lastParams = null, startedAt = 0, firstTokenAt = null;
  const EMPTY_STATS = Object.freeze({ latencyMs: null, firstTokenMs: null, usage: null, cost: null });
  let stats = EMPTY_STATS;
  let hoverChip = null;   // the chip whose popover was opened by hovering (closes on mouseout); click-opened ones are "pinned"

  const changed = () => {
    out.flush(); // any chips still batched for the next frame land before the status changes
    setLiveStatus(status, statusText(finish, phase === 'streaming', phase === 'paused'));
    onChange(api);
  };

  // ---- Rendering --------------------------------------------------------------------------------------------------
  const appendChip = (t, i) => {
    if (i === forkIndex) out.insert(el('span', { class: 'fork-marker', role: 'note', text: 'forked here' }));
    const hasAlts = Array.isArray(t.top) && t.top.length > 0 && (forkable || alternatives);
    out.append(t.text, {
      className: `out-tok band-${tokenBand(t)}${hasAlts ? (forkable ? ' can-fork' : ' has-alts') : ''}`,
      title: hasAlts ? 'Click to see what else it considered' : undefined,
      dataset: { i },
      attrs: hasAlts ? { role: 'button', tabindex: 0, 'aria-haspopup': 'dialog', 'aria-expanded': 'false' } : {},
    });
  };
  const renderOutput = () => {
    out.reset();
    tokens.forEach(appendChip);
    out.flush();
  };
  const paintConsidered = (top, chosen) => {
    if (!showConsidered) return;
    if (!top) { miniBars.replaceChildren(); setStatus(miniNote, NO_CONSIDERED); return; }
    miniNote.hidden = true;
    const rows = withProbs(top).items.map(x => ({ text: x.text, p: Number.isFinite(x.p) ? x.p : 0 }));
    renderBars(miniBars, rows, { picked: chosen, limit: STEP_TOP });
  };
  const resetConsidered = () => {
    if (!showConsidered) return;
    miniBars.replaceChildren();
    setStatus(miniNote, consideredIdle);
  };
  const paintFooter = () => {
    if (!foot) return;
    const has = stats.latencyMs !== null || stats.usage || stats.cost !== null;
    foot.hidden = !has;
    footLatency.textContent = formatTiming(stats);
    footTokens.textContent = formatTokens(stats.usage);
    footCost.textContent = formatCost(stats.cost);
  };
  const syncPromptLayout = () => {
    const model = getModel();
    outLine.classList.toggle('is-completion', model?.endpoint === 'completion');
    outLine.classList.toggle('no-prompt', !promptSpan.textContent);
    if (noteEl) noteEl.hidden = model?.endpoint !== 'completion';
  };

  // ---- Alternatives popover ---------------------------------------------------------------------------------------
  const fork = (i, altText) => {
    closePopover();
    if (i >= tokens.length) return;
    if (onFork) { onFork(i, altText); return; }
    current?.abort(); current = null;
    api.setTokens(forkAt(tokens, i, altText), { forkIndex: i });
    if (lastCtx && lastParams) api.start(lastCtx, { ...lastParams, prefix: joinTokens(tokens) });
  };
  const openAlternatives = (chip, { hover = false } = {}) => {
    const i = Number(chip.dataset.i);
    const tok = tokens[i];
    if (!tok?.top) return;
    const { items } = withProbs(tok.top);
    const rows = items.map((alt) => {
      const isCurrent = alt.text === tok.text;
      const label = [tokenLabel(alt.text, 'fork-label'), el('span', { class: 'muted fork-pct', text: formatPercent(alt.p) })];
      if (!forkable) return el('div', { class: `fork-alt is-readonly${isCurrent ? ' is-current' : ''}`, 'aria-current': isCurrent ? 'true' : undefined }, ...label);
      return el('button', { type: 'button', class: `fork-alt${isCurrent ? ' is-current' : ''}`, 'aria-current': isCurrent ? 'true' : undefined,
        title: isCurrent ? 'Write again from here' : 'Use this token instead and keep writing',
        onClick: () => fork(i, alt.text) }, ...label);
    });
    const list = el('div', { class: 'fork-list' }, el('p', { class: 'small muted fork-title', text: 'At this step it also considered:' }), ...rows);
    openPopover(chip, list, { label: 'Other tokens it considered', focus: !hover });
    hoverChip = hover ? chip : null;
  };
  const chipOf = (e) => { const chip = e.target.closest?.('.can-fork, .has-alts'); return chip && chipsRoot.contains(chip) ? chip : null; };
  chipsRoot.addEventListener('click', (e) => { const chip = chipOf(e); if (chip) openAlternatives(chip); });
  chipsRoot.addEventListener('keydown', (e) => {
    if (e.key !== 'Enter' && e.key !== ' ') return;
    const chip = chipOf(e);
    if (!chip) return;
    e.preventDefault();
    openAlternatives(chip);
  });
  if (alternatives && !forkable) {
    // Read-only alternatives also show on hover, without taking focus; a hover-opened popover goes away when the
    // pointer leaves the chip. A pinned (click/keyboard-opened) popover, in this pane or another, is left alone until
    // the student dismisses it: a hover popover only lives while the pointer is on its chip, so any popover that is
    // still open when the pointer reaches a different chip must be a pinned one.
    chipsRoot.addEventListener('mouseover', (e) => {
      const chip = chipOf(e);
      if (!chip || popoverAnchor() !== null) return;
      openAlternatives(chip, { hover: true });
    });
    chipsRoot.addEventListener('mouseout', (e) => {
      const chip = chipOf(e);
      if (!chip || chip !== hoverChip || (e.relatedTarget && chip.contains(e.relatedTarget))) return; // moving onto the chip's own space marker is not leaving
      hoverChip = null;
      if (popoverAnchor() === chip) closePopover({ restoreFocus: false });
    });
  }

  // ---- API --------------------------------------------------------------------------------------------------------
  const api = {
    get el() { return root; },
    get tokens() { return tokens; },
    get phase() { return phase; },
    get finish() { return finish; },
    get stats() { return { ...stats }; },
    get text() { return joinTokens(tokens); },

    /** Stream one request; tokens are appended to whatever is already in the pane (reset() first for a fresh start). */
    start(ctx, params) {
      current?.abort();
      closePopoverWithin(root);
      lastCtx = ctx; lastParams = params;
      phase = 'streaming'; finish = null;
      errorSlot.replaceChildren();
      stats = EMPTY_STATS;
      paintFooter();
      promptSpan.textContent = getPrefixText(params) ?? '';
      syncPromptLayout();
      startedAt = now(); firstTokenAt = null;
      const my = request(ctx, params, {
        onToken: (ev) => {
          if (firstTokenAt === null) firstTokenAt = now();
          const t = toToken(ev);
          tokens.push(t);
          appendChip(t, tokens.length - 1);
          paintConsidered(t.top, t.text);
          onToken(t, tokens.length - 1);
        },
        onDone: (done) => {
          if (current === my) current = null;
          finish = done?.finish ?? 'truncated';
          phase = 'done';
          stats = { latencyMs: now() - startedAt, firstTokenMs: firstTokenAt === null ? null : firstTokenAt - startedAt, usage: done?.usage ?? null, cost: typeof done?.cost === 'number' ? done.cost : null };
          paintFooter();
          onDone(done, params);
          changed();
        },
        onError: (message, fromStream, err) => {
          if (current === my) current = null;
          console.error('pane: request failed', err);
          phase = 'error';
          notice(errorSlot, message, { retry: () => api.resume() });
          onError(message, fromStream);
          changed();
        },
      });
      current = my;
      changed();
    },
    /** Abort the stream and keep the tokens; resume() asks for more from the current text. */
    pause() {
      if (phase !== 'streaming') return;
      current?.abort(); current = null;
      phase = 'paused';
      changed();
    },
    resume() {
      if (!lastCtx || !lastParams || phase === 'streaming') return;
      api.start(lastCtx, { ...lastParams, prefix: joinTokens(tokens) });
    },
    /** Abort and mark the pane finished ("Stopped"). */
    stop() {
      if (phase !== 'streaming') return;
      current?.abort(); current = null;
      phase = 'done'; finish = 'stopped';
      changed();
    },
    /** Back to an empty pane. Also closes any popover anchored in it. */
    reset() {
      current?.abort(); current = null;
      closePopoverWithin(root);
      tokens = []; phase = 'idle'; finish = null; forkIndex = null; lastCtx = null; lastParams = null;
      stats = EMPTY_STATS;
      out.reset();
      resetConsidered();
      errorSlot.replaceChildren();
      paintFooter();
      syncPromptLayout();
      changed();
    },
    /** Replace the tokens (roll, fork) without a request; the pane returns to idle. */
    setTokens(list, { forkIndex: fi = null } = {}) {
      closePopoverWithin(root);
      tokens = [...list]; forkIndex = fi;
      phase = 'idle'; finish = null;
      renderOutput();
      const last = tokens.at(-1);
      if (last) paintConsidered(last.top, last.text); else resetConsidered();
      changed();
    },
    setPrompt(text) {
      promptSpan.textContent = text ?? '';
      syncPromptLayout();
    },
    setConfidence(on) {
      outLine.classList.toggle('confidence-off', !on);
    },
    clearNotice() {
      errorSlot.replaceChildren();
    },
  };
  syncPromptLayout();
  return api;
}
