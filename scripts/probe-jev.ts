/**
 * Phase 2 probe. Calls Jev through the TypeSafe REST API (and, with `--vercel`, through the
 * Vercel AI Gateway), prints the raw envelope, and writes a redacted copy to fixtures/.
 *
 * The Workers AI binding cannot be called from Node, so probe that path with
 * `wrangler dev` and `curl localhost:8787/v1/chat/completions` against a shadow mode worker.
 *
 * Usage: TYPESAFE_API_KEY=... npm run probe -- "your test prompt"
 * Exits 78 (EX_CONFIG) when credentials are absent, so CI can skip cleanly.
 */
import { writeFileSync } from 'node:fs';
import { buildJevPayload } from '../src/judge/wire';
import type { JudgeState } from '../src/judge/questions';

const useVercel = process.argv.includes('--vercel');
const prompt = process.argv.slice(2).find((arg) => !arg.startsWith('--')) ?? 'Why is my worker returning 522?';
const apiKey = useVercel ? process.env.VERCEL_AI_GATEWAY_KEY : process.env.TYPESAFE_API_KEY;
const url = useVercel
  ? (process.env.VERCEL_JUDGE_URL ?? 'https://ai-gateway.vercel.sh/v1/judge')
  : (process.env.TYPESAFE_JUDGE_URL ?? 'https://api.typesafe.ai/v1/judge');

if (!apiKey) {
  console.error(`no credentials for ${useVercel ? 'vercel' : 'typesafe'}; skipping probe`);
  process.exit(78);
}

const state: JudgeState = {
  request: { last_user_message: prompt, system_prompt_excerpt: '', conversation_turns: 1 },
};
const payload = buildJevPayload(state, process.env.JEV_MODEL);

const response = await fetch(url, {
  method: 'POST',
  headers: { 'content-type': 'application/json', authorization: `Bearer ${apiKey}` },
  body: JSON.stringify(payload),
});

const text = await response.text();
console.log(`POST ${url} -> ${response.status}`);
console.log('request:', JSON.stringify(payload, null, 2));
console.log('response:', text);

if (!response.ok) process.exit(1);

// Redaction: the recorded sample keeps field names and probabilities, never the prompt.
const redacted = {
  _recorded_at: new Date().toISOString().slice(0, 10),
  _endpoint: url,
  request: { ...payload, state: { request: { last_user_message: '<redacted>', system_prompt_excerpt: '', conversation_turns: 1 } } },
  response: JSON.parse(text),
};
const out = `fixtures/jev-${useVercel ? 'vercel' : 'typesafe'}.recorded.json`;
writeFileSync(out, `${JSON.stringify(redacted, null, 2)}\n`);
console.log(`wrote ${out}`);
