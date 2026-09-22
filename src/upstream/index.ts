import type { TierConfig } from '../config';
import type { UpstreamProvider } from './upstream';
import { AnthropicProvider } from './providers/anthropic';
import { OpenAiCompatibleProvider } from './providers/openai-compatible';

const openai = new OpenAiCompatibleProvider();
const anthropic = new AnthropicProvider();

export function createUpstreamProvider(tier: TierConfig): UpstreamProvider {
  return tier.provider === 'anthropic' ? anthropic : openai;
}

export * from './upstream';
