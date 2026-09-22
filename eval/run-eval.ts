/**
 * Evaluates labeled orchestration scenarios through the judge and policy only. No upstream calls.
 *
 * Each line: {"id": "...", "prompt": "...", "label_tier": "<cheapest acceptable tier>"}
 * Optional per line: "system", "turns", "judgments" (a recorded judgment, replayed offline).
 *
 * Usage: npm run eval -- [--live] [--deadline-ms=3000] [eval/dataset.jsonl] [config/tiers.json]
 * --live requires Cloudflare credentials and ignores recorded judgments, so it measures Jev.
 */
import { readFileSync } from 'node:fs';
import { parseConfig, type RouterConfig } from '../src/config';
import { extractFeatures } from '../src/features';
import { JudgmentsSchema, type Judgments } from '../src/judge/questions';
import { runJudge } from '../src/judge/judge';
import { CloudflareRestJudgeProvider } from '../src/judge/providers/cloudflare-rest';
import { normaliseJevResponse } from '../src/judge/wire';
import { decide } from '../src/policy';

interface Row {
  id: string;
  prompt: string;
  label_tier: string;
  scenario?: string;
  system?: string;
  turns?: number;
  tools?: unknown[];
  max_completion_tokens?: number;
  has_image?: boolean;
  under_routing_weight?: number;
  /** A recorded Jev result, replayed offline. */
  jev?: unknown;
  /** An already normalised judgment, replayed offline. */
  judgments?: unknown;
}

const args = process.argv.slice(2);
const live = args.includes('--live');
const positional = args.filter((arg) => !arg.startsWith('--'));
const datasetPath = positional[0] ?? 'eval/dataset.example.jsonl';
const configPath = positional[1] ?? 'config/tiers.example.json';

const deadlineArg = args.find((arg) => arg.startsWith('--deadline-ms='));
const deadlineOverride = deadlineArg ? Number(deadlineArg.slice('--deadline-ms='.length)) : null;
if (deadlineOverride !== null && (!Number.isInteger(deadlineOverride) || deadlineOverride <= 0)) {
  throw new Error('--deadline-ms must be a positive integer');
}
const loadedConfig = parseConfig(JSON.parse(readFileSync(configPath, 'utf8')));
const config: RouterConfig =
  deadlineOverride === null
    ? loadedConfig
    : parseConfig({ ...loadedConfig, judge: { ...loadedConfig.judge, deadline_ms: deadlineOverride } });
const rows: Row[] = readFileSync(datasetPath, 'utf8')
  .split('\n')
  .filter((line) => line.trim().length > 0)
  .map((line) => JSON.parse(line) as Row);

const accountId = process.env['CLOUDFLARE_ACCOUNT_ID'];
const apiToken = process.env['CLOUDFLARE_API_TOKEN'];
const needsLiveJudge = rows.some((row) => row.judgments === undefined && row.jev === undefined);
if ((live || needsLiveJudge) && !(accountId && apiToken)) {
  console.error('dataset has rows without recorded judgments and no Cloudflare credentials are set; skipping');
  process.exit(78);
}
const provider =
  accountId && apiToken
    ? new CloudflareRestJudgeProvider(accountId, apiToken, config.judge.model, config.judge.base_url)
    : null;

interface Outcome {
  id: string;
  scenario: string;
  label: string;
  baseline: string;
  chosen: string;
  confidence: number;
  underRoutingWeight: number;
  baselineDelta: number;
  jevDelta: number;
  source: 'live' | 'replayed' | 'failed';
  judgeError: string | null;
}

const outcomes: Outcome[] = [];

for (const row of rows) {
  const features = extractFeatures({
    messages: [
      ...(row.system ? [{ role: 'system', content: row.system }] : []),
      {
        role: 'user',
        content: row.has_image
          ? [{ type: 'text', text: row.prompt }, { type: 'image_url', image_url: { url: 'https://example.invalid/image' } }]
          : row.prompt,
      },
    ],
    ...(row.tools ? { tools: row.tools } : {}),
    ...(row.max_completion_tokens ? { max_completion_tokens: row.max_completion_tokens } : {}),
  });
  if (row.turns) features.conversation_turns = row.turns;

  let judgments: Judgments | null = null;
  let judgeError: string | null = null;
  let source: Outcome['source'] = 'failed';
  if (!live && row.judgments !== undefined) {
    judgments = JudgmentsSchema.parse(row.judgments);
    source = 'replayed';
  } else if (!live && row.jev !== undefined) {
    judgments = normaliseJevResponse(row.jev);
    source = 'replayed';
  } else if (provider) {
    const outcome = await runJudge(provider, features, config);
    if (outcome.ok) {
      judgments = outcome.judgments;
      source = 'live';
    } else judgeError = outcome.error;
  }

  const decision = decide({ features, judgments, judge_error: judgeError, config });
  const labelIndex = config.tier_order.indexOf(row.label_tier);
  if (labelIndex < 0) throw new Error(`row ${row.id} has unknown label_tier "${row.label_tier}"`);
  const baselineIndex = config.tier_order.indexOf(config.default_tier);
  const chosenIndex = config.tier_order.indexOf(decision.tier);
  if (chosenIndex < 0) throw new Error(`row ${row.id} selected unknown tier "${decision.tier}"`);
  outcomes.push({
    id: row.id,
    scenario: row.scenario ?? 'unspecified',
    label: row.label_tier,
    baseline: config.default_tier,
    chosen: decision.tier,
    confidence: judgments ? Math.min(judgments.task_type.confidence, judgments.difficulty.confidence) : 0,
    underRoutingWeight: row.under_routing_weight ?? 1,
    baselineDelta: baselineIndex - labelIndex,
    jevDelta: chosenIndex - labelIndex,
    source,
    judgeError,
  });
}

const total = outcomes.length;
const baseline = summarise(outcomes, 'baselineDelta');
const jev = summarise(outcomes, 'jevDelta');
const correctedUnder = outcomes.filter((outcome) => outcome.baselineDelta < 0 && outcome.jevDelta === 0).length;
const avoidedOver = outcomes.filter((outcome) => outcome.baselineDelta > 0 && outcome.jevDelta === 0).length;
const liveRows = outcomes.filter((outcome) => outcome.source === 'live').length;
const failedRows = outcomes.filter((outcome) => outcome.source === 'failed');
const successfulLive = outcomes.filter((outcome) => outcome.source === 'live');
const successfulLiveBaseline = summarise(successfulLive, 'baselineDelta');
const successfulLiveJev = summarise(successfulLive, 'jevDelta');

console.log(`rows: ${total}`);
console.log(
  `judgment source: ${live ? `live Jev (${liveRows}/${total}); judge failures: ${failedRows.length}/${total}` : 'replayed (policy regression only; not a Jev quality result)'}`,
);
if (deadlineOverride !== null) console.log(`evaluation-only judge deadline: ${deadlineOverride}ms`);
printMetrics(`fixed baseline (${config.default_tier})`, baseline);
printMetrics('Jev-assisted serving policy (includes fail-open)', jev);
if (live) {
  printMetrics('fixed baseline on successful Jev judgments', successfulLiveBaseline);
  printMetrics('Jev decision quality on successful judgments', successfulLiveJev);
}
console.log(`baseline under-routes corrected by Jev: ${pct(correctedUnder, total)}`);
console.log(`baseline over-routes avoided by Jev: ${pct(avoidedOver, total)}`);

console.log('\nscenario decisions:');
for (const outcome of outcomes) {
  const failure = outcome.judgeError ? `, judge_error=${outcome.judgeError}` : '';
  console.log(`  ${outcome.id} (${outcome.scenario}): label=${outcome.label}, baseline=${outcome.baseline}, jev=${outcome.chosen}, source=${outcome.source}${failure}`);
}

console.log('\ncalibration by judge confidence:');
for (const [lo, hi] of [
  [0, 0.5],
  [0.5, 0.7],
  [0.7, 0.9],
  [0.9, 1.01],
] as const) {
  const bucket = outcomes.filter((o) => o.confidence >= lo && o.confidence < hi);
  if (bucket.length === 0) continue;
  const correct = bucket.filter((outcome) => outcome.jevDelta === 0).length;
  console.log(`  [${lo}, ${hi}): n=${bucket.length} accuracy=${pct(correct, bucket.length)}`);
}

const topTier = config.tier_order[config.tier_order.length - 1] as string;
console.log(`\nestimated savings against always using ${topTier}: ${savings().toFixed(1)}%`);
console.log(`\nrun date: ${new Date().toISOString().slice(0, 10)}, dataset: ${datasetPath}`);

function pct(part: number, whole: number): string {
  return whole === 0 ? 'n/a' : `${((part / whole) * 100).toFixed(1)}% (${part}/${whole})`;
}

function summarise(
  outcomes: Outcome[],
  deltaKey: 'baselineDelta' | 'jevDelta',
): { exact: number; under: number; weightedUnder: number; over: number } {
  return {
    exact: outcomes.filter((outcome) => outcome[deltaKey] === 0).length,
    under: outcomes.filter((outcome) => outcome[deltaKey] < 0).length,
    weightedUnder: outcomes
      .filter((outcome) => outcome[deltaKey] < 0)
      .reduce((sum, outcome) => sum + outcome.underRoutingWeight, 0),
    over: outcomes.filter((outcome) => outcome[deltaKey] > 0).length,
  };
}

function printMetrics(name: string, metrics: { exact: number; under: number; weightedUnder: number; over: number }): void {
  console.log(`\n${name}:`);
  console.log(`  exact routing: ${pct(metrics.exact, total)}`);
  console.log(`  under-routing: ${pct(metrics.under, total)}`);
  console.log(`  severity-weighted under-routing impact: ${metrics.weightedUnder.toFixed(1)}`);
  console.log(`  over-routing: ${pct(metrics.over, total)}`);
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
