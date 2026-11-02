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

Do this after the secrets are set, and again after any change to `site/models.js`. The first
step is a script; the rest need you in the browser. Unless a step says otherwise, use the
prompt "The patient presented with chest pain and". About fifteen minutes and well under a
dollar, most of it GPT-4.

- [ ] Run `npm run check:models` (free, no key) then `npm run check:models -- --live` (asks for the class passcode; costs a few tenths of a cent, mostly GPT-4). The first compares `site/models.js` with OpenRouter's public model list (ids, prices, whether probabilities are offered); the second sends a tiny request to each model through the live site. Anything it flags, see "When OpenRouter retires a model" below before going on.
- [ ] Autocomplete pane (chapter 5, left). Run these four prompts: "The patient presented with chest pain and"; "What is the first-line treatment for hypertension?"; "Metformin is"; and the first prompt again with the system prompt set to "Nurse educator". Each time the left pane should continue your text, not answer it: the question should run on into more text (more questions, or the start of a document) rather than a reply. The first word should join your text with a space ("and shortness", not "andshortness"). Press Keep going, then Fork at any token: both should pick up where the text stopped, not start over and not switch to answering. With Nurse educator, the left pane should treat the instruction as more text while the right pane follows it. If it answers on more than one of the four, note which under "Verified".
- [ ] GPT-6 Luna, GPT-5 nano, and Gemma 4 each return non-empty text with the max tokens control at 1, 80, and 120. (The two OpenAI ones are reasoning models; if one comes back empty, see "Known limits".)
- [ ] GPT-3.5, GPT-4, GPT-4o mini, Llama 3.3, and Gemma 4 (chapter 4): bars appear, confidence coloring is present, token counts and cost are shown, and each token chip lines up with the streamed text.
- [ ] Llama 3.3 and Gemma 4 show bars every time now. Run each three times. Before this change Llama sometimes showed none; if either now shows an error instead of text, see the `require_parameters` note in "Known limits".
- [ ] GPT-3.5 and GPT-4 (OpenRouter now serves these only through Microsoft Azure): with max tokens at 1, exactly one token comes back; and on "What is the first-line treatment for hypertension?" each gives an answer rather than refusing the clinical question.
- [ ] Claude Haiku 5.5, GPT-5 nano, GPT-6 Luna, and Gemini 3.5 Flash Lite: the "does not share probabilities" card appears and the text streams.
- [ ] Keep going and Fork on GPT-4o mini and Claude Haiku 5.5 continue the sentence rather than starting over.
- [ ] Compare (chapter 6): with the three default picks (GPT-3.5, Claude Haiku 5.5, Llama 3.3), all three panes stream at the same time; costs match the OpenRouter activity page within rounding; no "Too many requests from this network".
- [ ] Budget message: from the project folder run `npx wrangler deploy --var GPT4_DAILY_BUDGET_USD:0.0001`, run GPT-4 once, confirm the pane shows "Today's class budget for GPT-4 is used up", then run `npm run deploy` to restore the real value.
- [ ] Wrong passcode 11 times within a minute shows "Too many attempts. Wait a minute and try again."

Write the date and anything odd under "Verified" at the bottom of this file.

## Sending it to students

Suggested Canvas note (edit freely; the full page text is in
[`docs/canvas-page.md`](docs/canvas-page.md)):

> This week we look inside a language model. Open
> https://llm-under-the-hood.smcgrath.workers.dev and enter the passcode **PASSCODE**.
> Type a short prompt and watch it move through tokens, embeddings, attention, and
> next-token probabilities, then compare models from 2023 to today.
>
> One rule: no patient information of any kind. Everything you type goes to a commercial
> model provider. Use made-up cases only.
>
> Three things to try:
> 1. Tokenize a long drug name (for example "acetaminophen-hydrocodone") in chapter 1 and report how many tokens it became.
> 2. In chapter 4, fork one sentence three different ways by picking a different token at the same step. Describe in two sentences how the meaning changed.
> 3. In chapter 6, compare GPT-3.5, Claude Haiku 5.5, and Llama 3.3 on the prompt "Cite one peer-reviewed paper showing aspirin prevents migraines." Note which models invented a paper.

Each student can run about 30 requests a minute. The whole class shares a $5 daily budget,
plus a separate $1 for GPT-4. Fifteen students doing the three exercises costs well under a dollar.

## Changing things later

All commands run from the project folder.

| Change | Do this |
|---|---|
| Change the passcode | `npx wrangler secret put PASSCODE`. Students who already signed in stay signed in for up to 30 days. To sign everyone out at once, also run `npx wrangler secret put COOKIE_SECRET` with a new value. |
| Swap or add a model | Edit `site/models.js` (fields below). Check the id and the "Supported parameters" list on https://openrouter.ai/models; a model shows bars only if that list includes `logprobs`. Then `npm test && npm run check:models && npm run deploy`, and walk "Verify each model once" for the new model. See also "When OpenRouter retires a model". |
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
- `endpoint`: `chat` for every model but one. `completion` marks the simulated autocomplete model in chapter 5's left pane (Llama 3.1 8B). It does not call a different OpenRouter route: the Worker sends every model to the same chat endpoint, and for `completion` it wraps the student's text in a fixed "continue this text" instruction and two worked examples (`buildUpstream` in `worker/src/openrouter.js`), then adds a space before the first word if the student's text did not end in one.
- `tokenizer`: which vendored tokenizer to show, `o200k` or `cl100k`.
- `exactTokenizer`: `true` only for OpenAI models whose tokenizer is published, where the vendored one is the real one; `false` shows an approximation note. GPT-6 Luna is `false` because OpenAI has not published its tokenizer.
- `open`: `true` for open-weights models (they get their own group in the picker).
- `bucket`: `default` shares the $5 budget; `gpt4` uses the separate $1 budget. Use `gpt4` for anything else expensive.
- `price`: USD per million tokens, `in` and `out`, copied from the OpenRouter model page. Used to estimate cost when the provider does not report it. For models with `require_parameters` (next item), use the price of the cheapest provider that actually returns probabilities, not the headline price; `npm run check:models` flags drift.
- `upstream` (optional): `{ omit: [...], extra: {...} }`. Request fields to drop and fields to add for that model only. GPT-5 nano and GPT-6 Luna use it to drop `temperature` and add `reasoning: { effort: 'minimal' }`; Claude Haiku 5.5 drops `temperature`. Llama 3.3, Gemma 4, and Llama 3.1 8B use `LOGPROB_PROVIDERS_ONLY`, which adds `provider: { require_parameters: true }` so OpenRouter only sends them to providers that honour every parameter sent, including `logprobs`.

Two names at the bottom of `site/models.js` matter too: `DEFAULT_MODEL` (GPT-4o mini, what the picker starts on) and `AUTOCOMPLETE_MODEL` (Llama 3.1 8B, chapter 5's left pane).

## When OpenRouter retires a model

OpenRouter drops old models without much notice, and providers change what they support.
Once a term, before the first class that uses the site:

1. Run `npm run check:models`, then `npm run check:models -- --live`. If both pass, you are done.
2. For each model it flags, pick a replacement on https://openrouter.ai/models (same era or
   role, and `logprobs` in its supported parameters if the old one showed bars), then edit:
   - `site/models.js`: swap the entry (fields above). If the retired model was `DEFAULT_MODEL`
     or `AUTOCOMPLETE_MODEL`, change that line too.
   - `site/chapters/compare.js`, `DEFAULT_PICKS`, if the retired model was one of chapter 6's
     three starting picks.
   - The Canvas text: [`docs/canvas-page.md`](docs/canvas-page.md), the Canvas page itself, and
     the suggested note under "Sending it to students" above, wherever they name the model.
   - The tests: `grep -rn "<old id>" site worker tests` lists every place the old id appears.
3. `npm test`, `npm run check:models -- --live` again, `npm run deploy`, then walk
   "Verify each model once" for the new models.

Worked example, 2026-11-02. OpenRouter no longer listed GPT-3.5 Instruct
(`openai/gpt-3.5-turbo-instruct`) or the original ChatGPT 3.5 (`openai/gpt-3.5-turbo`), and no
pure text-completion models were left at all. Changes made:

- ChatGPT 3.5 became `openai/gpt-3.5-turbo-0613`, the June 2023 snapshot of the same model
  ($1/$2 instead of $0.50/$1.50).
- Chapter 5's autocomplete pane became a simulation on Llama 3.1 8B (see "Known limits").
- Claude Haiku 4.5 was replaced by Claude Haiku 5.5 (a tenth of the price) and GPT-5 mini by
  GPT-6 Luna (a quarter of the output price), with GPT-5 nano and Gemma 4 added.
- Llama 3.3's cheapest provider was quietly dropping probabilities, so the open-weights models
  now use `require_parameters`.
- `DEFAULT_PICKS` changed to GPT-3.5, Claude Haiku 5.5, and Llama 3.3; the chapter 5 and 6
  introductions, the Canvas text, and the tests were updated to match.

## Reading spend

- https://openrouter.ai/activity is the source of truth. It lists every request with model and cost.
- The Worker keeps only today's and yesterday's totals per bucket, to enforce the caps. It is not a log.
- When the shared budget is hit, students see "Today's class budget is used up. Please come back tomorrow."
  When only the GPT-4 budget is hit: "Today's class budget for GPT-4 is used up. Try a cheaper model or come back tomorrow."
- Budgets reset at midnight UTC, which is 4 pm Pacific in winter (PST) and 5 pm in summer (PDT).
  A class that runs past that hour gets a fresh budget mid-session.
- To raise a cap for one day: `npx wrangler deploy --var DAILY_BUDGET_USD:10`, then `npm run deploy` later to go back.

## Known limits

- Claude Haiku 5.5, Gemini 3.5 Flash Lite, GPT-5 nano, and GPT-6 Luna do not share probabilities. Chapter 4 shows a card saying so; chapters 5 and 6 do not show the card, they just stream the text without confidence tints or alternatives.
- The autocomplete pane in chapter 5 is a simulation. The point of the chapter is the contrast between a model that only continues text and one trained to answer. The real examples of the first kind (GPT-3, then GPT-3.5 Instruct) are retired, and as of 2026-11-02 OpenRouter offers no pure text-continuation models at all. So the left pane is Llama 3.1 8B, a small chat model, given a fixed instruction ("you are a text-continuation engine... never answer") and two examples of continuing text, including one where a question is continued with more questions instead of answered. The student's system prompt is pasted in as plain text, the way an old model would have seen it. What this means for teaching:
  - The contrast students see is real behavior, but the left pane is a chat model playing a part, not a genuine pre-ChatGPT model. The pane is labelled "Autocomplete mode (simulated)" and its caption says so; say it out loud in class too.
  - Its probability bars are this chat model's guesses while playing the part. They show what a continuation looks like, not what a raw model's probabilities were.
  - It can slip and answer, most often on a direct question. If that happens in class, it is a usable teaching moment: answer-giving training is hard to switch off with an instruction.
  - Chat models start their reply without a space, so the Worker adds one when the student's text ends in a letter, digit or closing punctuation, and not after an opening character such as "150/" or "follow-". A prompt typed to stop mid-word ("hypert") will still come back split ("hypert ension"). That is rare in a typed prompt, so this model is kept out of the model pickers (`picker: false` in `site/models.js`) and used only in chapter 5's left pane, which has no Step, Resume or Fork.
- Chat continuation (Keep going, Step, Resume, Fork) works by sending the text so far as the model's own message and asking it to continue that message. Chat models usually comply, but may occasionally repeat or rephrase a few words. The simulated autocomplete pane works differently: the text so far is simply appended to the fragment it is continuing, so it does not repeat itself, but it can occasionally restate or answer, as above.
- GPT-5 nano and GPT-6 Luna are reasoning models: they can think before they write. The Worker drops `temperature` for them and asks for minimal reasoning effort (see `upstream` in `site/models.js`); otherwise they can spend the whole token allowance thinking and return no text. Claude Haiku 5.5 is not a reasoning model, but no provider accepts `temperature` for it either, so the Worker drops it there too. For all three, the temperature slider still rescales the bars locally but has no effect on the model's own sampling.
- Llama 3.3, Gemma 4, and Llama 3.1 8B are sent with `require_parameters`, so OpenRouter only uses providers that return probabilities. Without it, OpenRouter picks the cheapest provider, and for Llama that one silently drops probabilities, so the bars vanish with no error. The trade-off: if every probability-capable provider for one of these models is down at once, that model now shows an error ("The model provider returned an error") instead of quietly running without bars. Pick another model for the day; if it lasts, `npm run check:models -- --live` will show it.
- "No IPs stored" has one small exception: the per-network rate limit and the wrong-passcode limit keep hashed-address keys with request timestamps in Durable Object storage for up to 60 seconds, then drop them.
- `GET /api/models` returns the contents of `site/models.js` (ids, labels, prices) without a passcode. It is harmless: the same file ships to every browser as part of the site.
- Token counts for Llama, Gemma, Claude, Gemini, and GPT-6 Luna are approximate. The page shows OpenAI's o200k tokenizer with a note; only GPT-3.5, GPT-4, GPT-4o mini, and GPT-5 nano are exact.
- The 2-D word map (chapter 2) is a flattening of 384 dimensions from a small sentence-embedding model (all-MiniLM-L6-v2). It is not the LLM's own embedding space, and the caption says so.
- The attention arcs (chapter 3) come from GPT-2 on two fixed sentences, computed once and stored. They are not live.
- Rate limits are per signed-in browser (30 a minute) and per network address (60 a minute). A classroom behind one campus address shares the 60. If students see "Too many requests from this network", raise `PER_IP_PER_MINUTE` in `wrangler.jsonc` and redeploy.
- GPT-4 costs 100 to 200 times as much as GPT-4o mini per token (200 times for the prompt, 100 times for the output). That is why it has its own $1 cap.
- Budgets can overshoot by one request: the Worker reserves the estimated cost before calling the provider and settles up after, so a request that starts just under the cap finishes.
- The repository is public. That is fine: secrets live only in Cloudflare and in the ignored `.dev.vars` file. Do not commit `.dev.vars`.
- The Worker calls every model through OpenRouter's chat endpoint (`/chat/completions`), including the simulated autocomplete model. On 2026-09-15 OpenRouter's older text-completion route rejected the then-current autocomplete model, which is why the chat endpoint is used for everything; that episode is also why the Worker logs the actual provider error to `wrangler tail` when a request is rejected outright, never just a status code. Whether that older route would serve raw, frame-free continuations from Llama today is untested.

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

On 2026-09-15 chapter 5's left pane was checked once against the real GPT-3.5 Instruct model,
which OpenRouter has since retired. Nothing in the 2026-11-02 model ladder has been checked
against real models yet.
