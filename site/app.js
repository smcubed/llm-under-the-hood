import { DEFAULT_MODEL, LIMITS, getModel } from './models.js';
import { buildModelSelect } from './model-select.js';
import { createStore } from './store.js';
import { checkSession, login } from './api.js';
import { prefersReducedMotion } from './dom.js';

const CHAPTERS = ['tokens', 'numbers', 'attention', 'predict', 'assistant', 'compare'];
const $ = (sel, root = document) => root.querySelector(sel);

export const store = createStore({ prompt: '', modelId: DEFAULT_MODEL, system: '', runId: 0, results: {} });

const scrollToId = (id) => document.getElementById(id)?.scrollIntoView({ behavior: prefersReducedMotion() ? 'auto' : 'smooth', block: 'start' });

function showGate() {
  $('#gate').hidden = false;
  $('#main').hidden = true;
  $('#strip').hidden = true;
  $('#footer').hidden = false;
  $('#passcode').focus();
}
let chaptersMounted = false;
let sessionReady = false;   // Run stays disabled until the session check has settled and the page is shown
let syncRun = () => {};
/** Reveal the page and mount the chapters exactly once, only now that their sections have layout. */
function showMain() {
  $('#gate').hidden = true;
  $('#main').hidden = false;
  $('#strip').hidden = false;
  $('#footer').hidden = false;
  sessionReady = true;
  syncRun();
  if (!chaptersMounted) { chaptersMounted = true; mountChapters(); }
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
      if (r.ok) { input.value = ''; showMain(); $('#prompt')?.focus(); return; }
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
  for (const n of document.querySelectorAll('.prompt-limit')) n.textContent = String(LIMITS.promptChars);
  const sync = () => {
    const value = textarea.value;
    counter.textContent = `${value.length} / ${LIMITS.promptChars}`;
    run.disabled = !sessionReady || value.trim().length === 0;
    store.set({ prompt: value });
  };
  syncRun = sync;
  textarea.addEventListener('input', sync);
  for (const chip of document.querySelectorAll('.starter')) {
    chip.addEventListener('click', () => { textarea.value = chip.textContent.trim(); sync(); textarea.focus(); });
  }
  buildModelSelect(select, { selected: DEFAULT_MODEL });
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
  const nav = $('#strip nav');
  // Scroll the strip itself (never the page) so the active button is in view, and only when it is not already.
  const revealButton = (b) => {
    if (!b || !nav) return;
    const left = b.offsetLeft, right = left + b.offsetWidth;
    const viewLeft = nav.scrollLeft, viewRight = viewLeft + nav.clientWidth;
    if (left < viewLeft) nav.scrollTo({ left: Math.max(0, left - 12), behavior: 'auto' });
    else if (right > viewRight) nav.scrollTo({ left: right - nav.clientWidth + 12, behavior: 'auto' });
  };
  const setActive = (id) => {
    for (const [target, b] of byId) {
      if (target === id) b.setAttribute('aria-current', 'true'); else b.removeAttribute('aria-current');
    }
    revealButton(byId.get(id));
  };
  if (!('IntersectionObserver' in window)) return;
  // The active chapter is the one crossing a band just under the strip; ties go to the section further down.
  const visible = new Map();
  const io = new IntersectionObserver((entries) => {
    for (const e of entries) visible.set(e.target.id, e.isIntersecting);
    let best = null;
    for (const id of byId.keys()) if (visible.get(id)) best = id;
    if (best) setActive(best); else if (window.scrollY < 200) setActive(null);
  }, { rootMargin: '-45% 0px -45% 0px', threshold: [0, 0.01] });
  for (const id of byId.keys()) { const el = document.getElementById(id); if (el) io.observe(el); }
}

async function mountChapters() {
  await Promise.all(CHAPTERS.map(async (name) => {
    const root = document.getElementById(`ch-${name}`);
    if (!root) return;
    try {
      const mod = await import(`./chapters/${name}.js`);
      mod.mount?.(root, store);
    } catch (err) {
      // The section keeps its placeholder markup; the failure is loud in the console.
      console.error(`chapter ${name}: not mounted`, err);
    }
  }));
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
  let ok = false;
  try { ok = await checkSession(); } catch { ok = false; }
  if (ok) showMain(); else showGate();
}

if (typeof document !== 'undefined') {
  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', boot); else boot();
}
