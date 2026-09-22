/**
 * Phase 2 probe. Calls Jev through the Cloudflare REST API, prints the raw envelope, and
 * writes a redacted copy to fixtures/.
 *
 * The Workers AI binding cannot be called from Node, so probe that path with `wrangler dev`
 * and a request against a shadow mode worker.
 *
 * Usage:
 *   CLOUDFLARE_ACCOUNT_ID=... CLOUDFLARE_API_TOKEN=... npm run probe -- "your test prompt"
 * Exits 78 (EX_CONFIG) when credentials are absent, so CI can skip cleanly.
 */
import { writeFileSync } from 'node:fs';
import { buildJevPayload, normaliseJevResponse } from '../src/judge/wire';
import type { JudgeState } from '../src/judge/questions';

const accountId = process.env['CLOUDFLARE_ACCOUNT_ID'];
const apiToken = process.env['CLOUDFLARE_API_TOKEN'];
const model = process.env['JEV_MODEL'] ?? 'typesafe/jev';
const prompt = process.argv.slice(2).find((arg) => !arg.startsWith('--')) ?? 'Why is my worker returning 522?';
const record = process.argv.includes('--record');

if (!accountId || !apiToken) {
  console.error('CLOUDFLARE_ACCOUNT_ID or CLOUDFLARE_API_TOKEN is not set; skipping probe');
  process.exit(78);
}

const state: JudgeState = {
  request: { last_user_message: prompt, system_prompt_excerpt: '', conversation_turns: 1 },
};
const payload = buildJevPayload(state, model);
const url = `https://api.cloudflare.com/client/v4/accounts/${accountId}/ai/run`;

const started = Date.now();
const response = await fetch(url, {
  method: 'POST',
  headers: { 'content-type': 'application/json', authorization: `Bearer ${apiToken}` },
  body: JSON.stringify(payload),
});
const text = await response.text();
const latency = Date.now() - started;

console.log(`POST /accounts/<redacted>/ai/run -> ${response.status} in ${latency}ms`);
console.log('request:', JSON.stringify(payload, null, 2));
console.log('response:', text);

if (!response.ok) process.exit(1);

const raw: unknown = JSON.parse(text);
console.log('normalised:', JSON.stringify(normaliseJevResponse(raw), null, 2));

if (record) {
  // Redaction: the recorded sample keeps field names and probabilities, never the prompt.
  const redacted = {
    _recorded_at: new Date().toISOString().slice(0, 10),
    _endpoint: 'POST https://api.cloudflare.com/client/v4/accounts/{account_id}/ai/run',
    _latency_ms: latency,
    request: { ...payload, input: { ...payload['input'] as object, state: '<redacted>' } },
    response: raw,
  };
  writeFileSync('fixtures/jev-cloudflare.recorded.json', `${JSON.stringify(redacted, null, 2)}\n`);
  console.log('wrote fixtures/jev-cloudflare.recorded.json');
}
