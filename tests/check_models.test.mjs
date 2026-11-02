import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  drift, money, roughUsd, plainUsd, parseArgs, sentParams, routableProviders, checkModel, checkLadder, verdict,
  liveTries, estimateLiveCost, liveBody, liveSkips, judgeLive, liveHttpFinding, combineTries,
} from '../tools/check_models.mjs';

// Fixtures in the shapes OpenRouter's /models and /models/<id>/endpoints return. Prices there are USD per token.
const perTok = (perM) => String(perM / 1e6);
const row = (id, inM, outM, extra = {}) => ({ id, pricing: { prompt: perTok(inM), completion: perTok(outM) }, ...extra });
const ep = (provider_name, inM, outM, params, extra = {}) => ({ provider_name, status: 0, uptime_last_1d: 100, pricing: { prompt: perTok(inM), completion: perTok(outM) }, supported_parameters: params, ...extra });
const LP = ['logprobs', 'top_logprobs', 'temperature', 'max_tokens'];
const NO_LP = ['temperature', 'max_tokens'];
const REQUIRE = { extra: { provider: { require_parameters: true } } };

const model = (over = {}) => ({ id: 'x/model', label: 'Model', year: 2026, logprobs: false, endpoint: 'chat', price: { in: 0.1, out: 0.5 }, ...over });
const llama = model({ id: 'meta-llama/llama-3.3-70b-instruct', label: 'Llama 3.3', logprobs: true, price: { in: 0.135, out: 0.4 }, upstream: REQUIRE });
// The real Llama 3.3 picture on 2026-11-02, trimmed: the cheapest provider drops logprobs, Groq too.
const llamaEndpoints = [
  ep('DeepInfra', 0.1, 0.32, NO_LP),
  ep('Novita', 0.135, 0.4, LP),
  ep('AkashML', 0.2, 0.52, LP),
  ep('Groq', 0.59, 0.79, NO_LP),
];
const llamaRow = row(llama.id, 0.1, 0.32); // headline = the cheapest provider, which has no logprobs
const levels = (r) => r.findings.map(f => f.level);

// ---- Money and drift ------------------------------------------------------------------------------------------------

test('plainUsd: amounts read the way a person says them', () => {
  assert.equal(plainUsd(0.0010676), 'about $0.001, a tenth of a cent');
  assert.equal(plainUsd(0.003), 'about $0.003, 3 tenths of a cent');
  assert.equal(plainUsd(0.0004), 'about $0.0004, 4 hundredths of a cent');
  assert.equal(plainUsd(0.0001), 'about $0.0001, a hundredth of a cent');
  assert.equal(plainUsd(0.00000361), 'about $0.000004, a tiny fraction of a cent');
  assert.equal(plainUsd(0.05), 'about $0.05, 5 cents');
  assert.equal(plainUsd(0.0099), 'about $0.01, one cent');
  assert.equal(plainUsd(2.5), 'about $2.50');
  assert.equal(plainUsd(0), 'nothing');
  assert.equal(plainUsd(null), 'an unknown amount');
});
test('roughUsd and money: no seven-decimal strings', () => {
  assert.equal(roughUsd(0.0000036), '$0.000004');
  assert.equal(roughUsd(0.00094), '$0.0009');
  assert.equal(roughUsd(0.0123), '$0.01');
  assert.equal(roughUsd(0), '$0');
  assert.equal(roughUsd(null), '?');
  assert.equal(money(30), '30');
  assert.equal(money(2.5), '2.50');
  assert.equal(money(0.135), '0.135');
  assert.equal(money(0.15), '0.15');
  assert.equal(money(null), '?');
});
test('drift: signed fraction, safe with zero prices', () => {
  assert.equal(drift(1, 1.5), 0.5);
  assert.ok(Math.abs(drift(0.13, 0.024) + 0.815) < 0.001);
  assert.equal(drift(0, 0.1), Infinity);
  assert.equal(drift(0, 0), 0);
});

// ---- Parameters and provider filtering -------------------------------------------------------------------------------

test('sentParams: what the Worker sends, minus omitted keys, plus extra keys other than provider', () => {
  assert.deepEqual(sentParams(llama), ['max_tokens', 'temperature', 'logprobs', 'top_logprobs']);
  assert.deepEqual(sentParams(model({ upstream: { omit: ['temperature'], extra: { reasoning: { effort: 'minimal' } } } })), ['max_tokens', 'reasoning']);
  assert.deepEqual(sentParams(model({ upstream: { omit: ['temperature'] } })), ['max_tokens']);
  assert.deepEqual(sentParams(model()), ['max_tokens', 'temperature']);
});
test('routableProviders: require_parameters keeps only working providers that list every sent parameter, cheapest first', () => {
  const eps = [
    ep('Pricey', 0.7, 0.7, LP),
    ...llamaEndpoints,
    ep('Down', 0.01, 0.01, LP, { status: -2 }),
    ep('NoTemp', 0.05, 0.05, ['logprobs', 'top_logprobs', 'max_tokens']),
  ];
  assert.deepEqual(routableProviders(llama, eps).map(e => e.provider_name), ['Novita', 'AkashML', 'Pricey']);
  // Without require_parameters OpenRouter may route to any working provider.
  assert.deepEqual(routableProviders({ ...llama, upstream: undefined }, eps).map(e => e.provider_name),
    ['NoTemp', 'DeepInfra', 'Novita', 'AkashML', 'Groq', 'Pricey']);
});

// ---- checkModel verdicts ---------------------------------------------------------------------------------------------

test('require_parameters model: price is compared with the cheapest provider that returns probabilities, not the headline', () => {
  const r = checkModel(llama, llamaRow, llamaEndpoints);
  assert.equal(r.level, 'OK', JSON.stringify(r.findings));
  assert.deepEqual(r.orPrice, { in: 0.135, out: 0.4 });
  assert.equal(r.priceBasis, 'cheapest provider with probabilities');
  assert.equal(r.probs, 'yes, 2 of 4 providers');
});
test('require_parameters model: drift against the qualifying provider is a warning with the exact numbers to paste', () => {
  const r = checkModel({ ...llama, price: { in: 0.1, out: 0.32 } }, llamaRow, llamaEndpoints);
  assert.equal(r.level, 'WARN');
  assert.match(r.findings[0].text, /under-estimates/);
  assert.match(r.findings[0].text, /\{ in: 0\.135, out: 0\.40 \}/);
  const over = checkModel({ ...llama, price: { in: 0.3, out: 0.6 } }, llamaRow, llamaEndpoints);
  assert.equal(over.level, 'WARN');
  assert.match(over.findings[0].text, /over-estimates/);
});
test('require_parameters model: no provider accepts everything the site sends → FAIL', () => {
  const eps = [ep('DeepInfra', 0.1, 0.32, NO_LP), ep('Groq', 0.59, 0.79, NO_LP), ep('Down', 0.2, 0.5, LP, { status: -5 })];
  const r = checkModel(llama, llamaRow, eps, { roles: ['autocomplete'] });
  assert.equal(r.level, 'FAIL');
  assert.equal(r.available, true);
  assert.equal(r.probs, 'no provider qualifies');
  assert.match(r.findings.find(f => f.level === 'FAIL').text, /logprobs, top_logprobs.*AUTOCOMPLETE_MODEL/s);
});
test('require_parameters model: one qualifying provider out of several is a warning, not a failure', () => {
  const r = checkModel(llama, llamaRow, [ep('DeepInfra', 0.1, 0.32, NO_LP), ep('Novita', 0.135, 0.4, LP)]);
  assert.equal(r.level, 'WARN');
  assert.match(r.findings[0].text, /Only one provider \(Novita\)/);
});
test('single-provider model: WARN, not FAIL', () => {
  const m = model({ id: 'openai/gpt-4', logprobs: true, price: { in: 30, out: 60 } });
  const r = checkModel(m, row(m.id, 30, 60), [ep('Azure', 30, 60, ['logprobs', 'top_logprobs', 'temperature'])]);
  assert.equal(r.level, 'WARN');
  assert.deepEqual(levels(r), ['WARN']);
  assert.match(r.findings[0].text, /Only one provider \(Azure\)/);
  assert.equal(r.probs, 'yes, 1 of 1 provider');
});
test('retired model: FAIL whether OpenRouter answers 200 with no endpoints or 404', () => {
  const m = model({ id: 'openai/gpt-3.5-turbo-instruct' });
  const gone = checkModel(m, undefined, []);
  assert.equal(gone.level, 'FAIL');
  assert.equal(gone.available, false);
  assert.match(gone.findings[0].text, /dropped it from its model list/);
  const unknown = checkModel(m, undefined, null, { roles: ['default'] });
  assert.match(unknown.findings[0].text, /does not know this model id.*DEFAULT_MODEL/s);
});
test('logprobs model without require_parameters whose cheapest provider drops them: WARN with the line to paste', () => {
  const m = { ...llama, upstream: undefined };
  const r = checkModel(m, llamaRow, llamaEndpoints);
  assert.equal(r.level, 'WARN');
  assert.match(r.findings.find(f => /probabilities/.test(f.text)).text, /DeepInfra.*upstream: LOGPROB_PROVIDERS_ONLY,/s);
});
test('logprobs model with no logprobs provider at all: FAIL', () => {
  const m = model({ logprobs: true });
  const r = checkModel(m, row(m.id, 0.1, 0.5), [ep('A', 0.1, 0.5, NO_LP), ep('B', 0.1, 0.5, NO_LP)]);
  assert.equal(r.level, 'FAIL');
  assert.equal(r.probs, 'MISSING');
});
test('temperature: a note when it is sent but only some providers list it; nothing when the model omits it', () => {
  const m = model({ id: 'google/gemini-3.5-flash-lite', price: { in: 0.3, out: 2.5 } });
  const eps = [ep('AI Studio', 0.3, 2.5, NO_LP), ep('Vertex', 0.3, 2.5, ['max_tokens'])];
  const r = checkModel(m, row(m.id, 0.3, 2.5), eps);
  assert.equal(r.level, 'OK');
  assert.deepEqual(levels(r), ['NOTE']);
  assert.match(r.findings[0].text, /only 1 of 2 providers.*may be ignored/);
  const omitted = checkModel({ ...m, upstream: { omit: ['temperature'] } }, row(m.id, 0.3, 2.5), eps);
  assert.deepEqual(omitted.findings, []);
});
test('expiration date: FAIL when passed, WARN when close, NOTE when far off', () => {
  const now = Date.parse('2026-11-02T00:00:00Z');
  const eps = [ep('A', 0.1, 0.5, NO_LP), ep('B', 0.1, 0.5, NO_LP)];
  const at = (d) => checkModel(model(), row('x/model', 0.1, 0.5, { expiration_date: d }), eps, { now });
  assert.equal(at('2026-10-01').level, 'FAIL');
  assert.equal(at('2026-11-20').level, 'WARN');
  assert.equal(at('2027-06-01').level, 'OK');
});
test('checkLadder: missing default/autocomplete ids and duplicates are FAILs', () => {
  const MODELS = [model({ id: 'a' }), model({ id: 'a' })];
  const f = checkLadder({ MODELS, DEFAULT_MODEL: 'a', AUTOCOMPLETE_MODEL: 'b' });
  assert.equal(f.length, 2);
  assert.ok(f.every(x => x.level === 'FAIL'));
});

// ---- Verdict and exit codes ------------------------------------------------------------------------------------------

const rep = (...results) => ({ ladder: [], results });
const res = (level) => ({ id: level, label: level, level, findings: level === 'OK' ? [] : [{ level, text: level }] });

test('verdict: warnings alone are READY (exit 0); a hard failure is NOT READY (exit 1)', () => {
  assert.deepEqual([verdict(rep(res('OK'), res('WARN'))).code, verdict(rep(res('OK'), res('WARN'))).ready], [0, true]);
  assert.match(verdict(rep(res('WARN'))).text, /^READY for class\. 1 warning worth a look/);
  const bad = verdict(rep(res('OK'), res('FAIL')));
  assert.equal(bad.code, 1);
  assert.match(bad.text, /^NOT READY: 1 problem to fix/);
  // NOTE-only results do not count as warnings.
  assert.equal(verdict(rep({ id: 'n', level: 'OK', findings: [{ level: 'NOTE', text: 'n' }] })).text, 'READY for class.');
});
test('verdict: --strict turns warnings into exit 1; live FAIL rows count, SKIP rows do not', () => {
  assert.equal(verdict(rep(res('WARN')), [], { strict: true }).code, 1);
  assert.equal(verdict(rep(res('OK')), [{ level: 'FAIL' }]).code, 1);
  assert.equal(verdict(rep(res('OK')), [{ level: 'SKIP' }, { level: 'OK' }]).code, 0);
  assert.equal(verdict({ ladder: [{ level: 'FAIL', text: 'dupe' }], results: [res('OK')] }).code, 1);
});
test('parseArgs: flags, values, and plain-language errors', () => {
  assert.deepEqual(parseArgs(['--live', '--site', 'http://localhost:8787', '--dry-run']), {
    live: true, dryRun: true, suggest: false, strict: false, json: false, models: null, catalog: null, site: 'http://localhost:8787', maxPrice: 5,
  });
  assert.throws(() => parseArgs(['--nope']), /unknown option --nope/);
  assert.throws(() => parseArgs(['--models']), /--models needs a value/);
  assert.throws(() => parseArgs(['--max-price', 'cheap']), /--max-price needs a number/);
  assert.throws(() => parseArgs(['--json', '--live']), /--json works with the catalog check only/);
  assert.throws(() => parseArgs(['--dry-run']), /only applies to --live/);
});

// ---- Live-mode judging (no network) ----------------------------------------------------------------------------------

const tok = (text, probs = true) => ({ type: 'token', text, logprob: probs ? -0.1 : null, top: probs ? [{ text, logprob: -0.1 }] : null });
const done = (completion, cost) => ({ type: 'done', usage: { prompt: 20, completion }, cost, finish: 'length' });

test('liveSkips: catalog FAILs are skipped, labelled by why', () => {
  const s = liveSkips([{ id: 'a', level: 'FAIL', available: false }, { id: 'b', level: 'FAIL', available: true }, { id: 'c', level: 'WARN', available: true }]);
  assert.deepEqual([...s], [['a', 'skipped: retired on OpenRouter'], ['b', 'skipped: failed the catalog check']]);
});
test('liveTries and estimateLiveCost: logprobs models are probed several times and the estimate counts every probe', () => {
  const lp = model({ logprobs: true, price: { in: 1, out: 2 } });
  const plain = model({ price: { in: 1, out: 2 } });
  assert.equal(liveTries(lp), 3);
  assert.equal(liveTries(plain), 1);
  const one = (20 * 1 + 5 * 2) / 1e6;
  assert.ok(Math.abs(estimateLiveCost([lp, plain]) - 4 * one) < 1e-12);
  // The simulated-autocomplete model also carries the Worker's frame and examples in every prompt.
  assert.ok(Math.abs(estimateLiveCost([{ ...plain, endpoint: 'completion' }]) - (220 * 1 + 5 * 2) / 1e6) < 1e-12);
  assert.equal(liveBody(plain).topLogprobs, 0);
  assert.equal(liveBody(model({ upstream: { extra: { reasoning: { effort: 'minimal' } } } })).maxTokens, 16);
});
test('judgeLive: token count comes from done.usage, not from the number of text chunks', () => {
  const plain = model();
  const j = judgeLive(plain, [tok(' a CT scan', false), done(5, 0.000002)]);
  assert.equal(j.tokens, 5);
  assert.deepEqual(j.findings, []);
  const lp = model({ logprobs: true });
  assert.match(judgeLive(lp, [tok(' a', false), done(1, 0)]).findings[0].text, /without probabilities/);
  assert.match(judgeLive(plain, [{ type: 'error', message: 'boom' }, done(0, 0)]).findings[0].text, /"boom"/);
  assert.equal(judgeLive(plain, [tok(' a', false)]).findings[0].level, 'WARN');
});
test('combineTries: one probe without probabilities fails the model; a dropped request is one FAIL with a plain hint', () => {
  const lp = model({ logprobs: true });
  const good = judgeLive(lp, [tok(' a'), done(1, 0.000001)]);
  const bad = judgeLive(lp, [tok(' a', false), done(1, 0.000001)]);
  const ok = combineTries(lp, [good, good, good]);
  assert.deepEqual([ok.level, ok.replies, ok.withProbs], ['OK', 3, 3]);
  assert.ok(Math.abs(ok.cost - 0.000003) < 1e-12);
  const mixed = combineTries(lp, [good, bad]);
  assert.deepEqual([mixed.level, mixed.withProbs, mixed.findings.length], ['FAIL', 1, 1]);
  const dropped = combineTries(lp, [], { httpStatus: 0, message: 'No answer within 60 seconds.' });
  assert.equal(dropped.level, 'FAIL');
  assert.equal(dropped.cost, null);
  assert.match(dropped.findings[0].text, /^No answer within 60 seconds\. The site or the model did not respond/);
  assert.match(liveHttpFinding({ httpStatus: 502, message: 'x' }).text, /^HTTP 502: x\. OpenRouter or its provider turned/);
  assert.match(liveHttpFinding({ httpStatus: 502, message: 'Try again in a moment.' }).text, /moment\. OpenRouter/);
});
