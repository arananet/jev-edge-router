import { z } from 'zod';
import type { TierConfig } from '../../config';
import type { ChatCompletionRequest, ChatMessage, Usage } from '../../types';
import type { UpstreamProvider, UpstreamResult } from '../upstream';
import { passthrough } from './openai-compatible';

const API_VERSION = '2023-06-01';
const DEFAULT_MAX_TOKENS = 4096;

const AnthropicResponseSchema = z.object({
  id: z.string(),
  model: z.string(),
  stop_reason: z.string().nullable().optional(),
  content: z.array(z.object({ type: z.string(), text: z.string().optional() }).passthrough()),
  usage: z.object({ input_tokens: z.number(), output_tokens: z.number() }),
});

/** Translates the OpenAI Chat Completions shape to the Anthropic Messages API and back. */
export class AnthropicProvider implements UpstreamProvider {
  readonly name = 'anthropic';

  async send(
    req: ChatCompletionRequest,
    tier: TierConfig,
    apiKey: string,
    signal?: AbortSignal,
  ): Promise<UpstreamResult> {
    const url = `${(tier.base_url ?? 'https://api.anthropic.com/v1').replace(/\/$/, '')}/messages`;
    const start = Date.now();
    const upstream = await fetch(url, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        'anthropic-version': API_VERSION,
        'x-api-key': apiKey,
      },
      body: JSON.stringify(toAnthropicRequest(req, tier)),
      ...(signal ? { signal } : {}),
    });
    const latency = Date.now() - start;

    if (!upstream.ok) {
      return { response: passthrough(upstream), usage: null, latency_ms: latency };
    }
    if (req.stream === true) {
      return {
        response: new Response(translateStream(upstream, tier.model), {
          status: 200,
          headers: {
            'content-type': 'text/event-stream',
            'cache-control': 'no-cache',
            connection: 'keep-alive',
          },
        }),
        usage: null,
        latency_ms: latency,
      };
    }

    const parsed = AnthropicResponseSchema.parse(await upstream.json());
    const usage: Usage = {
      prompt_tokens: parsed.usage.input_tokens,
      completion_tokens: parsed.usage.output_tokens,
      total_tokens: parsed.usage.input_tokens + parsed.usage.output_tokens,
    };
    const text = parsed.content
      .filter((block) => block.type === 'text' && typeof block.text === 'string')
      .map((block) => block.text)
      .join('');

    const body = {
      id: parsed.id,
      object: 'chat.completion',
      created: Math.floor(Date.now() / 1000),
      model: parsed.model,
      choices: [
        {
          index: 0,
          message: { role: 'assistant', content: text },
          finish_reason: finishReason(parsed.stop_reason ?? null),
        },
      ],
      usage,
    };
    return {
      response: new Response(JSON.stringify(body), { status: 200, headers: { 'content-type': 'application/json' } }),
      usage,
      latency_ms: latency,
    };
  }
}

export function finishReason(stopReason: string | null): string {
  switch (stopReason) {
    case 'max_tokens':
      return 'length';
    case 'tool_use':
      return 'tool_calls';
    default:
      return 'stop';
  }
}

export function toAnthropicRequest(req: ChatCompletionRequest, tier: TierConfig): Record<string, unknown> {
  const system: string[] = [];
  const messages: Array<{ role: 'user' | 'assistant'; content: string }> = [];

  for (const message of req.messages) {
    const text = plainText(message);
    if (message.role === 'system' || message.role === 'developer') {
      if (text) system.push(text);
      continue;
    }
    const role = message.role === 'assistant' ? 'assistant' : 'user';
    const last = messages[messages.length - 1];
    if (last && last.role === role) {
      last.content = `${last.content}\n\n${text}`;
    } else {
      messages.push({ role, content: text });
    }
  }

  return {
    model: tier.model,
    max_tokens: req.max_completion_tokens ?? req.max_tokens ?? DEFAULT_MAX_TOKENS,
    ...(system.length > 0 ? { system: system.join('\n\n') } : {}),
    ...(typeof req.temperature === 'number' ? { temperature: req.temperature } : {}),
    ...(req.stream === true ? { stream: true } : {}),
    messages,
  };
}

function plainText(message: ChatMessage): string {
  const content = message.content;
  if (typeof content === 'string') return content;
  if (!Array.isArray(content)) return '';
  return content
    .map((part) => (typeof part === 'object' && part !== null && 'text' in part && typeof part.text === 'string' ? part.text : ''))
    .join('');
}

/** Rewrites Anthropic SSE events as OpenAI chat.completion.chunk events. */
export function translateStream(upstream: Response, model: string): ReadableStream<Uint8Array> {
  const id = `chatcmpl-${crypto.randomUUID()}`;
  const created = Math.floor(Date.now() / 1000);
  const encoder = new TextEncoder();
  const decoder = new TextDecoder();
  const reader = (upstream.body ?? new ReadableStream<Uint8Array>()).getReader();
  let buffer = '';
  let sentRole = false;

  const chunk = (delta: Record<string, unknown>, finish: string | null): Uint8Array =>
    encoder.encode(
      `data: ${JSON.stringify({
        id,
        object: 'chat.completion.chunk',
        created,
        model,
        choices: [{ index: 0, delta, finish_reason: finish }],
      })}\n\n`,
    );

  const handleBlock = (block: string, controller: ReadableStreamDefaultController<Uint8Array>): void => {
    const dataLine = block.split('\n').find((line) => line.startsWith('data:'));
    if (!dataLine) return;
    let event: unknown;
    try {
      event = JSON.parse(dataLine.slice(5).trim());
    } catch {
      return;
    }
    if (typeof event !== 'object' || event === null) return;
    const type = (event as { type?: string }).type;
    if (type === 'content_block_delta') {
      const text = (event as { delta?: { text?: string } }).delta?.text;
      if (typeof text !== 'string') return;
      if (!sentRole) {
        controller.enqueue(chunk({ role: 'assistant', content: '' }, null));
        sentRole = true;
      }
      controller.enqueue(chunk({ content: text }, null));
    } else if (type === 'message_delta') {
      const stop = (event as { delta?: { stop_reason?: string | null } }).delta?.stop_reason ?? null;
      controller.enqueue(chunk({}, finishReason(stop)));
    }
  };

  return new ReadableStream<Uint8Array>({
    async pull(controller) {
      const { done, value } = await reader.read();
      if (done) {
        // A final event may arrive without its trailing blank line.
        if (buffer.trim().length > 0) handleBlock(buffer, controller);
        buffer = '';
        controller.enqueue(encoder.encode('data: [DONE]\n\n'));
        controller.close();
        return;
      }
      buffer += decoder.decode(value, { stream: true });
      const blocks = buffer.split('\n\n');
      buffer = blocks.pop() ?? '';
      for (const block of blocks) handleBlock(block, controller);
    },
    cancel(reason) {
      void reader.cancel(reason);
    },
  });
}
