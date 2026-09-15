export const LIMITS = { promptChars: 200, systemChars: 400, prefixChars: 1500, maxTokens: 200, topLogprobs: 10, temperatureMax: 1.5 };

/** `exactTokenizer`: the vendored encoding (`tokenizer`) is the model's own, so the tokens chapter is exact rather than an
 *  o200k approximation. True only for OpenAI models. */
export const MODELS = Object.freeze([
  { id: 'openai/gpt-3.5-turbo-instruct', label: 'GPT-3.5 Instruct (autocomplete)', short: 'GPT-3.5 instruct', year: 2022, provider: 'OpenAI', exactTokenizer: true, open: false, logprobs: true, endpoint: 'completion', tokenizer: 'cl100k', bucket: 'default', price: { in: 1.5, out: 2.0 },
    blurb: 'A completion model from before ChatGPT. It does not answer you; it continues your text.' },
  { id: 'openai/gpt-3.5-turbo', label: 'ChatGPT 3.5 (2023)', short: 'GPT-3.5', year: 2023, provider: 'OpenAI', exactTokenizer: true, open: false, logprobs: true, endpoint: 'chat', tokenizer: 'cl100k', bucket: 'default', price: { in: 0.5, out: 1.5 },
    blurb: 'The model behind the original ChatGPT launch.' },
  { id: 'openai/gpt-4', label: 'GPT-4 (2023)', short: 'GPT-4', year: 2023, provider: 'OpenAI', exactTokenizer: true, open: false, logprobs: true, endpoint: 'chat', tokenizer: 'cl100k', bucket: 'gpt4', price: { in: 30, out: 60 },
    blurb: 'The first frontier model. Still expensive: about 100× the price of GPT-4o mini.' },
  { id: 'openai/gpt-4o-mini', label: 'GPT-4o mini (2024)', short: 'GPT-4o mini', year: 2024, provider: 'OpenAI', exactTokenizer: true, open: false, logprobs: true, endpoint: 'chat', tokenizer: 'o200k', bucket: 'default', price: { in: 0.15, out: 0.6 },
    blurb: 'A small, cheap modern model that still shows its probabilities.' },
  { id: 'anthropic/claude-haiku-4.5', label: 'Claude Haiku 4.5 (2025)', short: 'Haiku 4.5', year: 2025, provider: 'Anthropic', exactTokenizer: false, open: false, logprobs: false, endpoint: 'chat', tokenizer: 'o200k', bucket: 'default', price: { in: 1, out: 5 },
    blurb: 'Anthropic\'s fast model. Does not share its probabilities.' },
  { id: 'openai/gpt-5-mini', label: 'GPT-5 mini (2026)', short: 'GPT-5 mini', year: 2026, provider: 'OpenAI', exactTokenizer: true, open: false, logprobs: false, endpoint: 'chat', tokenizer: 'o200k', bucket: 'default', price: { in: 0.25, out: 2 },
    blurb: 'A current small OpenAI model. Does not share its probabilities.' },
  { id: 'google/gemini-3.5-flash-lite', label: 'Gemini 3.5 Flash Lite (2026)', short: 'Gemini Flash Lite', year: 2026, provider: 'Google', exactTokenizer: false, open: false, logprobs: false, endpoint: 'chat', tokenizer: 'o200k', bucket: 'default', price: { in: 0.3, out: 2.5 },
    blurb: 'Google\'s fast model. Does not share its probabilities.' },
  { id: 'meta-llama/llama-3.3-70b-instruct', label: 'Llama 3.3 70B (open weights)', short: 'Llama 3.3', year: 2024, provider: 'Meta', exactTokenizer: false, open: true, logprobs: true, endpoint: 'chat', tokenizer: 'o200k', bucket: 'default', price: { in: 0.1, out: 0.32 },
    blurb: 'Open weights: anyone can download and run it. Uses its own tokenizer, so token counts differ.' },
].map(m => Object.freeze({ ...m, price: Object.freeze({ ...m.price }) })));

export const DEFAULT_MODEL = 'openai/gpt-4o-mini';
export const AUTOCOMPLETE_MODEL = 'openai/gpt-3.5-turbo-instruct';

export function getModel(id) { return MODELS.find(m => m.id === id); }

/** Estimated USD for a call when the upstream did not report cost. Missing or invalid token counts count as 0. */
export function estimateCost(model, promptTokens, completionTokens) {
  return ((Number(promptTokens) || 0) * model.price.in + (Number(completionTokens) || 0) * model.price.out) / 1e6;
}
