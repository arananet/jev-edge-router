# Fixtures

Recorded, redacted Jev requests and responses. Tests read these instead of calling a live
endpoint, so the adapter is always checked against a shape we have actually seen.

- `jev-response.synthetic.json`: hand written, NOT recorded. It encodes the assumed envelope
  documented in `docs/jev-wire-format.md`. Replace it with a real sample the first time
  `npm run probe` runs with credentials, and delete this note when you do.

Redaction rules for recorded samples: strip the `state` free text, strip any id that ties the
sample to an account, keep every field name and every probability.
