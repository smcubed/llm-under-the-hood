import { MODELS, DEFAULT_MODEL, LIMITS, getModel } from './models.js';
import { createStore } from './store.js';
import { checkSession, login } from './api.js';

const CHAPTERS = ['tokens', 'numbers', 'attention', 'predict', 'assistant', 'compare'];
const $ = (sel, root = document) => root.querySelector(sel);

export const store = createStore({ prompt: '', modelId: DEFAULT_MODEL, system: '', runId: 0, results: {} });

const prefersReducedMotion = () => window.matchMedia?.('(prefers-reduced-motion: reduce)').matches;
const scrollToId = (id) => document.getElementById(id)?.scrollIntoView({ behavior: prefersReducedMotion() ? 'auto' : 'smooth', block: 'start' });

/** Era label for the model picker's optgroups. Open-weights models get their own group regardless of year. */
export function eraGroup(model) {
  if (model.open) return 'Open weights';
  if (model.year <= 2023) return 'Early (2022–2023)';
  if (model.year === 2024) return 'Recent (2024)';
  return 'Current (2025–2026)';
}

function buildModelSelect(select) {
  const groups = new Map();
  for (const m of MODELS) {
    if (!groups.has(eraGroup(m))) groups.set(eraGroup(m), []);
    groups.get(eraGroup(m)).push(m);
  }
  select.replaceChildren();
  for (const [label, models] of groups) {
    const og = document.createElement('optgroup');
    og.label = label;
    for (const m of models) {
      const opt = document.createElement('option');
      opt.value = m.id;
      opt.textContent = m.label + (m.logprobs ? '' : ' · no probabilities');
      og.append(opt);
    }
    select.append(og);
  }
  select.value = DEFAULT_MODEL;
}

function showGate() {
  $('#gate').hidden = false;
  $('#main').hidden = true;
  $('#strip').hidden = true;
  $('#footer').hidden = false;
  $('#passcode').focus();
}
function showMain() {
  $('#gate').hidden = true;
  $('#main').hidden = false;
  $('#strip').hidden = false;
  $('#footer').hidden = false;
}

function wireGate() {
  const form = $('#gate-form'), input = $('#passcode'), error = $('#gate-error'), submit = $('#gate-submit');
  form.addEventListener('submit', async (e) => {
    e.preventDefault();
    error.hidden = true;
    const passcode = input.value.trim();
    if (!passcode) { error.textContent = 'Please type the passcode.'; error.hidden = false; return; }
    submit.disabled = true;
    try {
      const r = await login(passcode);
      if (r.ok) { input.value = ''; showMain(); return; }
      error.textContent = r.message; error.hidden = false; input.select();
    } catch {
      error.textContent = 'Could not reach the server. Check your connection and try again.'; error.hidden = false;
    } finally {
      submit.disabled = false;
    }
  });
}

function wirePrompt() {
  const textarea = $('#prompt'), counter = $('#counter'), run = $('#run'), select = $('#model'), blurb = $('#model-blurb'), form = $('#prompt-form');
  textarea.maxLength = LIMITS.promptChars;
  const sync = () => {
    const value = textarea.value;
    counter.textContent = `${value.length} / ${LIMITS.promptChars}`;
    run.disabled = value.trim().length === 0;
    store.set({ prompt: value });
  };
  textarea.addEventListener('input', sync);
  for (const chip of document.querySelectorAll('.starter')) {
    chip.addEventListener('click', () => { textarea.value = chip.textContent.trim(); sync(); textarea.focus(); });
  }
  buildModelSelect(select);
  const syncModel = () => {
    store.set({ modelId: select.value });
    blurb.textContent = getModel(select.value)?.blurb || '';
  };
  select.addEventListener('change', syncModel);
  syncModel();
  form.addEventListener('submit', (e) => {
    e.preventDefault();
    if (run.disabled) return;
    store.set({ runId: Date.now() });
  });
  sync();
}

function wireStrip() {
  const buttons = [...document.querySelectorAll('.strip-btn')];
  const byId = new Map(buttons.map(b => [b.dataset.target, b]));
  for (const b of buttons) b.addEventListener('click', () => scrollToId(b.dataset.target));
  const setActive = (id) => {
    for (const [target, b] of byId) {
      if (target === id) b.setAttribute('aria-current', 'true'); else b.removeAttribute('aria-current');
    }
    byId.get(id)?.scrollIntoView?.({ block: 'nearest', inline: 'nearest', behavior: 'auto' });
  };
  if (!('IntersectionObserver' in window)) return;
  // The active chapter is the one crossing a band just under the strip; ties go to the section further down.
  const visible = new Map();
  const io = new IntersectionObserver((entries) => {
    for (const e of entries) visible.set(e.target.id, e.isIntersecting ? e.intersectionRatio : 0);
    let best = null;
    for (const id of byId.keys()) if ((visible.get(id) || 0) > 0) best = id;
    if (best) setActive(best); else if (window.scrollY < 200) setActive(null);
  }, { rootMargin: '-45% 0px -45% 0px', threshold: [0, 0.01] });
  for (const id of byId.keys()) { const el = document.getElementById(id); if (el) io.observe(el); }
}

async function mountChapters() {
  for (const name of CHAPTERS) {
    const root = document.getElementById(`ch-${name}`);
    if (!root) continue;
    try {
      const mod = await import(`./chapters/${name}.js`);
      mod.mount?.(root, store);
    } catch (err) {
      // A chapter that does not exist yet just keeps its placeholder markup.
      console.info(`chapter ${name}: not mounted`, err?.message || err);
    }
  }
}

function wireRunScroll() {
  store.subscribe((state, keys) => {
    if (keys.includes('runId') && state.runId) scrollToId('ch-tokens');
  });
}

async function boot() {
  wireGate();
  wirePrompt();
  wireStrip();
  wireRunScroll();
  mountChapters();
  let ok = false;
  try { ok = await checkSession(); } catch { ok = false; }
  if (ok) showMain(); else showGate();
}

if (typeof document !== 'undefined') {
  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', boot); else boot();
}
