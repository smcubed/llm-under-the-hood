// Pre-class model check: is every model in site/models.js still served by OpenRouter, at the price the site assumes,
// with probabilities where the site promises them? Run it before sending the site to students.
//
//   npm run check:models                     catalog check: free, no key, no passcode (the default)
//   npm run check:models -- --live           also send a few tiny real requests per model through the site
//   npm run check:models -- --suggest        list cheap OpenRouter models that share probabilities, oldest first
//
// Options:
//   --models <path>      models.js to check (default: site/models.js in this repo)
//   --catalog <file>     use a saved copy of https://openrouter.ai/api/v1/models instead of downloading it. Each model's
//                        provider list is still fetched live, so this is not an offline mode.
//   --site <url>         site for --live (default: LLUTH_SITE or the workers.dev URL below; http://localhost:8787 for
//                        a local `npm run dev`)
//   --dry-run            with --live: show the plan and the cost estimate without contacting the site
//   --max-price <usd>    with --suggest: highest output price per million tokens to list (default 5)
//   --strict             treat warnings as failures (exit 1)
//   --json               catalog results as JSON instead of the table (not with --live)
//
// Exit codes: 0 = ready (warnings are allowed), 1 = at least one problem to fix, 2 = could not run the check.
// --live reads the class passcode from LLUTH_PASSCODE, or asks for it with hidden typing. It never stores it.
import path from 'node:path';
import { readFile, access } from 'node:fs/promises';
import { pathToFileURL, fileURLToPath } from 'node:url';

const OPENROUTER = 'https://openrouter.ai/api/v1';
const DEFAULT_SITE = 'https://llm-under-the-hood.smcgrath.workers.dev';
const PRICE_DRIFT = 0.10;            // warn when OpenRouter's price differs from models.js by more than 10%
const EXPIRY_WARN_DAYS = 30;         // warn when OpenRouter lists a retirement date within this many days
const LOW_UPTIME = 90;               // a provider below this 1-day uptime (%) counts as unhealthy
const FETCH_TIMEOUT_MS = 20_000;
const LIVE_TIMEOUT_MS = 60_000;
const LIVE_PROMPT = 'The patient presented with';
const LIVE_MAX_TOKENS = 5;
const LIVE_MAX_TOKENS_REASONING = 16; // reasoning models spend a few tokens thinking even at minimal effort
const LIVE_TOP_LOGPROBS = 5;
const LIVE_LOGPROB_TRIES = 3;        // OpenRouter picks a provider per request, so one reply with probabilities can be luck
const LIVE_PAUSE_MS = 500;           // sequential + a short pause keeps one run far under PER_CLIENT_PER_MINUTE (30)
const LIVE_PROMPT_TOKENS_EST = 20;   // prompt plus chat-format overhead, for the cost estimate
const LIVE_FRAME_TOKENS_EST = 200;   // the Worker's AUTOCOMPLETE_FRAME and examples, sent with every simulated-autocomplete request
const CHAPTER = { predict: 'chapter 4 (next-word probabilities)', assistant: 'chapter 5 (autocomplete vs assistant)', compare: 'chapter 6 (compare the eras)' };
const REQUIRE_PARAMS_SNIPPET = 'upstream: LOGPROB_PROVIDERS_ONLY,';

// ---- Small helpers ------------------------------------------------------------------------------------------------

const perMillion = (perToken) => { const n = Number(perToken); return Number.isFinite(n) ? n * 1e6 : null; };
const pad = (s, n) => { s = String(s); return s.length > n ? s.slice(0, n - 1) + '…' : s.padEnd(n); };
const sleep = (ms) => new Promise(r => setTimeout(r, ms));
const daysUntil = (iso, now) => Math.floor((Date.parse(iso) - now) / 86_400_000);
const supports = (ep, param) => Array.isArray(ep.supported_parameters) && ep.supported_parameters.includes(param);
const supportsLogprobs = (ep) => supports(ep, 'logprobs') && supports(ep, 'top_logprobs');
const epPrice = (ep) => ({ in: perMillion(ep.pricing?.prompt), out: perMillion(ep.pricing?.completion) });
const byPrice = (a, b) => (epPrice(a).in + epPrice(a).out) - (epPrice(b).in + epPrice(b).out);
const isReasoning = (m) => Boolean(m.upstream?.extra?.reasoning);
const requiresParams = (m) => m.upstream?.extra?.provider?.require_parameters === true;
const plural = (n, word) => `${n} ${word}${n === 1 ? '' : 's'}`;

/** Fractional difference of OpenRouter's price from the site's: +0.5 means OpenRouter charges 50% more. */
export const drift = (site, actual) => (site > 0 && actual != null ? (actual - site) / site : actual > 0 ? Infinity : 0);

/** Per-million price for a table cell: 30, 2.50, 0.15, 0.125, 0.024. */
export const money = (n) => (n == null ? '?' : n >= 10 ? n.toFixed(0) : n.toFixed(3).replace(/(\.\d\d)0$/, '$1'));

/** A small dollar amount rounded to one significant figure: $0.05, $0.001, $0.0004. */
export function roughUsd(n) {
  if (n == null || !Number.isFinite(n)) return '?';
  if (n === 0) return '$0';
  if (n >= 0.01) return `$${n.toFixed(2)}`;
  const r = Number(n.toPrecision(1));
  return `$${r.toFixed(Math.max(0, -Math.floor(Math.log10(r))))}`;
}

/** A dollar amount the way a person reads it: 'about $0.001, a tenth of a cent'. */
export function plainUsd(n) {
  if (n == null || !Number.isFinite(n)) return 'an unknown amount';
  if (n === 0) return 'nothing';
  if (n >= 1) return `about $${n.toFixed(2)}`;
  const r = Number(n.toPrecision(1));
  if (r >= 0.01) { const c = Math.round(n * 100); return `about ${roughUsd(n)}, ${c === 1 ? 'one cent' : `${c} cents`}`; }
  const part = (k, unit) => `${k === 1 ? 'a' : k} ${unit}${k === 1 ? '' : 's'} of a cent`;
  if (r >= 0.001) return `about ${roughUsd(r)}, ${part(Math.round(r * 1000), 'tenth')}`;
  if (r >= 0.0001) return `about ${roughUsd(r)}, ${part(Math.round(r * 10000), 'hundredth')}`;
  return `about ${roughUsd(r)}, a tiny fraction of a cent`;
}

const useColor = process.stdout.isTTY && !process.env.NO_COLOR;
const paint = (code) => (s) => (useColor ? `\x1b[${code}m${s}\x1b[0m` : s);
const red = paint('31'), yellow = paint('33'), green = paint('32'), dim = paint('2'), bold = paint('1');
const LEVEL_COLOR = { FAIL: red, WARN: yellow, OK: green, SKIP: dim, NOTE: dim };

async function getJson(url) {
  let lastErr;
  for (let attempt = 0; attempt < 2; attempt++) {
    try {
      const r = await fetch(url, { headers: { accept: 'application/json' }, signal: AbortSignal.timeout(FETCH_TIMEOUT_MS) });
      if (r.status === 404) return { status: 404, json: null };
      if (!r.ok) throw new Error(`HTTP ${r.status}`);
      return { status: r.status, json: await r.json() };
    } catch (err) { lastErr = err; await sleep(1000); }
  }
  throw new Error(`could not fetch ${url}: ${lastErr?.message || lastErr}`);
}

export function parseArgs(argv) {
  const a = { live: false, dryRun: false, suggest: false, strict: false, json: false, models: null, catalog: null, site: null, maxPrice: 5 };
  for (let i = 0; i < argv.length; i++) {
    const k = argv[i];
    const val = () => { const v = argv[++i]; if (v == null) throw new Error(`${k} needs a value`); return v; };
    if (k === '--live') a.live = true;
    else if (k === '--dry-run') a.dryRun = true;
    else if (k === '--suggest') a.suggest = true;
    else if (k === '--strict') a.strict = true;
    else if (k === '--json') a.json = true;
    else if (k === '--models') a.models = val();
    else if (k === '--catalog') a.catalog = val();
    else if (k === '--site') a.site = val();
    else if (k === '--max-price') a.maxPrice = Number(val());
    else if (k === '-h' || k === '--help') a.help = true;
    else throw new Error(`unknown option ${k} (try --help)`);
  }
  if (!(a.maxPrice > 0)) throw new Error('--max-price needs a number above 0, for example --max-price 2');
  if (a.json && a.live) throw new Error('--json works with the catalog check only; run --live without it');
  if (a.dryRun && !a.live) throw new Error('--dry-run only applies to --live (try --live --dry-run)');
  return a;
}

async function loadSite(modelsPath) {
  const file = modelsPath ? path.resolve(modelsPath) : fileURLToPath(new URL('../site/models.js', import.meta.url));
  try { await access(file); }
  catch { throw new Error(`could not find ${file}. Run this from the repo (npm run check:models) or pass --models path/to/site/models.js.`); }
  const url = pathToFileURL(file);
  const mod = await import(url.href);
  if (!Array.isArray(mod.MODELS)) throw new Error(`${file} does not export MODELS`);
  return { file, url, ...mod };
}

// ---- Catalog check (pure: tested with fixtures) ---------------------------------------------------------------------

/** The OpenRouter parameters the Worker sends for `model` (buildUpstream, then upstream.omit / upstream.extra). With
 *  require_parameters, a provider must list every one of these or OpenRouter will not route to it. `provider` is
 *  routing config for OpenRouter itself, not a parameter. */
export function sentParams(model) {
  const omit = model.upstream?.omit || [];
  const extra = Object.keys(model.upstream?.extra || {}).filter(k => k !== 'provider');
  return ['max_tokens', 'temperature', ...(model.logprobs ? ['logprobs', 'top_logprobs'] : []), ...extra].filter(p => !omit.includes(p));
}

/** Providers OpenRouter can route this model to today, cheapest first: status 0, and with require_parameters only
 *  those that list every parameter in sentParams(model). */
export function routableProviders(model, endpoints) {
  const need = requiresParams(model) ? sentParams(model) : [];
  return (Array.isArray(endpoints) ? endpoints : []).filter(ep => (ep.status ?? 0) === 0 && need.every(p => supports(ep, p))).sort(byPrice);
}

/**
 * Findings for one models.js entry. `catalogEntry` is its row from /models (or undefined when absent); `endpoints` is
 * the `data.endpoints` array from /models/<id>/endpoints (or null when that returned 404). `roles` lists what the site
 * uses the model for ('autocomplete', 'default'). → { id, label, level, available, providers, healthy, sitePrice,
 * orPrice, priceBasis, probs, findings: [{ level: 'FAIL'|'WARN'|'NOTE', text }] }
 */
export function checkModel(model, catalogEntry, endpoints, { roles = [], now = Date.now() } = {}) {
  const findings = [];
  const add = (level, text) => findings.push({ level, text });
  const eps = Array.isArray(endpoints) ? endpoints : [];
  const healthy = eps.filter(ep => (ep.status ?? 0) === 0 && (ep.uptime_last_1d == null || ep.uptime_last_1d >= LOW_UPTIME));
  const lpEps = eps.filter(supportsLogprobs);
  const out = { id: model.id, label: model.label, year: model.year, available: true, providers: eps.length, healthy: healthy.length, sitePrice: model.price, orPrice: null, priceBasis: 'headline', probs: '-', findings };

  const roleText = [
    roles.includes('autocomplete') && `It is AUTOCOMPLETE_MODEL, so the left pane of ${CHAPTER.assistant} will show an error for every student.`,
    roles.includes('default') && 'It is DEFAULT_MODEL, the model every chapter starts on.',
  ].filter(Boolean).join(' ');

  // 1. Is it still served at all? Retired models stay in /endpoints with an empty list, or vanish (404) entirely.
  if (!catalogEntry || eps.length === 0) {
    const why = !catalogEntry && endpoints == null ? 'OpenRouter does not know this model id any more.'
      : !catalogEntry ? 'OpenRouter has dropped it from its model list and no provider serves it.'
      : 'It is still listed, but no provider currently serves it.';
    add('FAIL', `Not available on OpenRouter. ${why} Students choosing it will get an error.${roleText ? ' ' + roleText : ''}`);
    out.available = false;
    return finish(out);
  }

  // 2. Retirement date.
  if (catalogEntry.expiration_date) {
    const d = daysUntil(catalogEntry.expiration_date, now);
    if (d < 0) add('FAIL', `OpenRouter's retirement date (${catalogEntry.expiration_date}) has passed.`);
    else if (d <= EXPIRY_WARN_DAYS) add('WARN', `OpenRouter will retire it on ${catalogEntry.expiration_date} (in ${plural(d, 'day')}). Plan a replacement.`);
    else add('NOTE', `OpenRouter lists a retirement date: ${catalogEntry.expiration_date}.`);
  }

  // 3. Provider health and redundancy.
  if (healthy.length === 0) add('FAIL', `All ${eps.length} provider(s) are reporting problems right now (status or uptime under ${LOW_UPTIME}%). Re-run closer to class.`);
  else if (eps.length === 1) add('WARN', `Only one provider (${eps[0].provider_name}) serves it, so there is no fallback if that provider has an outage during class.`);
  else if (healthy.length < eps.length) add('NOTE', `${eps.length - healthy.length} of ${eps.length} providers are reporting problems; OpenRouter routes around them.`);

  // 4. Which providers can actually take the request, and so which price applies. With require_parameters, OpenRouter
  //    only routes to providers that list every parameter the Worker sends, so the headline price (often a provider
  //    that drops logprobs) is not what the class pays.
  let basis = { in: perMillion(catalogEntry.pricing?.prompt), out: perMillion(catalogEntry.pricing?.completion) };
  if (requiresParams(model)) {
    const need = sentParams(model);
    const routable = routableProviders(model, eps);
    out.probs = model.logprobs ? `yes, ${routable.length} of ${plural(eps.length, 'provider')}` : 'not offered';
    if (routable.length === 0) {
      add('FAIL', `models.js routes it with require_parameters, so OpenRouter only uses providers that accept all of: ${need.join(', ')}. None of the ${eps.length} working providers does, so every request will fail. ${model.logprobs ? 'Set logprobs: false and remove the upstream line, or replace the model.' : 'Remove the upstream line or replace the model.'}${roleText ? ' ' + roleText : ''}`);
      out.probs = model.logprobs ? 'no provider qualifies' : out.probs;
      return finish(out);
    }
    if (routable.length === 1 && eps.length > 1) add('WARN', `Only one provider (${routable[0].provider_name}) accepts every parameter the site sends${model.logprobs ? ', probabilities included' : ''}, so there is no fallback if it has an outage during class.`);
    basis = epPrice(routable[0]);
    out.priceBasis = model.logprobs ? 'cheapest provider with probabilities' : 'cheapest provider that accepts every parameter';
  } else if (model.logprobs) {
    // 5. Probabilities without require_parameters. OpenRouter does not skip providers that ignore a parameter, and its
    //    routing favours cheaper providers, so the cheapest provider matters most.
    if (lpEps.length === 0) {
      add('FAIL', `models.js says it shares probabilities (logprobs: true), but no provider supports logprobs any more. ${CHAPTER.predict} will show "no probabilities". Set logprobs: false or replace the model.`);
      out.probs = 'MISSING';
    } else {
      out.probs = `yes, ${lpEps.length} of ${plural(eps.length, 'provider')}`;
      if (lpEps.length < eps.length) {
        const cheapest = [...healthy].sort(byPrice)[0];
        const cheapNote = cheapest && !supportsLogprobs(cheapest) ? ` The cheapest provider (${cheapest.provider_name}) is one that does not, so many requests will come back without probabilities.` : '';
        add(cheapNote ? 'WARN' : 'NOTE', `Only ${lpEps.length} of ${eps.length} providers return probabilities.${cheapNote} Fix: add this line to the model's entry in models.js so OpenRouter only picks providers that do: ${REQUIRE_PARAMS_SNIPPET}`);
      }
    }
  } else {
    out.probs = 'not offered';
    if (lpEps.length > 0) add('NOTE', `models.js says no probabilities, but ${lpEps.length} of ${eps.length} providers now support logprobs. It could be switched to logprobs: true with ${REQUIRE_PARAMS_SNIPPET}`);
  }
  out.orPrice = basis;

  // 6. Price drift against what OpenRouter will charge.
  if (model.price && basis.in != null && basis.out != null) {
    const di = drift(model.price.in, basis.in), dout = drift(model.price.out, basis.out);
    if (Math.abs(di) > PRICE_DRIFT || Math.abs(dout) > PRICE_DRIFT) {
      const up = di > 0 || dout > 0;
      const whose = out.priceBasis === 'headline' ? 'OpenRouter now charges' : `the ${out.priceBasis} charges`;
      add('WARN', `Price changed: models.js says $${money(model.price.in)} in / $${money(model.price.out)} out per million tokens, ${whose} $${money(basis.in)} / $${money(basis.out)}. `
        + (up ? 'The site under-estimates cost (the budget reservation runs low, and so does the cost shown whenever OpenRouter does not report one). ' : 'The site over-estimates cost (harmless: the budget reservation runs high; the cost shown comes from OpenRouter when it reports one). ')
        + `Update price in models.js to { in: ${money(basis.in)}, out: ${money(basis.out)} }.`);
    }
  }

  // 7. Temperature that is sent should be honoured. (With require_parameters, providers without it are already excluded.)
  if (!requiresParams(model) && sentParams(model).includes('temperature')) {
    const accepting = eps.filter(ep => supports(ep, 'temperature'));
    if (accepting.length === 0) add('WARN', `OpenRouter lists no provider that accepts 'temperature'. If requests fail, add upstream: { omit: ['temperature'] } to this model in models.js.`);
    else if (accepting.length < eps.length) add('NOTE', `OpenRouter lists temperature support for only ${accepting.length} of ${eps.length} providers; on the others the temperature slider may be ignored.`);
  }

  return finish(out);
}

function finish(out) {
  out.level = out.findings.some(f => f.level === 'FAIL') ? 'FAIL' : out.findings.some(f => f.level === 'WARN') ? 'WARN' : 'OK';
  return out;
}

/** Whole-ladder checks that are not about one model. */
export function checkLadder(site) {
  const findings = [];
  const ids = new Set(site.MODELS.map(m => m.id));
  if (site.AUTOCOMPLETE_MODEL && !ids.has(site.AUTOCOMPLETE_MODEL)) findings.push({ level: 'FAIL', text: `AUTOCOMPLETE_MODEL (${site.AUTOCOMPLETE_MODEL}) is not in MODELS.` });
  if (site.DEFAULT_MODEL && !ids.has(site.DEFAULT_MODEL)) findings.push({ level: 'FAIL', text: `DEFAULT_MODEL (${site.DEFAULT_MODEL}) is not in MODELS.` });
  const dupes = site.MODELS.map(m => m.id).filter((id, i, a) => a.indexOf(id) !== i);
  if (dupes.length) findings.push({ level: 'FAIL', text: `Duplicate model ids in MODELS: ${[...new Set(dupes)].join(', ')}.` });
  return findings;
}

async function runCatalog(site, args) {
  const now = Date.now();
  let catalog, catalogSource;
  if (args.catalog) {
    catalog = JSON.parse(await readFile(args.catalog, 'utf8'));
    catalogSource = `saved copy ${args.catalog} (provider lists fetched live)`;
  } else {
    catalog = (await getJson(`${OPENROUTER}/models`)).json;
    catalogSource = `live, fetched ${new Date(now).toISOString().slice(0, 16).replace('T', ' ')} UTC`;
  }
  const rows = Array.isArray(catalog?.data) ? catalog.data : [];
  if (!rows.length) throw new Error('the OpenRouter catalog came back empty');
  const byId = new Map(rows.map(r => [r.id, r]));

  const results = [];
  for (const m of site.MODELS) {
    const r = await getJson(`${OPENROUTER}/models/${m.id}/endpoints`);
    const endpoints = r.status === 404 ? null : (r.json?.data?.endpoints ?? []);
    const roles = [m.id === site.AUTOCOMPLETE_MODEL && 'autocomplete', m.id === site.DEFAULT_MODEL && 'default'].filter(Boolean);
    results.push(checkModel(m, byId.get(m.id), endpoints, { roles, now }));
  }
  return { mode: 'catalog', modelsFile: site.file, catalogSource, catalogSize: rows.length, ladder: checkLadder(site), results, catalogRows: rows };
}

/** Numbered findings of one level across the ladder and every model, for the report and the verdict. */
const findingsAt = (rep, level) => [
  ...rep.ladder.filter(f => f.level === level).map(f => ({ who: 'Model list', text: f.text })),
  ...rep.results.flatMap(r => r.findings.filter(f => f.level === level).map(f => ({ who: `${r.label} [${r.id}]`, text: f.text }))),
];

function printCatalog(rep) {
  const L = [];
  L.push(bold('LLM Under the Hood: pre-class model check'));
  L.push(dim(`Models file:        ${rep.modelsFile}`));
  L.push(dim(`OpenRouter catalog: ${rep.catalogSource} (${rep.catalogSize} models)`));
  L.push('');
  L.push(`  ${pad('Model', 38)} ${pad('Result', 6)} ${pad('Providers', 10)} ${pad('Site price $/M (in/out)', 23)} ${pad('OpenRouter price', 16)} Probabilities`);
  L.push(`  ${'-'.repeat(38)} ${'-'.repeat(6)} ${'-'.repeat(10)} ${'-'.repeat(23)} ${'-'.repeat(16)} ${'-'.repeat(22)}`);
  for (const r of rep.results) {
    const provs = r.providers === 0 ? 'none' : r.healthy === r.providers ? String(r.providers) : `${r.healthy} of ${r.providers} ok`;
    const site = `${money(r.sitePrice?.in)} / ${money(r.sitePrice?.out)}`;
    const or = r.orPrice ? `${money(r.orPrice.in)} / ${money(r.orPrice.out)}${r.priceBasis === 'headline' ? '' : ' *'}` : '-';
    L.push(`  ${pad(r.label, 38)} ${LEVEL_COLOR[r.level](pad(r.level, 6))} ${pad(provs, 10)} ${pad(site, 23)} ${pad(or, 16)} ${r.probs}`);
  }
  if (rep.results.some(r => r.priceBasis !== 'headline')) L.push(dim('  * models routed with require_parameters: the cheapest provider that accepts everything the site sends, not the headline price.'));
  const sections = [['FAIL', 'Problems (fix before class)', red], ['WARN', 'Warnings (worth a look)', yellow], ['NOTE', 'Notes', dim]];
  for (const [level, title, color] of sections) {
    const items = findingsAt(rep, level);
    if (!items.length) continue;
    L.push('', color(bold(title)));
    items.forEach((it, i) => L.push(`  ${i + 1}. ${it.who}`, `     ${it.text}`));
  }
  const working = rep.results.filter(r => r.level !== 'FAIL').length;
  L.push('', `Catalog: ${working} of ${rep.results.length} models are available and working. ${plural(findingsAt(rep, 'FAIL').length, 'problem')}, ${plural(findingsAt(rep, 'WARN').length, 'warning')}.`);
  L.push(dim('This reads OpenRouter\'s public catalog only. To prove a real request works end to end, add --live.'));
  return L.join('\n');
}

// ---- Suggestions: cheap models that share probabilities, oldest first (for the evolution ladder) ------------------

export function suggestions(rows, site, maxPrice) {
  const onSite = new Set(site.MODELS.map(m => m.id));
  return rows
    .filter(r => (r.supported_parameters || []).includes('logprobs') && (r.supported_parameters || []).includes('top_logprobs'))
    .filter(r => (r.architecture?.output_modalities || ['text']).includes('text'))
    .filter(r => !r.id.startsWith('~') && !r.id.includes(':')) // skip moving aliases (~x/latest) and :batch/:free variants
    .map(r => ({ id: r.id, year: new Date((r.created || 0) * 1000).getUTCFullYear(), created: r.created || 0, in: perMillion(r.pricing?.prompt), out: perMillion(r.pricing?.completion), retires: r.expiration_date || null, onSite: onSite.has(r.id) }))
    .filter(r => r.out != null && r.out > 0 && r.out <= maxPrice)
    .sort((a, b) => a.created - b.created);
}

function printSuggestions(picks, maxPrice) {
  const L = ['', bold(`Models on OpenRouter that list logprobs, output price up to $${maxPrice}/M, oldest first (date added to OpenRouter)`),
    dim('Catalog-level only: some providers of a model may not return probabilities. Add a candidate to models.js and re-run to see.'),
    dim('The list includes community fine-tunes, some built for role-play; for class, pick models from the major labs.')];
  for (const r of picks) L.push(`  ${r.year}  ${pad(r.id, 52)} $${pad(money(r.in), 6)} / $${pad(money(r.out), 6)}${r.onSite ? ' (on site)' : ''}${r.retires ? ` retires ${r.retires}` : ''}`);
  if (!picks.length) L.push('  (none)');
  return L.join('\n');
}

// ---- Live check: a few tiny real generations per model through the site -------------------------------------------

const liveMaxTokens = (m) => (isReasoning(m) ? LIVE_MAX_TOKENS_REASONING : LIVE_MAX_TOKENS);
/** Requests per model: logprobs models get several, since OpenRouter routes each request separately. */
export const liveTries = (m) => (m.logprobs ? LIVE_LOGPROB_TRIES : 1);
const livePromptTokens = (m) => LIVE_PROMPT_TOKENS_EST + (m.endpoint === 'completion' ? LIVE_FRAME_TOKENS_EST : 0);
const liveRequestCost = (m) => (livePromptTokens(m) * m.price.in + liveMaxTokens(m) * m.price.out) / 1e6;

/** Rough USD for one live run over `models`, from models.js prices. Not a strict bound: chat templates can add prompt tokens. */
export function estimateLiveCost(models) {
  return models.reduce((sum, m) => sum + liveTries(m) * liveRequestCost(m), 0);
}

/** The exact body site/api.js generate() sends. */
export function liveBody(m) {
  return { model: m.id, prompt: LIVE_PROMPT, system: '', prefix: '', maxTokens: liveMaxTokens(m), temperature: 0, topLogprobs: m.logprobs ? LIVE_TOP_LOGPROBS : 0, stream: true };
}

/** Which models the live run skips, and why: anything the catalog check already marked FAIL. */
export function liveSkips(catalogResults) {
  return new Map(catalogResults.filter(r => r.level === 'FAIL').map(r => [r.id, r.available ? 'skipped: failed the catalog check' : 'skipped: retired on OpenRouter']));
}

/** Judge one reply's normalized event list ({type:'token'|'error'|'done'}). */
export function judgeLive(m, events) {
  const tokens = events.filter(e => e.type === 'token');
  const error = events.find(e => e.type === 'error');
  const done = events.find(e => e.type === 'done');
  const text = tokens.map(t => t.text).join('');
  const withProbs = tokens.filter(t => typeof t.logprob === 'number' && Array.isArray(t.top) && t.top.length > 0).length;
  const findings = [];
  if (error) findings.push({ level: 'FAIL', text: `The model returned an error: "${error.message}".` });
  if (!text.trim()) findings.push({ level: 'FAIL', text: isReasoning(m) ? 'No text came back (a reasoning model can spend all its tokens thinking).' : 'No text came back.' });
  if (m.logprobs && text.trim() && withProbs === 0) findings.push({ level: 'FAIL', text: `Text arrived without probabilities, so ${CHAPTER.predict} would show "no probabilities". OpenRouter likely sent it to a provider that ignores logprobs.` });
  if (!done) findings.push({ level: 'WARN', text: 'The reply ended without a final "done" event, so the cost was not reported.' });
  // done.usage.completion is the billed count; token events are text chunks when a model has no logprobs.
  const count = typeof done?.usage?.completion === 'number' ? done.usage.completion : tokens.length;
  return { text, tokens: count, hasProbs: withProbs > 0, cost: typeof done?.cost === 'number' ? done.cost : null, findings };
}

/** A FAIL finding for a request that never produced a reply. `res.httpStatus` 0 means the request itself broke. */
export function liveHttpFinding(res) {
  const hint = res.httpStatus === 0 ? ' The site or the model did not respond. Check your connection and re-run; if it repeats, try the model on the site.'
    : res.httpStatus === 502 ? ' OpenRouter or its provider turned the request down; run `npx wrangler tail` while re-running to see the exact error.'
    : res.httpStatus === 400 ? ' The site does not accept this model. If you just changed models.js, run npm run deploy.'
    : res.httpStatus === 401 ? ' The site did not accept the session. Re-run and sign in again.'
    : res.httpStatus === 429 ? ' The class budget or a rate limit stopped it. Wait, or re-run tomorrow.' : '';
  const what = res.httpStatus === 0 ? res.message : `HTTP ${res.httpStatus}: ${(res.message || 'no message').replace(/\.$/, '')}.`;
  return { level: 'FAIL', text: `${what}${hint}` };
}

/** One table row from a model's replies (`judged`, from judgeLive) and the failed request that stopped it, if any. */
export function combineTries(m, judged, failedRequest = null) {
  const findings = [];
  for (const f of judged.flatMap(j => j.findings)) if (!findings.some(g => g.text === f.text)) findings.push(f);
  if (failedRequest) findings.push(liveHttpFinding(failedRequest));
  const costs = judged.map(j => j.cost).filter(c => c != null);
  const row = {
    model: m, text: judged[0]?.text ?? '', tokens: judged[0]?.tokens ?? 0, replies: judged.length,
    withProbs: judged.filter(j => j.hasProbs).length, cost: costs.length ? costs.reduce((a, b) => a + b, 0) : null, findings,
  };
  row.level = findings.some(f => f.level === 'FAIL') ? 'FAIL' : findings.length ? 'WARN' : 'OK';
  return row;
}

async function promptHidden(question) {
  if (!process.stdin.isTTY) throw new Error('no terminal to type the passcode into; set LLUTH_PASSCODE instead');
  process.stdout.write(question);
  process.stdin.setRawMode(true);
  process.stdin.setEncoding('utf8');
  process.stdin.resume();
  return new Promise((resolve, reject) => {
    let s = '';
    const cleanup = () => { process.stdin.setRawMode(false); process.stdin.pause(); process.stdin.off('data', onData); process.stdout.write('\n'); };
    const onData = (chunk) => {
      for (const ch of chunk) {
        if (ch === '\r' || ch === '\n' || ch === '\u0004') { cleanup(); resolve(s); return; }
        if (ch === '\u0003') { cleanup(); reject(new Error('cancelled')); return; }
        if (ch === '\u007f' || ch === '\b') s = s.slice(0, -1); else s += ch;
      }
    };
    process.stdin.on('data', onData);
  });
}

async function signIn(siteUrl, passcode) {
  const r = await fetch(`${siteUrl}/api/auth`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ passcode }), signal: AbortSignal.timeout(FETCH_TIMEOUT_MS) });
  if (r.status === 401) throw new Error('the site says that passcode is not right');
  if (r.status === 429) throw new Error('too many sign-in attempts from this network; wait a minute');
  if (r.status !== 204) {
    let message = ''; try { message = (await r.json())?.message || ''; } catch { /* not JSON */ }
    throw new Error(`sign-in returned HTTP ${r.status}${message ? `: ${message}` : ''}`);
  }
  const cookies = typeof r.headers.getSetCookie === 'function' ? r.headers.getSetCookie() : [r.headers.get('set-cookie') || ''];
  const sess = cookies.map(c => c.split(';')[0].trim()).find(c => c.startsWith('sess='));
  if (!sess) throw new Error('sign-in succeeded but no session cookie came back');
  return sess;
}

/** POST /api/generate and collect the normalized SSE events, exactly as site/api.js reads them. May throw. */
async function liveGenerate(siteUrl, cookie, body, parseSSE) {
  const r = await fetch(`${siteUrl}/api/generate`, { method: 'POST', headers: { 'content-type': 'application/json', cookie }, body: JSON.stringify(body), signal: AbortSignal.timeout(LIVE_TIMEOUT_MS) });
  if (!r.ok) {
    let message = ''; try { message = (await r.json())?.message || ''; } catch { /* not JSON */ }
    return { httpStatus: r.status, retryAfter: Number(r.headers.get('retry-after')) || null, message, events: [] };
  }
  const events = [];
  const deliver = (raw) => { try { events.push(JSON.parse(raw)); } catch { /* skip */ } };
  const reader = r.body.getReader();
  const dec = new TextDecoder();
  let buf = '';
  for (;;) {
    const { value, done } = await reader.read();
    if (done) break;
    buf += dec.decode(value, { stream: true });
    const parsed = parseSSE(buf);
    buf = parsed.rest;
    parsed.events.forEach(deliver);
  }
  buf += dec.decode();
  parseSSE(buf + '\n\n').events.forEach(deliver);
  return { httpStatus: r.status, events };
}

/** liveGenerate that never throws (a timeout or dropped connection becomes httpStatus 0) and retries one short rate limit. */
async function liveRequest(siteUrl, cookie, m, parseSSE) {
  const once = async () => {
    try { return await liveGenerate(siteUrl, cookie, liveBody(m), parseSSE); }
    catch (err) { return { httpStatus: 0, message: err?.name === 'TimeoutError' ? `No answer within ${LIVE_TIMEOUT_MS / 1000} seconds.` : `The connection dropped (${err?.message || err}).`, events: [] }; }
  };
  let res = await once();
  if (res.httpStatus === 429 && res.retryAfter && res.retryAfter <= 60 && !/budget/i.test(res.message)) {
    await sleep(res.retryAfter * 1000);
    res = await once();
  }
  return res;
}

async function runLive(site, args, catalogRep) {
  const siteUrl = (args.site || process.env.LLUTH_SITE || DEFAULT_SITE).replace(/\/+$/, '');
  const { parseSSE } = await import(new URL('./sse.js', site.url).href);
  const L = [bold(`LLM Under the Hood: live check (real requests through ${new URL(siteUrl).host})`), dim(`Site: ${siteUrl}`)];

  // What students actually get is the deployed list (public, no sign-in), which can lag the local file until a deploy.
  let models = site.MODELS, listNote = 'local models.js (dry run: the site was not contacted)';
  if (!args.dryRun) {
    const deployed = (await getJson(`${siteUrl}/api/models`)).json;
    if (!Array.isArray(deployed)) throw new Error(`${siteUrl}/api/models did not return a model list`);
    const localIds = site.MODELS.map(m => m.id).join(','), deployedIds = deployed.map(m => m.id).join(',');
    listNote = 'the site';
    if (localIds !== deployedIds) L.push(yellow('Note: the site\'s model list differs from your local models.js. Testing what the site serves; run npm run deploy to publish local changes.'));
    models = deployed;
  }
  const skips = liveSkips(catalogRep.results);
  const tested = models.filter(m => !skips.has(m.id));
  const estimate = estimateLiveCost(tested);
  L.push(dim(`Testing ${tested.length} of ${models.length} models from ${listNote}, one request at a time. Prompt: "${LIVE_PROMPT}", up to ${LIVE_MAX_TOKENS} tokens (${LIVE_MAX_TOKENS_REASONING} for reasoning models).`));
  L.push(dim(`Models that share probabilities get ${LIVE_LOGPROB_TRIES} requests each, because OpenRouter may send each one to a different provider.`));
  L.push(dim(`Estimated cost of this run: ${plainUsd(estimate)}. It counts against the site's daily class budget.`));
  if (args.dryRun) {
    L.push('', ...models.map(m => skips.has(m.id)
      ? `  ${pad(m.label, 38)} ${dim(skips.get(m.id))}`
      : `  ${pad(m.label, 38)} ${plural(liveTries(m), 'request')}, up to ${liveMaxTokens(m)} tokens${m.logprobs ? ', expects probabilities' : ''}, about ${roughUsd(liveTries(m) * liveRequestCost(m))}`));
    return { text: L.join('\n'), rows: [], dryRun: true };
  }
  console.log(L.join('\n'));
  L.length = 0;

  const passcode = process.env.LLUTH_PASSCODE || await promptHidden('Class passcode (typing is hidden): ');
  const cookie = await signIn(siteUrl, passcode.trim());
  console.log(dim('Signed in.\n'));
  console.log(`  ${pad('Model', 38)} ${pad('Result', 6)} ${pad('Tokens', 6)} ${pad('With probabilities', 18)} ${pad('Cost', 10)} Sample of the reply`);

  const rows = [];
  for (const m of models) {
    if (skips.has(m.id)) {
      rows.push({ model: m, level: 'SKIP', findings: [] });
      console.log(`  ${pad(m.label, 38)} ${dim(pad('SKIP', 6))} ${dim(skips.get(m.id))}`);
      continue;
    }
    const judged = [];
    let failedRequest = null;
    for (let t = 0; t < liveTries(m); t++) {
      if (t) await sleep(LIVE_PAUSE_MS);
      const res = await liveRequest(siteUrl, cookie, m, parseSSE);
      if (res.httpStatus !== 200) { failedRequest = res; break; }
      judged.push(judgeLive(m, res.events));
      if (judged.at(-1).findings.some(f => f.level === 'FAIL')) break; // already failed: no need to spend more
    }
    const row = combineTries(m, judged, failedRequest);
    rows.push(row);
    const probs = m.logprobs && row.replies ? `${row.withProbs} of ${row.replies} ${row.replies === 1 ? 'reply' : 'replies'}` : '-';
    const sample = row.replies ? JSON.stringify(row.text.slice(0, 40)) : dim('(no reply, see Details)');
    console.log(`  ${pad(m.label, 38)} ${LEVEL_COLOR[row.level](pad(row.level, 6))} ${pad(row.replies ? row.tokens : '-', 6)} ${pad(probs, 18)} ${pad(roughUsd(row.cost), 10)} ${sample}`);
    await sleep(LIVE_PAUSE_MS);
  }
  const problems = rows.filter(r => r.findings.length);
  if (problems.length) {
    L.push('', bold('Details'));
    problems.forEach((r, i) => r.findings.forEach(f => L.push(`  ${i + 1}. ${r.model.label} [${r.model.id}] ${LEVEL_COLOR[f.level](f.level)}: ${f.text}`)));
  }
  const ran = rows.filter(r => r.level !== 'SKIP');
  const spent = ran.reduce((s, r) => s + (r.cost || 0), 0);
  const skipped = rows.length - ran.length;
  L.push('', `Live: ${ran.filter(r => r.level !== 'FAIL').length} of ${ran.length} tested models answered${skipped ? ` (${skipped} skipped after the catalog check)` : ''}. Spent ${plainUsd(spent)} (estimate: ${plainUsd(estimate)}).`);
  L.push(dim('Read the Sample column: the autocomplete model should continue the sentence, the chat models may answer it.'));
  L.push(dim(`Probabilities depend on which provider OpenRouter picks, so ${LIVE_LOGPROB_TRIES} of ${LIVE_LOGPROB_TRIES} is a good sign, not a guarantee.`));
  return { text: L.join('\n'), rows };
}

// ---- Verdict --------------------------------------------------------------------------------------------------------

/** The one line the run ends on, and the exit code. `liveRows` is empty when --live was not used (or was a dry run). */
export function verdict(rep, liveRows = [], { strict = false } = {}) {
  const problems = findingsAt(rep, 'FAIL').length + liveRows.filter(r => r.level === 'FAIL').length;
  const warnings = findingsAt(rep, 'WARN').length + liveRows.filter(r => r.level === 'WARN').length;
  if (problems) return { code: 1, ready: false, problems, warnings, text: `NOT READY: ${plural(problems, 'problem')} to fix (see "Problems" above).` };
  if (strict && warnings) return { code: 1, ready: false, problems, warnings, text: `NOT READY (--strict): ${plural(warnings, 'warning')} to clear (see "Warnings" above).` };
  return { code: 0, ready: true, problems, warnings, text: `READY for class.${warnings ? ` ${plural(warnings, 'warning')} worth a look above.` : ''}` };
}

// ---- Main ---------------------------------------------------------------------------------------------------------

async function main() {
  const args = parseArgs(process.argv.slice(2));
  if (args.help) {
    const src = await readFile(new URL(import.meta.url), 'utf8');
    const header = src.split('\n');
    console.log(header.slice(0, header.findIndex(l => !l.startsWith('//'))).map(l => l.replace(/^\/\/ ?/, '')).join('\n'));
    return 0;
  }
  const site = await loadSite(args.models);
  const rep = await runCatalog(site, args);
  const picks = args.suggest ? suggestions(rep.catalogRows, site, args.maxPrice) : null;

  if (args.json) {
    const { catalogRows, ...rest } = rep;
    const v = verdict(rep, [], args);
    console.log(JSON.stringify({ ...rest, ...(picks ? { suggestions: picks } : {}), verdict: v }, null, 2));
    return v.code;
  }
  console.log(printCatalog(rep));
  if (picks) console.log(printSuggestions(picks, args.maxPrice));

  let liveRows = [];
  if (args.live) {
    console.log('');
    const live = await runLive(site, args, rep);
    console.log(live.text);
    liveRows = live.rows;
  }
  const v = verdict(rep, liveRows, args);
  console.log('\n' + bold(v.ready ? green(v.text) : red(v.text)));
  return v.code;
}

if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  main().then((code) => { process.exitCode = code; }, (err) => { console.error(red(`check_models: ${err?.message || err}`)); process.exitCode = 2; });
}
