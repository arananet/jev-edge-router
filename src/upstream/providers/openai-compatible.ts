import { z } from 'zod';
import type { TierConfig } from '../../config';
import type { ChatCompletionRequest, Usage } from '../../types';
import type { UpstreamProvider, UpstreamResult } from '../upstream';

const UsageSchema = z.object({
  prompt_tokens: z.number(),
  completion_tokens: z.number(),
  total_tokens: z.number(),
});

/**
 * Covers OpenAI, OpenRouter, the Workers AI OpenAI endpoint and local servers.
 * Streaming responses are passed through untouched so SSE framing is never rewritten.
 */
export class OpenAiCompatibleProvider implements UpstreamProvider {
  readonly name = 'openai-compatible';

  async send(
    req: ChatCompletionRequest,
    tier: TierConfig,
    apiKey: string,
    signal?: AbortSignal,
  ): Promise<UpstreamResult> {
    const url = `${(tier.base_url ?? '').replace(/\/$/, '')}/chat/completions`;
    const body = { ...req, model: tier.model };
    const start = Date.now();
    const upstream = await fetch(url, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        ...(apiKey ? { authorization: `Bearer ${apiKey}` } : {}),
      },
      body: JSON.stringify(body),
      ...(signal ? { signal } : {}),
    });
    const latency = Date.now() - start;

    if (req.stream === true || !upstream.ok) {
      return { response: passthrough(upstream), usage: null, latency_ms: latency };
    }

    const raw: unknown = await upstream.json();
    return {
      response: new Response(JSON.stringify(raw), {
        status: upstream.status,
        headers: { 'content-type': 'application/json' },
      }),
      usage: readUsage(raw),
      latency_ms: latency,
    };
  }
}

export function readUsage(raw: unknown): Usage | null {
  if (typeof raw !== 'object' || raw === null || !('usage' in raw)) return null;
  const parsed = UsageSchema.safeParse((raw as { usage: unknown }).usage);
  return parsed.success ? parsed.data : null;
}

export function passthrough(upstream: Response): Response {
  const headers = new Headers(upstream.headers);
  headers.delete('content-encoding');
  headers.delete('content-length');
  return new Response(upstream.body, { status: upstream.status, headers });
}
