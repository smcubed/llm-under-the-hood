# LLM Under the Hood: Handoff

## Links

| What | Where |
|---|---|
| Live site | https://llm-under-the-hood.smcgrath.workers.dev |
| Repository | https://github.com/smcubed/llm-under-the-hood |
| Cloudflare dashboard | https://dash.cloudflare.com, then Workers & Pages, then `llm-under-the-hood` (logs, versions, rollback) |
| OpenRouter spend | https://openrouter.ai/activity |
| Local project | `~/Desktop/UC Davis AI course/llm-under-the-hood/` |
| Design doc | [`docs/plans/2026-09-14-llm-under-the-hood-design.md`](docs/plans/2026-09-14-llm-under-the-hood-design.md) |
| Build plan | [`docs/plans/2026-09-14-llm-under-the-hood.md`](docs/plans/2026-09-14-llm-under-the-hood.md) |

## Three things left for you (about 5 minutes)

The site is deployed but has no secrets yet. Until you set them, the passcode step shows
"Server is not configured." and nothing else works, so a student who finds the link early
sees a closed door, not an error page.

Run each command from the project folder. Each one prompts you to paste a value; the value
is never shown or stored on your machine.

```bash
cd ~/Desktop/"UC Davis AI course"/llm-under-the-hood
```

1. Your OpenRouter API key (from https://openrouter.ai/settings/keys):

```bash
npx wrangler secret put OPENROUTER_API_KEY
```

2. The class passcode. Pick something short that you can say out loud in class:

```bash
npx wrangler secret put PASSCODE
```

3. A cookie-signing secret. Any long random string works. This prints one you can paste:

```bash
openssl rand -hex 32
```

```bash
npx wrangler secret put COOKIE_SECRET
```

No redeploy is needed. The Worker picks up secrets on the next request.

### Verify

1. Open https://llm-under-the-hood.smcgrath.workers.dev and enter the passcode.
2. Leave the model on GPT-4o mini and press Run with the default prompt
   ("The patient presented with chest pain and").
3. Chapter 4 should show bars for the next token, and chapters 5 and 6 should stream text.
   If you see "Server is not configured." one of the three secrets is missing; if you see
   "The model provider returned an error", the OpenRouter key is wrong or has no credit.

### Verify each model once

Same prompt, "The patient presented with chest pain and", once per model. Ten minutes total
and well under a dollar.

- [ ] gpt-3.5-turbo-instruct: bars appear; the continuation reads as a sentence continuation, not an answer; Fork works.
- [ ] gpt-3.5-turbo, gpt-4, gpt-4o-mini, llama-3.3-70b: bars appear; confidence coloring present; token counts and cost shown.
- [ ] claude-haiku-4.5, gpt-5-mini, gemini-3.5-flash-lite: the "does not share probabilities" card appears; streaming works.
- [ ] Compare (chapter 6): three panes stream at the same time; costs match the OpenRouter activity page within rounding.
- [ ] Budget message: from the project folder run `npx wrangler deploy --var GPT4_DAILY_BUDGET_USD:0.0001`, run GPT-4 once, confirm the pane shows "Today's class budget for GPT-4 is used up", then run `npm run deploy` to restore the real value.
- [ ] Wrong passcode 11 times within a minute shows "Too many attempts. Wait a minute and try again."

Write the date and anything odd under "Verified" at the bottom of this file.

## Sending it to students

Suggested Canvas note (edit freely; the full page text is in
[`docs/canvas-page.md`](docs/canvas-page.md)):

> This week we look inside a language model. Open
> https://llm-under-the-hood.smcgrath.workers.dev and enter the passcode **PASSCODE**.
> Type a short prompt and watch it move through tokens, embeddings, attention, and
> next-token probabilities, then compare models from 2022 to today.
>
> One rule: no patient information of any kind. Everything you type goes to a commercial
> model provider. Use made-up cases only.
>
> Three things to try:
> 1. Tokenize a long drug name (for example "acetaminophen-hydrocodone") in chapter 1 and report how many tokens it became.
> 2. In chapter 4, fork one sentence three different ways by picking a different token at the same step. Describe in two sentences how the meaning changed.
> 3. In chapter 6, compare GPT-3.5, Claude Haiku, and Llama on the prompt "Cite one peer-reviewed paper showing aspirin prevents migraines." Note which models invented a paper.

Each student can run about 30 requests a minute. The whole class shares a $5 daily budget,
plus a separate $1 for GPT-4. Fifteen students doing the three exercises costs well under a dollar.

## Changing things later

All commands run from the project folder.

| Change | Do this |
|---|---|
| Change the passcode | `npx wrangler secret put PASSCODE`. Students who already signed in stay signed in for up to 30 days. To sign everyone out at once, also run `npx wrangler secret put COOKIE_SECRET` with a new value. |
| Swap or add a model | Edit `site/models.js` (fields below). Check the id and the "Supported parameters" list on https://openrouter.ai/models; a model shows bars only if that list includes `logprobs`. Then `npm test && npm run deploy`. |
| Change budgets or limits | Edit `vars` in `wrangler.jsonc`, then `npm run deploy`. `DAILY_BUDGET_USD` (shared, default 5), `GPT4_DAILY_BUDGET_USD` (GPT-4 only, default 1), `PER_CLIENT_PER_MINUTE` (per student, 30), `PER_IP_PER_MINUTE` (per network address, 60), `AUTH_ATTEMPTS_PER_MINUTE` (wrong passcodes, 10). |
| Edit the text of the page | Edit `site/index.html`, then `npm run deploy`. |
| Rebuild the word map | `npm run data:embeddings` (first run downloads a 23 MB model). Edit `tools/vocabulary.txt` first to add words. |
| Rebuild the attention data | One-time setup: `python3 -m venv .venv && .venv/bin/pip install -r tools/requirements.txt`. Then `npm run data:attention`. |
| Run locally | `cp .dev.vars.example .dev.vars` once. Then `npm run mock` in one terminal and `npm run dev` in another. Open http://127.0.0.1:8787 and use the passcode `test`. The mock answers instead of OpenRouter, so it costs nothing. `MOCK_TOKEN_MS=400 npm run mock` slows the stream down to watch Pause and Stop. |
| Run tests | `npm test` |
| Redeploy | `git add -A && git commit -m "..." && git push && npm run deploy` |

Fields in `site/models.js`, one line each:

- `id`: the OpenRouter model id, exactly as listed on openrouter.ai/models.
- `label`, `short`, `year`, `provider`, `blurb`: what students see in the picker and captions.
- `logprobs`: `true` if OpenRouter lists `logprobs` under supported parameters; otherwise the chapters show the "does not share probabilities" card.
- `endpoint`: `chat` for nearly everything; `completion` only for the old text-completion model (GPT-3.5 Instruct).
- `tokenizer`: which vendored tokenizer to show, `o200k` or `cl100k`.
- `exactTokenizer`: `true` only for OpenAI models, where that tokenizer is the real one; `false` shows an approximation note.
- `open`: `true` for open-weights models (they get their own group in the picker).
- `bucket`: `default` shares the $5 budget; `gpt4` uses the separate $1 budget. Use `gpt4` for anything else expensive.
- `price`: USD per million tokens, `in` and `out`, copied from the OpenRouter model page. Used to estimate cost when the provider does not report it.

## Reading spend

- https://openrouter.ai/activity is the source of truth. It lists every request with model and cost.
- The Worker keeps only today's and yesterday's totals per bucket, to enforce the caps. It is not a log.
- When the shared budget is hit, students see "Today's class budget is used up. Please come back tomorrow."
  When only the GPT-4 budget is hit: "Today's class budget for GPT-4 is used up. Try a cheaper model or come back tomorrow."
- Budgets reset at midnight UTC, which is 5 pm Pacific in winter and 4 pm in summer.
  A class that runs past that hour gets a fresh budget mid-session.
- To raise a cap for one day: `npx wrangler deploy --var DAILY_BUDGET_USD:10`, then `npm run deploy` later to go back.

## Known limits

- Claude, Gemini, and GPT-5 models do not share probabilities. Chapters 4 through 6 show a card saying so and stream text only.
- Token counts for Llama, Claude, and Gemini are approximate. The page shows OpenAI's o200k tokenizer with a note; only OpenAI models are exact.
- The 2-D word map (chapter 2) is a flattening of 384 dimensions from a small sentence-embedding model (all-MiniLM-L6-v2). It is not the LLM's own embedding space, and the caption says so.
- The attention arcs (chapter 3) come from GPT-2 on two fixed sentences, computed once and stored. They are not live.
- Rate limits are per signed-in browser (30 a minute) and per network address (60 a minute). A classroom behind one campus address shares the 60. If students see "Too many requests from this network", raise `PER_IP_PER_MINUTE` in `wrangler.jsonc` and redeploy.
- GPT-4 costs about 100 times GPT-4o mini per token. That is why it has its own $1 cap.
- Budgets can overshoot by one request: the Worker reserves the estimated cost before calling the provider and settles up after, so a request that starts just under the cap finishes.
- The repository is public. That is fine: secrets live only in Cloudflare and in the ignored `.dev.vars` file. Do not commit `.dev.vars`.

## Verified on 2026-09-14 (local, mock upstream)

Checked in the browser against the local mock (`npm run mock` and `npm run dev`), not against real models:

- All six chapters render and respond to the default prompt and to typed prompts: tokens, word map, attention arcs, next-token bars with temperature and Fork, autocomplete vs. assistant, and the three-pane era comparison.
- Streaming, Pause, Resume, Stop, "Stop all", Retry, and the alternatives popover.
- Dark mode (system setting) and a 375 px wide phone layout.
- Keyboard basics: Tab through controls, Enter and Space on token chips, Escape closes a popover.
- Zero console errors.
- `npm test`: 223 tests pass.
- Deployed Worker: `/` 200, `/robots.txt` 200, `/.dev.vars` 404, and every `/api/*` route returns 500 "Server is not configured." as designed before the secrets exist.

Not yet verified: real OpenRouter models (needs the secrets; see "Verify each model once" above).
