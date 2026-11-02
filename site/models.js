export const LIMITS = { promptChars: 200, systemChars: 400, prefixChars: 1500, maxTokens: 200, topLogprobs: 10, temperatureMax: 1.5 };

/** `exactTokenizer`: the vendored encoding (`tokenizer`) is the model's own, so the tokens chapter is exact rather than an
 *  o200k approximation. Only ever true for OpenAI models whose encoding is known.
 *  `upstream` (optional): per-model request shaping applied by the Worker, `{ omit?: string[], extra?: object }`. `omit` lists
 *  body keys the provider rejects; `extra` is shallow-merged over the body.
 *  Prices are USD per million tokens. For models routed with `require_parameters`, they are the cheapest provider that
 *  actually returns probabilities, not OpenRouter's headline price. `npm run check:models` flags drift. */
const deepFreeze = (o) => { for (const v of Object.values(o)) if (v && typeof v === 'object') deepFreeze(v); return Object.freeze(o); };

// Without this, OpenRouter routes to the cheapest provider even when it silently drops `logprobs` (DeepInfra and Groq do
// for Llama), and the probability chapters show no bars. With it, only providers that honour every sent parameter qualify.
const LOGPROB_PROVIDERS_ONLY = { extra: { provider: { require_parameters: true } } };

export const MODELS = Object.freeze([
  { id: 'openai/gpt-3.5-turbo-0613', label: 'ChatGPT 3.5 (2023)', short: 'GPT-3.5', year: 2023, provider: 'OpenAI', exactTokenizer: true, open: false, logprobs: true, endpoint: 'chat', tokenizer: 'cl100k', bucket: 'default', price: { in: 1, out: 2 },
    blurb: 'The June 2023 version of the model behind ChatGPT.' },
  { id: 'openai/gpt-4', label: 'GPT-4 (2023)', short: 'GPT-4', year: 2023, provider: 'OpenAI', exactTokenizer: true, open: false, logprobs: true, endpoint: 'chat', tokenizer: 'cl100k', bucket: 'gpt4', price: { in: 30, out: 60 },
    blurb: 'The 2023 frontier model. Still expensive: 100 to 200 times the price of GPT-4o mini.' },
  { id: 'openai/gpt-4o-mini', label: 'GPT-4o mini (2024)', short: 'GPT-4o mini', year: 2024, provider: 'OpenAI', exactTokenizer: true, open: false, logprobs: true, endpoint: 'chat', tokenizer: 'o200k', bucket: 'default', price: { in: 0.15, out: 0.6 },
    blurb: 'A small, cheap modern model that still shows its probabilities.' },
  { id: 'openai/gpt-5-nano', label: 'GPT-5 nano (2025)', short: 'GPT-5 nano', year: 2025, provider: 'OpenAI', exactTokenizer: true, open: false, logprobs: false, endpoint: 'chat', tokenizer: 'o200k', bucket: 'default', price: { in: 0.05, out: 0.4 },
    // Reasoning model: rejects `temperature`, and without minimal effort it can spend the whole max_tokens thinking and return no text.
    upstream: { omit: ['temperature'], extra: { reasoning: { effort: 'minimal' } } },
    blurb: 'The smallest GPT-5. A reasoning model: it can think before it writes. Does not share its probabilities.' },
  { id: 'openai/gpt-6-luna', label: 'GPT-6 Luna (2026)', short: 'GPT-6 Luna', year: 2026, provider: 'OpenAI', exactTokenizer: false, open: false, logprobs: false, endpoint: 'chat', tokenizer: 'o200k', bucket: 'default', price: { in: 0.1, out: 0.5 },
    // Same reasoning-model shaping as GPT-5 nano. Its tokenizer is not published, so the tokens chapter approximates it.
    upstream: { omit: ['temperature'], extra: { reasoning: { effort: 'minimal' } } },
    blurb: 'OpenAI\'s current small model. Cheaper than ChatGPT 3.5 was. Does not share its probabilities.' },
  { id: 'anthropic/claude-haiku-5.5', label: 'Claude Haiku 5.5 (2026)', short: 'Haiku 5.5', year: 2026, provider: 'Anthropic', exactTokenizer: false, open: false, logprobs: false, endpoint: 'chat', tokenizer: 'o200k', bucket: 'default', price: { in: 0.1, out: 0.5 },
    // No provider accepts `temperature` for this model.
    upstream: { omit: ['temperature'] },
    blurb: 'Anthropic\'s fast model. Does not share its probabilities.' },
  { id: 'google/gemini-3.5-flash-lite', label: 'Gemini 3.5 Flash Lite (2026)', short: 'Gemini Flash Lite', year: 2026, provider: 'Google', exactTokenizer: false, open: false, logprobs: false, endpoint: 'chat', tokenizer: 'o200k', bucket: 'default', price: { in: 0.3, out: 2.5 },
    blurb: 'Google\'s fast model. Does not share its probabilities.' },
  { id: 'meta-llama/llama-3.3-70b-instruct', label: 'Llama 3.3 70B (open weights, 2024)', short: 'Llama 3.3', year: 2024, provider: 'Meta', exactTokenizer: false, open: true, logprobs: true, endpoint: 'chat', tokenizer: 'o200k', bucket: 'default', price: { in: 0.135, out: 0.4 },
    upstream: LOGPROB_PROVIDERS_ONLY,
    blurb: 'Open weights: anyone can download and run it. Uses its own tokenizer, so token counts differ.' },
  { id: 'google/gemma-4-26b-a4b-it', label: 'Gemma 4 26B (open weights, 2026)', short: 'Gemma 4', year: 2026, provider: 'Google', exactTokenizer: false, open: true, logprobs: true, endpoint: 'chat', tokenizer: 'o200k', bucket: 'default', price: { in: 0.024, out: 0.1 },
    upstream: LOGPROB_PROVIDERS_ONLY,
    blurb: 'A current open-weights model from Google, small enough to run on one good graphics card. Shares its probabilities.' },
  // Chapter 5's left pane only (`picker: false`): the Worker's frame and leading-space repair assume a fresh run from the
  // prompt, and Step/Fork in other chapters would split words where the model's last token ended.
  { id: 'meta-llama/llama-3.1-8b-instruct', label: 'Llama 3.1 8B (simulated autocomplete)', short: 'Llama 3.1 8B', year: 2024, provider: 'Meta', exactTokenizer: false, open: true, logprobs: true, endpoint: 'completion', tokenizer: 'o200k', bucket: 'default', price: { in: 0.02, out: 0.05 },
    picker: false, upstream: LOGPROB_PROVIDERS_ONLY,
    blurb: 'A small chat model told to act like the old autocomplete models: it continues your text instead of answering it.' },
].map(deepFreeze));

export const DEFAULT_MODEL = 'openai/gpt-4o-mini';
/** Chapter 5's left pane. The pure autocomplete models (GPT-3, gpt-3.5-turbo-instruct) are retired, so this is a chat model
 *  that the Worker frames as a text-continuation engine (see buildUpstream). */
export const AUTOCOMPLETE_MODEL = 'meta-llama/llama-3.1-8b-instruct';

export function getModel(id) { return MODELS.find(m => m.id === id); }

/** Era label for a model picker's optgroups. Open-weights models get their own group regardless of year. */
export function eraGroup(model) {
  if (model.open) return 'Open weights';
  if (model.year <= 2023) return 'Early (2023)';
  if (model.year === 2024) return 'Recent (2024)';
  return 'Current (2025–2026)';
}

/** Estimated USD for a call when the upstream did not report cost. Missing or invalid token counts count as 0. */
export function estimateCost(model, promptTokens, completionTokens) {
  return ((Number(promptTokens) || 0) * model.price.in + (Number(completionTokens) || 0) * model.price.out) / 1e6;
}
