# Fixtures

Jev requests and responses the adapters are tested against.

| File | What it is |
| --- | --- |
| `jev-vendor-example.json` | The vendor's own quick start for `typesafe/jev`, kept verbatim as the reference envelope. |
| `jev-router-questions.expected.json` | This repo's four questions in that answer shape. |
| `jev-rest-envelope.expected.json` | The same result inside the Cloudflare REST `{success, result}` wrapper. |
| `jev-rest-completed-envelope.expected.json` | Sanitized completed-job REST response observed from Cloudflare. |

The last two remain schema-shaped rather than raw recorded output. A live Cloudflare REST call
has since succeeded and returned a completed-job envelope supported by the normalizer.
Record a sanitized real sample with

```bash
CLOUDFLARE_ACCOUNT_ID=... CLOUDFLARE_API_TOKEN=... npm run probe -- --record "a test prompt"
```

which writes `fixtures/jev-cloudflare.recorded.json`.

Redaction rules for recorded samples: replace the `state` free text, strip any id that ties the
sample to an account, keep every field name and every probability.
