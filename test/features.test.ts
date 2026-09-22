import { describe, expect, it } from 'vitest';
import { extractFeatures } from '../src/features';

describe('extractFeatures', () => {
  it('reads the last user message and the first system prompt', () => {
    const features = extractFeatures({
      messages: [
        { role: 'system', content: 'be terse' },
        { role: 'user', content: 'first' },
        { role: 'assistant', content: 'ok' },
        { role: 'user', content: 'second' },
      ],
    });
    expect(features.last_user_message).toBe('second');
    expect(features.system_prompt_excerpt).toBe('be terse');
    expect(features.conversation_turns).toBe(3);
  });

  it('flattens array content and detects images', () => {
    const features = extractFeatures({
      messages: [
        {
          role: 'user',
          content: [
            { type: 'text', text: 'what is this' },
            { type: 'image_url', image_url: { url: 'https://example.com/a.png' } },
          ],
        },
      ],
    });
    expect(features.has_images).toBe(true);
    expect(features.last_user_message).toBe('what is this');
  });

  it('detects tools, functions and pinned models', () => {
    const withTools = extractFeatures({ messages: [{ role: 'user', content: 'hi' }], tools: [{}] });
    const withFunctions = extractFeatures({ messages: [{ role: 'user', content: 'hi' }], functions: [{}] });
    const pinned = extractFeatures({ model: 'gpt-4o', messages: [{ role: 'user', content: 'hi' }] });
    expect(withTools.has_tools).toBe(true);
    expect(withFunctions.has_tools).toBe(true);
    expect(pinned.pinned_model).toBe('gpt-4o');
    expect(withTools.pinned_model).toBeNull();
  });

  it('estimates prompt tokens from content length', () => {
    const short = extractFeatures({ messages: [{ role: 'user', content: 'hi' }] });
    const long = extractFeatures({ messages: [{ role: 'user', content: 'x'.repeat(40_000) }] });
    expect(short.estimated_prompt_tokens).toBeLessThan(10);
    expect(long.estimated_prompt_tokens).toBeGreaterThan(9_000);
  });
});
