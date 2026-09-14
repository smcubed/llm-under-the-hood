# LLM Under the Hood — Design

**Date:** 2026-09-14
**Owner:** Scott McGrath (MHI 289A, Intro to AI for Clinical Students, UC Davis; reusable in other courses)
**Status:** Approved by Scott 2026-09-14 (approach A, name `llm-under-the-hood`)

## 1. Purpose

An interactive, visual explainer of how a large language model turns a prompt into text.
Students type one short prompt and watch it move through the model's stages, then compare
how models from different eras answer the same thing. Tone and depth sit between the
Financial Times "Generative AI explained" piece (narrative, illustrative) and Georgia Tech's
Transformer Explainer (real internals, too technical for this audience).

Audience: clinical and non-clinical graduate students with no ML background. Used mostly
for self-study on students' own laptops, sometimes projected in lecture.

Success looks like: a student can explain, in their own words, that (1) text is chopped into
tokens, (2) the model predicts one next token at a time from probabilities, (3) sampling
and temperature mean the same prompt can give different answers, (4) the model sounds just
as fluent when it is guessing, and (5) newer and chat-tuned models behave differently from
older autocomplete-style models.

## 2. Decisions already made

| Question | Decision |
|---|---|
| Setting | Both lecture and self-study, weighted to self-study. Class passcode. |
| Depth | Real tokens and real next-token probabilities from the chosen model. Embeddings and attention shown with precomputed real data on fixed examples, animated illustratively for the student's prompt. No in-browser model. |
| Hosting | One Cloudflare Worker (static assets + one API route), new GitHub repo under `smcubed`. |
| Models | Era ladder, cheap tier only (no Opus/Fable-class models). |
| Shape | A: scrollytelling chapters with a pinned pipeline strip for navigation. |
| Name | `llm-under-the-hood`; page title "LLM Under the Hood". |

## 3. Constraints and facts that shape the design

- OpenRouter exposes `logprobs`/`top_logprobs` for OpenAI legacy models (gpt-3.5-turbo-instruct,
  gpt-3.5-turbo, gpt-4, gpt-4o, gpt-4o-mini), Llama 3.1/3.3, gpt-oss, DeepSeek, Mistral Small,
  some Qwen. It does **not** for Anthropic, Google, or the gpt-5 family. Probability views must
  degrade gracefully for those models.
- No hosted API exposes embeddings-of-tokens-in-context or attention weights. Those chapters
  use data precomputed once at build time and shipped as JSON.
- gpt-4 costs $30/$60 per million tokens; everything else on the ladder is ≤ $5/M output.
  With a 200-character prompt and 200-token output cap, a gpt-4 call is about one cent.
- Students must never enter PHI. Same banner and fictional-cases-only policy as the Week 5 lab.
- Wrangler is authenticated (smcgrath@berkeley.edu); `gh` is authenticated as `smcubed`.
- No build step for the frontend, matching the course survey project. Tests via `node --test`
  and Cloudflare's vitest pool for the Worker.

## 4. User experience

### 4.1 Entry
- Passcode screen (class code). On success the Worker sets a signed, HttpOnly cookie valid
  for 30 days; the passcode itself is never sent again.
- Landing: title, one-paragraph framing, a **prompt box limited to 200 characters**, a model
  picker defaulting to `openai/gpt-4o-mini` (cheap, returns probabilities), and 6–8 suggested
  starter prompts (fictional clinical and everyday), e.g. "The patient presented with chest
  pain and", "What is the first-line treatment for hypertension?", "My grandmother's
  favorite recipe was". Below: a no-PHI notice.
- A **pinned pipeline strip** (Tokens → Numbers → Attention → Predict → Assistant → Compare)
  highlights the current chapter and jumps on click. Useful for projection.

### 4.2 Chapters
The student's prompt (or the default example if they have not typed one) threads through
every chapter. Each chapter is one screen-ish of scroll: short heading, 2–4 sentences of
plain prose, the visual, and a "try this" nudge.

1. **Words become tokens.** Live client-side tokenization (vendored `gpt-tokenizer`, o200k/cl100k
   encodings). Tokens rendered as colored chips; multi-token words such as "hyponatremia"
   visibly splinter. A caption states the count from the tokenizer and, after the first API
   call, the prompt-token count the chosen model actually reported, with a one-line note that
   different models slice text differently. Teaching point: the model never sees words or
   letters, only token IDs.
2. **Tokens become numbers.** A 2D scatter map of ~300 words (common English + clinical
   vocabulary) from real embeddings computed once at build time (`tools/build_embeddings.mjs`,
   OpenRouter embeddings endpoint or a local model, projected with PCA to 2D), shipped as
   `site/data/embeddings.json`. Any of the student's tokens that appear in the vocabulary
   light up. Hover shows nearest neighbors. Teaching point: meaning becomes geometry;
   "warfarin" lands near "heparin".
3. **Every word looks at the others.** Two fixed clinical sentences with real attention
   patterns precomputed from a small open model (e.g. GPT-2 or Qwen-0.5B via a build-time
   Python/Node script) and stored as `site/data/attention.json`, showing e.g. "it" → "medication",
   "her" → "patient". Arc strength = attention weight. For the student's own prompt only an
   honest illustrative animation is shown: each token fanning lines to every earlier token,
   no invented weights, with a caption saying so.
4. **Pick the next word.** The core chapter.
   - One call with `max_tokens: 1, top_logprobs: 10` returns the top candidates; shown as a
     horizontal bar chart of probabilities that animates in.
   - **Temperature slider** (0 → 1.5) reshapes the bars live (client-side softmax rescaling
     of the returned logprobs) and a "roll" button samples a token with visible dice.
   - **Keep going** streams the continuation token by token (`stream: true, logprobs: true,
     top_logprobs: 5`). Each arriving token appends to the sentence; a side panel shows the
     alternatives it considered at that step. Pause / step controls.
   - **Fork**: clicking an alternative token truncates the output there, substitutes the
     alternative, and continues from that new prefix (a new API call).
   - **Confidence coloring**: output tokens tinted from confident to uncertain by their
     probability; toggle on/off. Caption: the model is equally fluent when guessing, which
     is exactly what a hallucination looks like from the inside.
   - For models without probabilities: bars replaced by a plain card "This model does not
     share its probabilities," continuation still streams, confidence coloring disabled.
5. **From autocomplete to assistant.** Two panes: `gpt-3.5-turbo-instruct` (raw completion,
   just continues the text) vs the chosen chat model (answers). A **system prompt toggle**
   with two presets ("You are a nurse educator. Answer at a sixth-grade reading level." and
   "You are a terse clinical decision support tool. Bullet points only.") plus a free field,
   re-run shows how framing shifts the answer and, where available, the first-token
   probabilities. Ties to Week 2 / Week 5 prompt engineering.
6. **Compare the eras.** Pick up to three models from the ladder; same prompt (and optional
   system prompt) streams side by side. Each pane shows release year, provider, open/closed,
   latency, prompt/output token counts, and actual cost for that call (OpenRouter
   `usage.include`). Hovering an output token on a probability-capable model shows its
   alternatives. Suggested comparison prompts that expose era differences (a factual question
   with a hallucination trap, a recent-events question, a multi-step reasoning question).

### 4.3 Model ladder (config, `site/models.js`)
| Era | OpenRouter id | Label | Probabilities | Notes |
|---|---|---|---|---|
| 2022 | `openai/gpt-3.5-turbo-instruct` | GPT-3.5 (autocomplete) | yes | completion endpoint |
| 2023 | `openai/gpt-3.5-turbo` | ChatGPT (2023) | yes | |
| 2023 | `openai/gpt-4` | GPT-4 (2023) | yes | daily cap, cost badge |
| 2024 | `openai/gpt-4o-mini` | GPT-4o mini | yes | **default** |
| 2025 | `anthropic/claude-haiku-4.5` | Claude Haiku 4.5 | no | |
| 2026 | `openai/gpt-5-mini` | GPT-5 mini | no | |
| 2026 | `google/gemini-3.5-flash-lite` | Gemini 3.5 Flash Lite | no | |
| open | `meta-llama/llama-3.3-70b-instruct` | Llama 3.3 70B (open weights) | yes | |

Each entry: id, label, year, provider, open-weights flag, `supportsLogprobs`, `endpoint`
(`chat` or `completion`), per-call `maxTokens` override, optional `dailyCap`. The Worker
holds the same allowlist; ids not in it are rejected.

## 5. Architecture

```
browser (static site)  ──POST /api/auth──▶  Cloudflare Worker  ──▶ OpenRouter
                        ──POST /api/generate─▶  (assets + API)     /chat/completions
                                                                 /completions
                                          KV: counters (rate limit, daily spend)
                                          Secrets: OPENROUTER_API_KEY, PASSCODE, COOKIE_SECRET
```

- **Single Worker** with static assets binding serving `site/`; routes under `/api/*` handled
  in `worker/src/index.js`. One `wrangler deploy` publishes both. URL:
  `https://llm-under-the-hood.<account>.workers.dev` (custom domain optional later).
- **`POST /api/auth`** `{passcode}` → 204 + `Set-Cookie: sess=<HMAC-signed expiry>`; wrong code
  → 401 after a small constant delay; 10 attempts/IP/hour.
- **`POST /api/generate`** `{model, prompt, system?, messages?, maxTokens, temperature,
  topLogprobs, stream}` → validated, mapped to OpenRouter chat or completion request, response
  streamed through as SSE (or JSON when `stream:false`). Adds `usage: {include: true}`.
  Returns a normalized event shape so the frontend does not care about chat vs completion:
  `{type:"token", text, logprob, top:[{text,logprob}]}`, `{type:"done", usage, cost, latencyMs}`,
  `{type:"error", message}`.
- **Guards** (all server-side, mirrored client-side for UX): model allowlist; prompt ≤ 200
  chars, system ≤ 400 chars, forked prefix ≤ 1,500 chars; `maxTokens` ≤ 200; `topLogprobs` ≤ 10;
  temperature 0–1.5; per-cookie 30 requests/min; global daily spend ceiling (estimated from
  usage, default $5/day) and gpt-4 daily ceiling (default $1/day). Over a cap → 429 with a
  human message the UI displays verbatim ("The class budget for today is used up; try again
  tomorrow or pick a cheaper model").
- **Privacy**: no prompts, outputs, names, or IPs stored. KV holds only counters.
  OpenRouter request sets `X-Title` and no user identifiers.
- **Failure handling**: upstream errors mapped to short plain messages; a model that fails
  is marked unavailable for the session with a retry link; network loss mid-stream keeps
  partial output and shows "connection dropped". The site never shows raw JSON errors.

## 6. Frontend structure

Plain HTML/CSS/JS, ES modules, no bundler. Vendored `gpt-tokenizer` build in `site/vendor/`.

```
site/
  index.html          chapters markup + pinned strip
  styles.css          theme tokens, light/dark
  app.js              boot, passcode gate, prompt state, chapter wiring
  models.js           model ladder config
  api.js              fetch + SSE parsing → normalized events
  tokenize.js         tokenizer wrapper, chip rendering
  probs.js            logprob → probability, temperature rescaling, sampling (pure)
  chapters/
    tokens.js  numbers.js  attention.js  predict.js  assistant.js  compare.js
  data/embeddings.json  data/attention.json
  vendor/gpt-tokenizer.js
worker/
  src/index.js        router, auth, generate, guards
  src/openrouter.js   request building, SSE normalization
  src/limits.js       KV counters
  wrangler.jsonc
tools/
  build_embeddings.mjs   one-off: vocabulary → embeddings.json
  build_attention.py     one-off: two sentences → attention.json (GPT-2 via transformers)
  mock_openrouter.mjs    local fake upstream with canned logprob streams
tests/  (node --test for site/*.js pure modules; vitest-pool-workers for worker/)
docs/plans/
```

State is a small store (prompt, model, system, per-chapter results) with an event emitter;
chapters subscribe and re-render on change. Animations are CSS transitions and small SVG;
no D3. Responsive down to ~400px; light/dark via `prefers-color-scheme`.

## 7. Testing

- **Pure modules** (`probs.js`, `tokenize.js`, event normalization): unit tests with
  `node --test`. Temperature rescaling sums to 1, sampling respects seeds, fork prefix
  assembly is correct for chat vs completion.
- **Worker**: vitest with `@cloudflare/vitest-pool-workers`. Passcode accept/reject and
  cookie signing; allowlist and length caps; rate limit and daily cap behavior with a fake
  KV; chat vs completion request shaping; SSE normalization from recorded OpenRouter fixtures
  for each of: chat with logprobs, chat without logprobs, completion with logprobs.
- **End to end (manual, before handoff)**: run against the mock upstream locally, then one
  real pass per ladder model on the deployed Worker, checking probabilities appear for the
  models that support them and the graceful card appears for those that do not.
- **Cost check**: after the real pass, read OpenRouter's activity page to confirm per-call
  costs match the UI's cost badge within rounding.

## 8. Deployment and handoff

- `npm run dev` (wrangler dev with mock upstream), `npm test`, `npm run deploy` (`wrangler deploy`).
- Scott sets secrets himself: `npx wrangler secret put OPENROUTER_API_KEY`,
  `npx wrangler secret put PASSCODE`, `npx wrangler secret put COOKIE_SECRET`.
- `HANDOFF.md` mirrors the survey project: links, how to change the passcode, how to swap a
  model in `site/models.js`, how to adjust caps in `wrangler.jsonc` vars, how to read spend.
- Canvas: a short page for Week 1 or Week 2 linking the tool with the class passcode, and
  three suggested exercises (tokenize a clinical term; fork a sentence three ways; compare
  GPT-3.5 vs Haiku vs Llama on a hallucination-trap prompt).

## 9. Out of scope (for now)

In-browser models and real attention on arbitrary prompts; saving student work or a
notebook (the Week 5 site already does that); image or multimodal models; a results
dashboard; custom domain; accounts beyond the shared passcode.
