# LLM Under the Hood

A passcode-gated web explainer for students. You type a short prompt (up to 200 characters) and watch it flow through the stages of a language model: tokens, embeddings, attention, next-token probabilities, autocomplete versus assistant behavior, and a side-by-side comparison of model eras. Real models answer through OpenRouter, behind a Cloudflare Worker that enforces the passcode, rate limits, and a daily spend cap.

To run it locally: `npm install && cp .dev.vars.example .dev.vars && npm run mock` in one terminal (a local stand-in for OpenRouter), then `npm run dev` in another. Open `http://127.0.0.1:8787` and use the passcode `test`. Run the tests with `npm test`. Deploy with `npm run deploy` (requires a logged-in wrangler and the `OPENROUTER_API_KEY`, `PASSCODE`, and `COOKIE_SECRET` secrets set on the Worker).

Design notes and the chapter-by-chapter content live in [the design document](docs/plans/2026-09-14-llm-under-the-hood-design.md); the build plan is in [the implementation plan](docs/plans/2026-09-14-llm-under-the-hood.md).
