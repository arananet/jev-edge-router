import type { RouterConfig } from './config';
import type { RequestFeatures } from './features';
import type { Judgments } from './judge/questions';
import type { Decision } from './policy';
import { estimateCostUsd } from './upstream/upstream';
import type { Usage } from './types';

export interface DecisionRecord {
  request_id: string;
  mode: string;
  features: RequestFeatures;
  judgments: Judgments | null;
  judge_provider: string | null;
  judge_error: string | null;
  judge_latency_ms: number | null;
  decision: Decision;
  served_tier: string;
  upstream_latency_ms: number | null;
  usage: Usage | null;
  status: number;
}

/**
 * Prompt content is not stored unless LOG_CONTENT is on, which exists for local eval
 * collection only. The stored feature blob is stripped here, not at the call site.
 */
function redactFeatures(features: RequestFeatures, logContent: boolean): Record<string, unknown> {
  const { last_user_message, system_prompt_excerpt, ...rest } = features;
  return logContent ? { ...rest, last_user_message, system_prompt_excerpt } : rest;
}

export async function logDecision(
  db: D1Database | undefined,
  config: RouterConfig,
  record: DecisionRecord,
  logContent: boolean,
): Promise<void> {
  if (!db) return;
  const servedTier = config.tiers[record.served_tier];
  const topTierName = config.tier_order[config.tier_order.length - 1] as string;
  const topTier = config.tiers[topTierName];
  const cost = servedTier ? estimateCostUsd(servedTier, record.usage) : null;
  const costIfTop = topTier ? estimateCostUsd(topTier, record.usage) : null;

  try {
    await db
      .prepare(
        `INSERT INTO decisions (
           request_id, created_at, mode, features, judgments, judge_provider, judge_error,
           judge_latency_ms, chosen_tier, served_tier, reason, upstream_latency_ms,
           prompt_tokens, completion_tokens, estimated_cost_usd, estimated_cost_top_usd, status
         ) VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11, ?12, ?13, ?14, ?15, ?16, ?17)`,
      )
      .bind(
        record.request_id,
        new Date().toISOString(),
        record.mode,
        JSON.stringify(redactFeatures(record.features, logContent)),
        record.judgments ? JSON.stringify(record.judgments) : null,
        record.judge_provider,
        record.judge_error,
        record.judge_latency_ms,
        record.decision.tier,
        record.served_tier,
        record.decision.reason,
        record.upstream_latency_ms,
        record.usage?.prompt_tokens ?? null,
        record.usage?.completion_tokens ?? null,
        cost,
        costIfTop,
        record.status,
      )
      .run();
  } catch (err) {
    // Telemetry never breaks a served request. A lost row is cheaper than a failed call.
    console.warn(`decision log failed: ${(err as Error).message}`);
  }
}
