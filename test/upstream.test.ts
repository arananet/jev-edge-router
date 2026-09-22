import { describe, expect, it } from 'vitest';
import { parseConfig } from '../src/config';
import exampleConfig from '../config/tiers.example.json';
import { finishReason, toAnthropicRequest, translateStream } from '../src/upstream/providers/anthropic';
import { readUsage } from '../src/upstream/providers/openai-compatible';
import { estimateCostUsd } from '../src/upstream/upstream';

const config = parseConfig(exampleConfig);
const topTier = config.tiers['top']!;

describe('anthropic translation', () => {
  it('lifts system messages and merges same role turns', () => {
    const body = toAnthropicRequest(
      {
        messages: [
          { role: 'system', content: 'be terse' },
          { role: 'user', content: 'one' },
          { role: 'user', content: 'two' },
          { role: 'assistant', content: 'ok' },
        ],
        max_tokens: 256,
      },
      topTier,
    ) as { system: string; messages: Array<{ role: string; content: string }>; max_tokens: number };
    expect(body.system).toBe('be terse');
    expect(body.messages).toEqual([
      { role: 'user', content: 'one\n\ntwo' },
      { role: 'assistant', content: 'ok' },
    ]);
    expect(body.max_tokens).toBe(256);
  });

  it('always sends a max_tokens, which the Messages API requires', () => {
    const body = toAnthropicRequest({ messages: [{ role: 'user', content: 'hi' }] }, topTier) as {
      max_tokens: number;
    };
    expect(body.max_tokens).toBeGreaterThan(0);
  });

  it('maps stop reasons to OpenAI finish reasons', () => {
    expect(finishReason('max_tokens')).toBe('length');
    expect(finishReason('tool_use')).toBe('tool_calls');
    expect(finishReason('end_turn')).toBe('stop');
    expect(finishReason(null)).toBe('stop');
  });

  it('rewrites the Anthropic event stream as OpenAI chunks', async () => {
    const events = [
      'event: content_block_delta\ndata: {"type":"content_block_delta","delta":{"type":"text_delta","text":"he"}}',
      'event: content_block_delta\ndata: {"type":"content_block_delta","delta":{"type":"text_delta","text":"llo"}}',
      'event: message_delta\ndata: {"type":"message_delta","delta":{"stop_reason":"end_turn"}}',
    ].join('\n\n');
    const upstream = new Response(events);
    const text = await new Response(translateStream(upstream, 'model-x')).text();
    expect(text).toContain('"chat.completion.chunk"');
    expect(text).toContain('"content":"he"');
    expect(text).toContain('"content":"llo"');
    expect(text).toContain('"finish_reason":"stop"');
    expect(text.trimEnd().endsWith('data: [DONE]')).toBe(true);
  });
});

describe('usage and cost', () => {
  it('reads a well formed usage block and ignores a malformed one', () => {
    expect(readUsage({ usage: { prompt_tokens: 10, completion_tokens: 5, total_tokens: 15 } })).toEqual({
      prompt_tokens: 10,
      completion_tokens: 5,
      total_tokens: 15,
    });
    expect(readUsage({ usage: { prompt_tokens: 'ten' } })).toBeNull();
    expect(readUsage({})).toBeNull();
  });

  it('estimates cost from the tier prices', () => {
    const cost = estimateCostUsd(topTier, { prompt_tokens: 1_000_000, completion_tokens: 0, total_tokens: 1_000_000 });
    expect(cost).toBeCloseTo(topTier.price_in_per_mtok);
    expect(estimateCostUsd(topTier, null)).toBeNull();
  });
});
