import { env } from 'cloudflare:test';
import { beforeAll, describe, expect, it } from 'vitest';
import { extractFeatures } from '../src/features';
import { logDecision, type DecisionRecord } from '../src/telemetry';
import { applyMigrations } from './apply-migrations';
import { judgments, testConfig } from './helpers';

const db = (env as unknown as { DB: D1Database }).DB;
const config = testConfig();

function record(overrides: Partial<DecisionRecord> = {}): DecisionRecord {
  return {
    request_id: crypto.randomUUID(),
    mode: 'shadow',
    features: extractFeatures({
      messages: [
        { role: 'system', content: 'secret system prompt' },
        { role: 'user', content: 'secret user content' },
      ],
    }),
    judgments: judgments(),
    judge_provider: 'typesafe',
    judge_error: null,
    judge_latency_ms: 42,
    decision: { tier: 'small', reason: 'difficulty 0 maps to small', judged_tier: 'small', pinned: false },
    served_tier: 'mid',
    upstream_latency_ms: 900,
    usage: { prompt_tokens: 1000, completion_tokens: 500, total_tokens: 1500 },
    status: 200,
    ...overrides,
  };
}

describe('telemetry', () => {
  beforeAll(applyMigrations);

  it('does not store prompt content by default', async () => {
    const entry = record();
    await logDecision(db, config, entry, false);
    const row = await db
      .prepare('SELECT features, judgments, estimated_cost_usd, estimated_cost_top_usd FROM decisions WHERE request_id = ?1')
      .bind(entry.request_id)
      .first<{ features: string; judgments: string; estimated_cost_usd: number; estimated_cost_top_usd: number }>();
    expect(row).not.toBeNull();
    expect(row!.features).not.toContain('secret');
    expect(JSON.parse(row!.features)).toMatchObject({ has_tools: false, conversation_turns: 1 });
    expect(JSON.parse(row!.judgments).difficulty.value).toBe(0);
    expect(row!.estimated_cost_usd).toBeCloseTo(0.001 * 1 + 0.0005 * 4);
    expect(row!.estimated_cost_top_usd).toBeGreaterThan(row!.estimated_cost_usd);
  });

  it('stores content only when LOG_CONTENT is on', async () => {
    const entry = record();
    await logDecision(db, config, entry, true);
    const row = await db
      .prepare('SELECT features FROM decisions WHERE request_id = ?1')
      .bind(entry.request_id)
      .first<{ features: string }>();
    expect(row!.features).toContain('secret user content');
  });

  it('records a judge failure with no judgments', async () => {
    const entry = record({ judgments: null, judge_error: 'deadline exceeded', usage: null });
    await logDecision(db, config, entry, false);
    const row = await db
      .prepare('SELECT judge_error, judgments, estimated_cost_usd FROM decisions WHERE request_id = ?1')
      .bind(entry.request_id)
      .first<{ judge_error: string; judgments: string | null; estimated_cost_usd: number | null }>();
    expect(row!.judge_error).toBe('deadline exceeded');
    expect(row!.judgments).toBeNull();
    expect(row!.estimated_cost_usd).toBeNull();
  });

  it('never throws when the table is missing', async () => {
    await expect(logDecision(db, config, record({ request_id: 'x' }), false)).resolves.toBeUndefined();
  });
});
