# tools/

Development helpers. None of these ship to the Worker or the site.

## `mock_openrouter.mjs` — local stand-in for OpenRouter

`npm run mock` starts a plain `node:http` server on `http://127.0.0.1:8788` that answers the two OpenRouter routes the Worker uses, so the whole app can be exercised offline and without spending money. `.dev.vars.example` already points `OPENROUTER_BASE_URL` at it; `cp .dev.vars.example .dev.vars` and `npm run dev` picks it up.

What it does:

- `POST /chat/completions` and `POST /completions` read the JSON body and stream a canned, prompt-aware continuation as SSE, one word-ish token every ~60 ms, ending with `data: [DONE]`. A clinical-sounding prompt gets a clinical continuation, a question gets an answer-shaped one, and so on, so the UI looks alive.
- Between 10 and 20 tokens; `max_tokens: 1` sends exactly one token (and `finish_reason: "length"`).
- If the body asks for `logprobs`, each token carries five alternatives with decaying logprobs (`-0.2, -1.9, -2.6, -3.3, -4.0`, chosen token first) in the chat shape (`choices[0].logprobs.content[0].top_logprobs`) or the legacy completions shape (`logprobs.tokens / token_logprobs / top_logprobs` maps).
- The final chunk carries `usage` with `prompt_tokens = ceil(promptChars / 4)`, `completion_tokens`, and `cost` computed from the model's price in `site/models.js` (unknown model ids use GPT-4o mini pricing).
- `model: "mock/error"` responds `500` with an OpenRouter-style `{error}` body, for testing the Worker's error path.
- `stream: false` returns a single JSON completion object instead of SSE.
- `GET /` returns a small JSON health object; anything else is `404`.

Options: `MOCK_PORT=8790 npm run mock` changes the port. From tests, `import { startMock } from '../tools/mock_openrouter.mjs'` and call `startMock(0, { tokenMs: 1 })` for an ephemeral, fast server (`tests/mock_openrouter.test.mjs` does this).

Try it by hand:

```sh
curl -N -X POST localhost:8788/chat/completions -H 'content-type: application/json' \
  -d '{"model":"openai/gpt-4o-mini","messages":[{"role":"user","content":"The patient presented with"}],"stream":true,"logprobs":true,"top_logprobs":5}'
```

## Local smoke verified 2026-09-14

`npm run mock` and `npm run dev` (wrangler 4.131.2, `.dev.vars` copied from `.dev.vars.example`) with these exact commands; no runtime fixes were needed (`env.LEDGER.getByName('global')`, the DO RPC methods, and the `cloudflare:workers` import all worked as written).

```sh
# wrong passcode → 401; right passcode → 204 with Set-Cookie: sess=...
curl -i -X POST localhost:8787/api/auth -H 'content-type: application/json' -d '{"passcode":"nope"}'
curl -i -X POST localhost:8787/api/auth -H 'content-type: application/json' -d '{"passcode":"test"}'
COOKIE='sess=<value from Set-Cookie, up to the first ;>'

# 204 with the cookie
curl -i localhost:8787/api/session -H "cookie: $COOKIE"

# chat model: 20 normalized token events then {"type":"done",...,"cost":0.00001305,"finish":"stop"}
curl -N -X POST localhost:8787/api/generate -H 'content-type: application/json' -H "cookie: $COOKIE" \
  -d '{"model":"openai/gpt-4o-mini","prompt":"The patient presented with"}'

# legacy completions model: the mock logs "completion openai/gpt-3.5-turbo-instruct", same event shape, cost 0.0000505
curl -N -X POST localhost:8787/api/generate -H 'content-type: application/json' -H "cookie: $COOKIE" \
  -d '{"model":"openai/gpt-3.5-turbo-instruct","prompt":"The patient presented with"}'

# stream:false → {"events":[...]} as JSON
curl -X POST localhost:8787/api/generate -H 'content-type: application/json' -H "cookie: $COOKIE" \
  -d '{"model":"openai/gpt-4o-mini","prompt":"hi","stream":false}'

# 11 rapid wrong passcodes → 401s until the 10th hit in the minute, then 429 with Retry-After
for i in $(seq 1 11); do curl -s -o /dev/null -w '%{http_code} ' -X POST localhost:8787/api/auth \
  -H 'content-type: application/json' -d '{"passcode":"nope"}'; done

# Durable Object round trip: after three generate calls, restart wrangler with a tiny budget.
# The FIRST generate after the restart is a 429 "Today's class budget is used up." with Retry-After
# (seconds to UTC midnight), which proves the spend persisted across the restart and that
# reserveIfUnder refuses in the real DO; openai/gpt-4 (its own bucket) still returns 200.
npx wrangler dev --port 8787 --var DAILY_BUDGET_USD:0.0000001
```

Note: this smoke covers `/api/*`; `GET /` serves `site/index.html` (the passcode gate) and every file under `site/` is served as a static asset at the same path (for example `/vendor/o200k.js`, `/data/embeddings.json`).

## Data builders

- `vendor_tokenizers.sh` — bundles `gpt-tokenizer` (o200k and cl100k) with esbuild into `site/vendor/` (`npm run vendor:tokenizers`; the two bundles are committed because the site has no build step).
- `build_embeddings.mjs` — embeds `vocabulary.txt` (`word<TAB>group`, one per line) with `Xenova/all-MiniLM-L6-v2`, projects to 2-D with `pca.mjs`, and writes `site/data/embeddings.json` (`npm run data:embeddings`; the first run downloads the ~23 MB model into the transformers.js cache).
- `build_attention.py` — runs GPT-2 in the Python venv and writes per-head attention for the canned examples to `site/data/attention.json`. One-time setup (a few hundred MB, `.venv/` is gitignored): `python3 -m venv .venv && .venv/bin/pip install -r tools/requirements.txt`, then `npm run data:attention`. For each highlight it searches layers 2 and up (layers 0-1 mostly track position and the first token) for the (layer, head) where the `from` token attends most to the `to` token, and stores that head's full attention row, the layer's head-averaged row, and `argmax` (whether `to` is what that row attends to most); a best weight under 0.3 is flagged `"weak": true`. To audition new sentences before adding them to `SENTENCES`, run `.venv/bin/python tools/build_attention.py --candidates` (optionally followed by extra specs of the form `"<sentence>::from>to,from>to"`); it prints the best head, weight, and argmax check for every highlight and writes nothing.
