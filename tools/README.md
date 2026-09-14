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

## Data builders (added in later tasks)

- `vendor_tokenizers.sh` — bundles `gpt-tokenizer` (o200k and cl100k) with esbuild into `site/vendor/`.
- `build_embeddings.mjs` — embeds a word list with `Xenova/all-MiniLM-L6-v2` and writes `site/data/embeddings.json`.
- `build_attention.py` — runs GPT-2 in the Python venv and writes per-head attention for the canned examples to `site/data/attention.json`.
