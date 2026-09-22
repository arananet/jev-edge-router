# jev-edge-router

> An OpenAI-compatible model gateway on Cloudflare Workers that asks TypeSafe Jev a few typed
> questions about each request, then sends it to the cheapest model tier that can handle it.

Code calculates, Jev judges, the policy decides, the upstream model answers.

Any client that speaks the OpenAI Chat Completions API can use it by changing a base URL.

---

## Architecture

```text
client (OpenAI-compatible)
   │  POST /v1/chat/completions
   ▼
Worker: src/index.ts
   ├─ auth
   ├─ features.ts      deterministic features (tokens, tools, images, pinned model)
   ├─ judge/           one Jev call, all questions in parallel, hard deadline, fail open
   ├─ policy.ts        features + judgments + config  ->  model tier (pure function)
   ├─ upstream/        provider adapter, streaming passthrough (SSE)
   └─ telemetry.ts     decision log to D1 (no prompt content by default)
```

Nothing outside `src/judge/providers/` and `src/upstream/providers/` knows which vendor is in
use. `judge.provider` picks between `cloudflare` (the Workers AI binding), `cloudflare-rest`
(`POST /accounts/{id}/ai/run`, for callers without the binding), `typesafe` and `vercel`.
Swapping is a config change.

If the judge times out, errors or answers with low confidence, the request is never blocked: it
falls back to `default_tier` or escalates one tier. A broken judge costs money, never
correctness.

## Quick start

```bash
npm install
cp config/tiers.example.json config/tiers.json   # edit models, prices and thresholds

# The worker reads the config from the TIERS_CONFIG var.
npx wrangler secret put ROUTER_API_KEYS          # comma separated client keys
npx wrangler secret put UPSTREAM_API_KEY_MID     # one per tier, tier name upper-cased
npx wrangler d1 create jev-edge-router-db        # put the id in wrangler.toml
npx wrangler d1 migrations apply jev-edge-router-db

npm run dev
npm test
```

Point any OpenAI client at the worker:

```bash
curl http://localhost:8787/v1/chat/completions \
  -H 'authorization: Bearer <your router key>' \
  -H 'content-type: application/json' \
  -d '{"messages":[{"role":"user","content":"why is my worker returning 522?"}]}' -i
```

The response carries the decision in its headers:

```text
x-router-tier: mid                 tier that actually served the request
x-router-decided-tier: mid         tier the policy chose (differs in shadow mode)
x-router-reason: difficulty 2 maps to mid
x-router-judge-latency-ms: 180
```

## Modes

| `ROUTER_MODE` | Behaviour |
| --- | --- |
| `shadow` (default) | Call the judge, log the decision, always serve `default_tier`. Start here. |
| `route` | Apply the decision. |
| `off` | Bypass the judge entirely. Kill switch. |

## What Jev is asked

One request per routed call, four independent questions in the `typesafe/jev` schema:
`task_type` (a choice over ten categories), `difficulty` (a score over four concrete levels, so
the answer is a float from 0 to 3), and the nouls `needs_long_output` and `high_stakes`.
Only free text and the turn count are sent. Token counts, tool presence, images and model
pinning are computed in code and never asked. The set lives in `src/judge/questions.ts`; every
new question needs an eval result behind it.

## Routing policy

`src/policy.ts` is a pure function with no I/O. In order: honour client pinning when config
allows it; apply hard feature requirements (images, tool support, context window); fall back to
`default_tier` when the judge failed; map difficulty and task type through the config table;
escalate one tier below `min_confidence`; enforce `high_stakes_min_tier` above
`high_stakes_threshold`. Every decision returns a human readable reason.

## Eval

```bash
npm run eval -- eval/dataset.jsonl config/tiers.json
```

Replays a labeled dataset (prompt plus the cheapest tier a human judged acceptable) through the
judge and policy only, no upstream calls. It reports routing accuracy, under-routing and
over-routing separately (under-routing is the costly failure), accuracy bucketed by judge
confidence, and estimated savings against always using the top tier. Set thresholds from that
output, not from intuition.

## Telemetry and privacy

Every routed call writes one row to the D1 `decisions` table: features, the full judgment with
its probability distributions, the chosen tier, the reason, judge and upstream latency, token
usage and estimated cost against the cost of the top tier. Prompt content is **not** stored.
`LOG_CONTENT=true` exists only for local eval collection.

## Honest limitations

- **No live call has been made from this repo.** The adapters implement the documented
  `typesafe/jev` schema, but `api.cloudflare.com` and `api.openai.com` are both outside the
  egress allowlist of the environment this was written in, so the fixtures are schema-shaped,
  not recorded. Probe first: `npm run probe -- --record`. See
  [`docs/jev-wire-format.md`](docs/jev-wire-format.md).
- **No routing accuracy numbers yet.** Every threshold shipped is a conservative placeholder,
  not an eval result, and the example dataset carries hand-written judgments so the harness
  runs offline. Nothing here reproduces TypeSafe's own speed or accuracy figures.
- **The TypeSafe and Vercel judge endpoints are guesses.** Only the two Cloudflare paths are
  documented.
- **No rate limiting.** Client keys are authenticated but not throttled.
- **Token counts are estimated** at four characters per token, including the context window
  checks in the policy.
- **The Anthropic adapter translates text only.** Tool calls and image blocks are dropped.
- **The Workers AI judge path is untested locally**, because the binding cannot be simulated.

Full list, with status and workarounds, in [`KNOWN_ISSUES.md`](KNOWN_ISSUES.md).

## How this differs from jev-router

`jev-router` picks a model inside a CLI session (Claude Code, Codex). This is a network
gateway: the routing decision happens per HTTP request, for any client, behind one base URL.

---

## Contributing

This project uses **OpenSpec** for spec-driven development: every feature or bugfix starts with
a spec under `.openspec/specs/`. See [`docs/OPENSPEC.md`](docs/OPENSPEC.md) for the workflow and
[`CONTRIBUTING.md`](CONTRIBUTING.md) for the contributor checklist.

Commands: `npm test`, `npm run typecheck`, `bash scripts/openspec check`.

## Documentation

| Topic | Where |
| --- | --- |
| Jev wire format and how to verify it | [`docs/jev-wire-format.md`](docs/jev-wire-format.md) |
| Known issues | [`KNOWN_ISSUES.md`](KNOWN_ISSUES.md) |
| Spec-driven workflow | [`docs/OPENSPEC.md`](docs/OPENSPEC.md) |
| Guided project setup | [`docs/ONBOARDING.md`](docs/ONBOARDING.md) |
| Incremental adoption of the spec workflow | [`docs/ADOPTION.md`](docs/ADOPTION.md) |
| Security policy | [`SECURITY.md`](SECURITY.md) |
| Release history | [`CHANGELOG.md`](CHANGELOG.md) |

---

## License

[Apache License 2.0](LICENSE)

---

## Developer

Eduardo Arana

## Support this with a ko-fi

[![ko-fi](https://ko-fi.com/img/githubbutton_sm.svg)](https://ko-fi.com/H2H51MPWG)
