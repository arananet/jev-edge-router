# Known issues

## Post-fix Cloudflare REST probe is pending

**Status**: Workaround available
**Detail**: A direct live `typesafe/jev` call and the router-shaped probe reached
`api.cloudflare.com` successfully on 2026-09-22. The current endpoint returned
`{ success: true, result: { state: "Completed", result: <jev-result> } }`. The normalizer now
accepts that envelope, with focused tests for valid and invalid nested results. A post-fix REST
probe returned HTTP 200, normalized successfully, and took about 1436ms.
**Workaround**: Validate the Workers AI binding separately and establish p95/p99 latency before
using REST Jev routing with the configured 400ms production deadline.

## Worker-level upstream routing is not yet exercised end to end

**Status**: Partially verified
**Detail**: A direct OpenAI-compatible upstream call succeeded on 2026-09-22, including a
live response and token usage. The OpenAI-compatible and Anthropic adapters still lack an
end-to-end request through the Worker; unit tests and stubbed fetches cover their current
integration paths.
**Workaround**: `npm run dev` with `UPSTREAM_API_KEY_MID` set, then curl the worker.

## TypeSafe and Vercel judge endpoints are guesses

**Status**: Blocked
**Detail**: The Cloudflare paths (`typesafe/jev` through the binding and through
`/accounts/{id}/ai/run`) are documented. The direct TypeSafe REST API and the Vercel AI
Gateway adapters in `src/judge/providers/` assume the same payload at guessed base URLs and
model ids, because neither vendor's endpoint has been checked.
**Workaround**: Set `judge.base_url` and `judge.model` from the vendor's own docs, or stay on
`judge.provider: "cloudflare"`.

## Live routing evidence is not yet statistically sufficient

**Status**: Monitoring
**Detail**: A seven-scenario live Jev run improved exact routing from 57.1% to 71.4% and reduced
under-routing from one high-severity case to zero, against the fixed `mid` baseline. This is a
small, curated sample, not a general performance result. `eval/dataset.example.jsonl` carries
hand-written judgments so its 100% accuracy only measures plumbing. Every threshold in
`config/tiers.example.json` (`min_confidence` 0.55,
`high_stakes_threshold` 0.8, the difficulty table) is a placeholder chosen to be
conservative, not a value derived from eval output. TypeSafe's published speed, cost and
accuracy figures are the vendor's own numbers and are not reproduced here.
**Workaround**: Use `eval/orchestration-scenarios.jsonl` with `npm run eval -- --live` and set
thresholds from baseline comparison, severity-weighted under-routing, and calibration results.

## Data terms not yet confirmed

**Status**: Blocked
**Detail**: CLAUDE.md requires confirming Cloudflare partner-model terms and TypeSafe data
terms before any non-public data goes through the judge path. That confirmation has not been
done, and the outcome is not recorded here yet.
**Workaround**: Keep `LOG_CONTENT=false` (the default) and send only non-sensitive traffic
until the terms are checked and the result is recorded in this file.

## Workers AI binding is not exercised by tests

**Status**: Workaround available
**Detail**: The local Workers runtime cannot simulate the `AI` binding (it proxies to the
Cloudflare API), so `vitest.config.ts` defines bindings directly instead of reading
`wrangler.toml`, and omits `AI`. `CloudflareJudgeProvider` is therefore covered only by the
shared normalisation tests.
**Workaround**: Exercise it with `wrangler dev` in shadow mode and read the D1 decision rows.

## Cloudflare judge deadline does not cancel the call

**Status**: Monitoring
**Detail**: `env.AI.run` takes no `AbortSignal`, so `CloudflareJudgeProvider` races the call
against the deadline. The router returns on time, but the underlying judge request keeps
running and is still billed.
**Workaround**: None. The REST providers (`typesafe`, `vercel`) pass the signal to `fetch`
and cancel properly.

## No rate limiting

**Status**: Blocked
**Detail**: `src/index.ts` authenticates client keys but applies no per-key rate limit; the
architecture in CLAUDE.md calls for one. A stolen key is bounded only by upstream quota.
**Workaround**: Put the Worker behind a Cloudflare rate limiting rule until a Durable Object
or KV based limiter lands.

## Token counts are estimated

**Status**: Monitoring
**Detail**: `features.ts` estimates prompt tokens at four characters per token. Context
window checks in `policy.ts` use that estimate, so a request close to a tier's limit can be
routed to a tier that then rejects it.
**Workaround**: Keep a margin between real prompt sizes and the smallest tier's
`context_window`, or set `context_window` slightly below the vendor's figure.

## Judge latency budget is unmeasured

**Status**: Monitoring
**Detail**: `judge.deadline_ms` defaults to 400ms with no p95 measurement behind it. If p95
judge latency approaches the savings it enables, routing is not worth its own cost.
**Workaround**: Read `judge_latency_ms` from the `decisions` table after a shadow mode run and
revisit the deadline.

## Anthropic translation covers text only

**Status**: Workaround available
**Detail**: `src/upstream/providers/anthropic.ts` translates text messages, system prompts and
text deltas. Tool calls, image blocks and tool result messages are dropped in translation.
**Workaround**: Keep tool using and image bearing traffic on `openai-compatible` tiers; the
policy already refuses to route images to a tier without `supports_images`.
