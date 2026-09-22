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

/**
 * Lowest confidence across the two answers that pick the tier. Jev reports no confidence for
 * a noul answer, only its probability, so their confidence is derived (distance from 0.5) and
 * they act as floors rather than as the primary choice. Letting a derived number drive the
 * escalation rule would escalate on every merely undecided noul.
 */
export function overallConfidence(judgments: Judgments): number {
  return Math.min(judgments.task_type.confidence, judgments.difficulty.confidence);
}
