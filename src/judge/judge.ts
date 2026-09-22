import type { RouterConfig } from '../config';
import type { RequestFeatures } from '../features';
import { buildState, type JudgeState, type Judgments } from './questions';

export interface JudgeProvider {
  readonly name: string;
  /** One request, all questions, evaluated against the same state. No retries. */
  judge(state: JudgeState, signal: AbortSignal): Promise<Judgments>;
}

export type JudgeOutcome =
  | { ok: true; judgments: Judgments; latency_ms: number; provider: string }
  | { ok: false; error: string; latency_ms: number; provider: string };

/**
 * Fail open, fail upward: a judge that times out or errors never blocks the request.
 * The caller falls back to default_tier (see policy rule 3).
 */
export async function runJudge(
  provider: JudgeProvider,
  features: RequestFeatures,
  config: RouterConfig,
): Promise<JudgeOutcome> {
  const state = buildState(features, config.judge.max_chars);
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), config.judge.deadline_ms);
  const start = Date.now();
  try {
    const judgments = await provider.judge(state, controller.signal);
    return { ok: true, judgments, latency_ms: Date.now() - start, provider: provider.name };
  } catch (err) {
    const aborted = controller.signal.aborted;
    const message = aborted ? `judge deadline ${config.judge.deadline_ms}ms exceeded` : (err as Error).message;
    return { ok: false, error: message, latency_ms: Date.now() - start, provider: provider.name };
  } finally {
    clearTimeout(timer);
  }
}

/** Lowest confidence across the questions the policy actually reads. */
export function overallConfidence(judgments: Judgments): number {
  return Math.min(
    judgments.task_type.confidence,
    judgments.difficulty.confidence,
    judgments.high_stakes.confidence,
    judgments.needs_long_output.confidence,
  );
}
