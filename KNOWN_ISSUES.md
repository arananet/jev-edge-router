# Known issues

## Jev wire format is unverified
**Status**: Blocked
**Detail**: `src/judge/wire.ts` and the fixtures in `fixtures/` were written against the
documented envelope in `docs/jev-wire-format.md`, not against a recorded response. No
TypeSafe, Vercel or Workers AI credentials were available on 2026-09-22. Field names, the
question type names (`Choice`, `Score`, `Noul`) and the answer envelope may all be wrong.
**Workaround**: Run `npm run probe` with real credentials, record the redacted sample, correct
the adapter, then run in `ROUTER_MODE=shadow` before trusting any routing decision.

## Judge model ids are placeholders
**Status**: Blocked
**Detail**: `@typesafe/jev-1` (Workers AI), `jev-1` (TypeSafe REST) and `typesafe/jev-1`
(Vercel) are guesses, as are the two REST base URLs. Each provider takes an explicit
`judge.model` and `judge.base_url` from config, so correcting them is a config change.
**Workaround**: Set `judge.model` and `judge.base_url` from the vendor's own docs.

## No routing accuracy numbers yet
**Status**: Blocked
**Detail**: Every threshold in `config/tiers.example.json` (`min_confidence` 0.55,
`high_stakes_threshold` 0.8, the difficulty table) is a placeholder chosen to be
conservative, not a value derived from eval output. TypeSafe's published speed, cost and
accuracy figures are the vendor's own numbers and are not reproduced here.
**Workaround**: Collect a labeled dataset, run `npm run eval`, and set thresholds from the
under-routing rate and the calibration buckets it prints.

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
