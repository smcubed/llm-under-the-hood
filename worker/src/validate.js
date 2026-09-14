import { getModel, LIMITS } from '../../site/models.js';

const clamp = (n, lo, hi, dflt) => {
  const x = typeof n === 'number' && Number.isFinite(n) ? n : dflt;
  return Math.min(hi, Math.max(lo, x));
};
const bad = (message) => ({ ok: false, status: 400, message });

export function validateGenerate(body) {
  if (!body || typeof body !== 'object') return bad('Request body must be an object.');
  const model = getModel(body.model);
  if (!model) return bad('That model is not available here.');
  if (typeof body.prompt !== 'string' || !body.prompt.trim()) return bad('Please type a prompt first.');
  if (body.prompt.length > LIMITS.promptChars) return bad(`Prompts are limited to ${LIMITS.promptChars} characters.`);
  const system = body.system == null ? '' : body.system;
  const prefix = body.prefix == null ? '' : body.prefix;
  if (typeof system !== 'string' || system.length > LIMITS.systemChars) return bad(`System prompts are limited to ${LIMITS.systemChars} characters.`);
  if (typeof prefix !== 'string' || prefix.length > LIMITS.prefixChars) return bad('That continuation is too long to fork from.');
  return {
    ok: true,
    value: {
      model,
      prompt: body.prompt,
      system,
      prefix,
      maxTokens: Math.round(clamp(body.maxTokens, 1, LIMITS.maxTokens, 120)),
      temperature: clamp(body.temperature, 0, LIMITS.temperatureMax, 0.7),
      topLogprobs: model.logprobs ? Math.round(clamp(body.topLogprobs, 0, LIMITS.topLogprobs, 5)) : 0,
      stream: body.stream !== false,
    },
  };
}
