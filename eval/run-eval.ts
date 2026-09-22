/**
 * Replays a labeled JSONL dataset through the judge and policy only. No upstream calls.
 *
 * Each line: {"id": "...", "prompt": "...", "label_tier": "<cheapest acceptable tier>"}
 * Optional per line: "system", "turns", "judgments" (a recorded judgment, replayed offline).
 *
 * Usage: npm run eval -- eval/dataset.jsonl [config/tiers.json]
 * With no TYPESAFE_API_KEY and no recorded judgments, the run exits 78 and says so.
 */
import { readFileSync } from 'node:fs';
import { parseConfig, type RouterConfig } from '../src/config';
import { extractFeatures } from '../src/features';
import { JudgmentsSchema, type Judgments } from '../src/judge/questions';
import { runJudge } from '../src/judge/judge';
import { TypeSafeJudgeProvider } from '../src/judge/providers/typesafe';
import { decide } from '../src/policy';

interface Row {
  id: string;
  prompt: string;
  label_tier: string;
  system?: string;
  turns?: number;
  judgments?: unknown;
}

const datasetPath = process.argv[2] ?? 'eval/dataset.jsonl';
const configPath = process.argv[3] ?? 'config/tiers.json';

const config: RouterConfig = parseConfig(JSON.parse(readFileSync(configPath, 'utf8')));
const rows: Row[] = readFileSync(datasetPath, 'utf8')
  .split('\n')
  .filter((line) => line.trim().length > 0)
  .map((line) => JSON.parse(line) as Row);

const apiKey = process.env.TYPESAFE_API_KEY;
const needsLiveJudge = rows.some((row) => row.judgments === undefined);
if (needsLiveJudge && !apiKey) {
  console.error('dataset has rows without recorded judgments and TYPESAFE_API_KEY is not set; skipping');
  process.exit(78);
}
const provider = apiKey ? new TypeSafeJudgeProvider(apiKey, config.judge.base_url, config.judge.model) : null;

interface Outcome {
  id: string;
  label: string;
  chosen: string;
  confidence: number;
  delta: number;
}

const outcomes: Outcome[] = [];

for (const row of rows) {
  const features = extractFeatures({
    messages: [
      ...(row.system ? [{ role: 'system', content: row.system }] : []),
      { role: 'user', content: row.prompt },
    ],
  });
  if (row.turns) features.conversation_turns = row.turns;

  let judgments: Judgments | null = null;
  let judgeError: string | null = null;
  if (row.judgments !== undefined) {
    judgments = JudgmentsSchema.parse(row.judgments);
  } else if (provider) {
    const outcome = await runJudge(provider, features, config);
    if (outcome.ok) judgments = outcome.judgments;
    else judgeError = outcome.error;
  }

  const decision = decide({ features, judgments, judge_error: judgeError, config });
  const labelIndex = config.tier_order.indexOf(row.label_tier);
  const chosenIndex = config.tier_order.indexOf(decision.tier);
  outcomes.push({
    id: row.id,
    label: row.label_tier,
    chosen: decision.tier,
    confidence: judgments ? Math.min(judgments.task_type.confidence, judgments.difficulty.confidence) : 0,
    delta: chosenIndex - labelIndex,
  });
}

const total = outcomes.length;
const exact = outcomes.filter((o) => o.delta === 0).length;
const under = outcomes.filter((o) => o.delta < 0).length;
const over = outcomes.filter((o) => o.delta > 0).length;

console.log(`rows: ${total}`);
console.log(`routing accuracy: ${pct(exact, total)}`);
console.log(`under-routing (sent too low, the costly failure): ${pct(under, total)}`);
console.log(`over-routing (sent too high): ${pct(over, total)}`);

console.log('\ncalibration by judge confidence:');
for (const [lo, hi] of [
  [0, 0.5],
  [0.5, 0.7],
  [0.7, 0.9],
  [0.9, 1.01],
] as const) {
  const bucket = outcomes.filter((o) => o.confidence >= lo && o.confidence < hi);
  if (bucket.length === 0) continue;
  const correct = bucket.filter((o) => o.delta === 0).length;
  console.log(`  [${lo}, ${hi}): n=${bucket.length} accuracy=${pct(correct, bucket.length)}`);
}

const topTier = config.tier_order[config.tier_order.length - 1] as string;
console.log(`\nestimated savings against always using ${topTier}: ${savings().toFixed(1)}%`);
console.log(`\nrun date: ${new Date().toISOString().slice(0, 10)}, dataset: ${datasetPath}`);

function pct(part: number, whole: number): string {
  return whole === 0 ? 'n/a' : `${((part / whole) * 100).toFixed(1)}% (${part}/${whole})`;
}

/**
 * Savings use a fixed notional 1k in / 1k out per request, so the number compares tiers,
 * not real traffic. Replace with measured usage before quoting it anywhere.
 */
function savings(): number {
  const notionalIn = 1000 / 1_000_000;
  const notionalOut = 1000 / 1_000_000;
  const price = (name: string): number => {
    const tier = config.tiers[name];
    if (!tier) return 0;
    return notionalIn * tier.price_in_per_mtok + notionalOut * tier.price_out_per_mtok;
  };
  const routed = outcomes.reduce((sum, o) => sum + price(o.chosen), 0);
  const allTop = outcomes.length * price(topTier);
  return allTop === 0 ? 0 : ((allTop - routed) / allTop) * 100;
}
