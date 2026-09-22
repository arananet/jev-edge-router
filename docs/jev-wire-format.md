# Jev wire format

Source: the Workers AI model catalogue entry for `typesafe/jev`, read 2026-09-22. The vendor's
own quick start is kept verbatim in `fixtures/jev-vendor-example.json`, and the adapters in
`src/judge/` implement exactly that schema.

Not yet confirmed by a call this repo made: `api.cloudflare.com` is outside the egress
allowlist of the environment the code was written in, so `fixtures/jev-router-questions.expected.json`
and `fixtures/jev-rest-envelope.expected.json` were written from the documented schema rather
than recorded. See `KNOWN_ISSUES.md`.

Model facts from the same page: context length 32,000 tokens, input priced at $0.042 per
million tokens, zero data retention, provider model `jev-latest`, answer types Noul, Choice and
Score.

## How to record a real sample

```bash
CLOUDFLARE_ACCOUNT_ID=... CLOUDFLARE_API_TOKEN=... \
  npm run probe -- --record "why is my worker returning 522?"
```

The probe prints the request, the raw response and the normalised judgment, and with
`--record` writes `fixtures/jev-cloudflare.recorded.json` with the state replaced by
`<redacted>`. Point the tests at the recorded file and delete the "expected" ones.

For the Workers AI binding, run `wrangler dev` with `judge.provider: "cloudflare"` and read the
decision row in D1.

## Request

Through the binding: `env.AI.run('typesafe/jev', input)`.
Through REST: `POST /client/v4/accounts/{account_id}/ai/run` with `{ "model": "typesafe/jev",
"input": ... }`.

`input.state` is a string, an object or an array. This router sends an object, so the judge sees
the free text fields separately:

```json
{
  "state": {
    "request": {
      "last_user_message": "<truncated to judge.max_chars>",
      "system_prompt_excerpt": "<truncated>",
      "conversation_turns": 6
    }
  },
  "questions": {
    "task_type": {
      "type": "choice",
      "instructions": "Which single category best describes what the user is asking the assistant for?",
      "criteria": { "chit_chat": "Greetings, small talk...", "code_debugging": "..." }
    },
    "difficulty": {
      "type": "score",
      "instructions": "How demanding is this request for a language model?",
      "criteria": ["A short answer any small model...", "...", "...", "..."]
    },
    "needs_long_output": {
      "type": "noul",
      "instructions": "Does the request ask for a long, structured deliverable?",
      "criteria": { "true": "Asks for a document, report...", "false": "A short answer..." }
    },
    "high_stakes": { "type": "noul", "instructions": "...", "criteria": { "true": "...", "false": "..." } }
  }
}
```

`criteria` shapes follow the answer type: a `true`/`false` map for noul, a label map for choice,
an ordered list of levels for score. One request per routed call, every question against the
same state, no retries.

## Response

```json
{
  "model": "jev-1.13.0",
  "answers": {
    "task_type": { "type": "choice", "choice": "code_debugging", "confidence": 0.8,
                   "probabilities": { "code_debugging": 0.87, "code_generation": 0.13 } },
    "difficulty": { "type": "score", "score": 1.86, "confidence": 0.71,
                    "legend": { "0": "...", "3": "..." },
                    "probabilities": { "0": 0.02, "1": 0.24, "2": 0.6, "3": 0.14 } },
    "needs_long_output": { "type": "noul", "noul": 0.18 },
    "high_stakes": { "type": "noul", "noul": 0.05 }
  },
  "usage": { "input_tokens": 512, "output_tokens": 88 }
}
```

The REST API wraps that object in the usual `{ "success": true, "result": ... }`; the binding
returns it directly. `normaliseJevResponse` accepts both.

Normalisation rules, all covered by `test/judge.test.ts`:

- A **score** answer is a float, not an integer: `1.86` means "between careful and multi-step,
  closer to multi-step". The policy rounds it only when indexing the difficulty table, so the
  fractional part is preserved in telemetry.
- The score range follows the number of criteria. Four difficulty levels give a 0 to 3 score,
  which is why `DIFFICULTY_LEVELS` has exactly four entries.
- A **noul** answer carries a probability and no confidence. `noulConfidence` derives one as
  the distance from 0.5, doubled, so a genuinely undecided answer reads as zero confidence.
  Only `task_type` and `difficulty` feed the `min_confidence` escalation, because those two
  pick the tier and are the two Jev reports a real confidence for.
- A missing `confidence` falls back to the highest value in `probabilities`, and to 0 when
  there are none. Zero confidence escalates one tier under policy rule 5, so an underspecified
  answer costs money rather than correctness.
- An unknown `choice` or a malformed answer throws. The judge call then fails open and the
  request goes to `default_tier`.
