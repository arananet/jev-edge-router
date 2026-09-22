import type { TierConfig } from '../config';
import type { ChatCompletionRequest, Usage } from '../types';

export interface UpstreamResult {
  response: Response;
  /** Usage, when the upstream reported it on a non streaming response. */
  usage: Usage | null;
  latency_ms: number;
}

export interface UpstreamProvider {
  readonly name: string;
  /** Sends the request upstream and returns an OpenAI shaped response, streaming passed through. */
  send(req: ChatCompletionRequest, tier: TierConfig, apiKey: string, signal?: AbortSignal): Promise<UpstreamResult>;
}

export function estimateCostUsd(tier: TierConfig, usage: Usage | null): number | null {
  if (!usage) return null;
  return (
    (usage.prompt_tokens / 1_000_000) * tier.price_in_per_mtok +
    (usage.completion_tokens / 1_000_000) * tier.price_out_per_mtok
  );
}
