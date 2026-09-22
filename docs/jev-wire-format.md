# Jev wire format

Status on 2026-09-22: **assumed, not verified.** No TypeSafe or Vercel AI Gateway credentials
were available while `src/judge/` was written, so nothing in this document was recorded from a
live endpoint. Treat it as the contract the adapters currently implement, not as evidence.

## How to verify

```bash
TYPESAFE_API_KEY=... npm run probe -- "why is my worker returning 522?"
TYPESAFE_API_KEY=... npm run probe -- --vercel "..."
```

The probe prints the request and response and writes a redacted copy to
`fixtures/jev-<provider>.recorded.json`. Redaction keeps every field name and every
probability, and replaces the prompt with `<redacted>`.

For the Workers AI binding, run `wrangler dev` with `ROUTER_MODE=shadow` and a config whose
`judge.provider` is `cloudflare`, send a request, and read the decision row in D1.

After recording: correct `src/judge/wire.ts`, replace the synthetic fixtures with the recorded
one, update this document with the observed envelope and the date, and remove the
"unverified" entry from `KNOWN_ISSUES.md`.

## Request the adapters send

```json
{
  "model": "jev-1",
  "state": {
    "request": {
      "last_user_message": "<truncated to judge.max_chars>",
      "system_prompt_excerpt": "<truncated>",
      "conversation_turns": 6
    }
  },
  "questions": [
    { "name": "task_type", "type": "Choice", "question": "...", "options": ["chit_chat", "..."] },
    { "name": "difficulty", "type": "Score", "question": "...", "levels": { "0": "...", "3": "..." } },
    { "name": "needs_long_output", "type": "Noul", "question": "..." },
    { "name": "high_stakes", "type": "Noul", "question": "..." }
  ]
}
```

One request per routed call, every question evaluated against the same state, no retries.

## Response the adapters accept

`normaliseJevResponse` accepts both an array of answers and an object keyed by question name,
because the two forms appear in circulation and the cost of accepting both is one branch:

```json
{
  "answers": [
    { "name": "task_type", "value": "code_debugging", "confidence": 0.72,
      "distribution": { "code_debugging": 0.72, "code_generation": 0.18, "other": 0.1 } },
    { "name": "difficulty", "value": 2, "confidence": 0.64,
      "distribution": { "0": 0.05, "1": 0.15, "2": 0.64, "3": 0.16 } },
    { "name": "needs_long_output", "probability": 0.21, "confidence": 0.79 },
    { "name": "high_stakes", "probability": 0.08, "confidence": 0.9 }
  ]
}
```

Normalisation rules, all covered by `test/judge.test.ts`:

- A boolean answer may carry `probability`, a boolean `value`, or a `distribution` with a
  `true`/`yes` key. Anything else is an error, never a silent zero.
- A missing `confidence` falls back to the highest probability in the distribution, and to 0
  when there is no distribution. A 0 confidence escalates one tier under policy rule 5, so an
  underspecified answer costs money rather than correctness.
- An unknown `task_type` or a non numeric `difficulty` throws. The judge call then fails open
  and the request goes to `default_tier`.
