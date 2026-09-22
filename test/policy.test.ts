import { describe, expect, it } from 'vitest';
import { extractFeatures, type RequestFeatures } from '../src/features';
import { decide } from '../src/policy';
import { judgments, testConfig } from './helpers';

function features(overrides: Partial<RequestFeatures> = {}): RequestFeatures {
  return { ...extractFeatures({ messages: [{ role: 'user', content: 'hello' }] }), ...overrides };
}

describe('policy', () => {
  const config = testConfig();

  it('maps each difficulty level through the config table', () => {
    const expected: Record<number, string> = { 0: 'small', 1: 'small', 2: 'mid', 3: 'top' };
    for (const [level, tier] of Object.entries(expected)) {
      const decision = decide({
        features: features(),
        judgments: judgments({ difficulty: { value: Number(level), confidence: 0.9 } }),
        judge_error: null,
        config,
      });
      expect(decision.tier, `difficulty ${level}`).toBe(tier);
    }
  });

  it('falls back to the default tier when the judge failed', () => {
    const decision = decide({ features: features(), judgments: null, judge_error: 'timeout', config });
    expect(decision.tier).toBe('mid');
    expect(decision.reason).toContain('judge unavailable');
  });

  it('escalates one tier when confidence is below the threshold', () => {
    const decision = decide({
      features: features(),
      judgments: judgments({ difficulty: { value: 0, confidence: 0.2 } }),
      judge_error: null,
      config,
    });
    expect(decision.tier).toBe('mid');
    expect(decision.reason).toContain('escalated');
  });

  it('does not escalate past the top tier', () => {
    const decision = decide({
      features: features(),
      judgments: judgments({ difficulty: { value: 3, confidence: 0.1 } }),
      judge_error: null,
      config,
    });
    expect(decision.tier).toBe('top');
    expect(decision.reason).toContain('already at top tier');
  });

  it('enforces the high stakes minimum tier', () => {
    const decision = decide({
      features: features(),
      judgments: judgments({ high_stakes: { probability: 0.95, confidence: 0.9 } }),
      judge_error: null,
      config,
    });
    expect(decision.tier).toBe('top');
    expect(decision.reason).toContain('high stakes');
  });

  it('leaves high stakes alone at or below the threshold', () => {
    const decision = decide({
      features: features(),
      judgments: judgments({ high_stakes: { probability: 0.8, confidence: 0.9 } }),
      judge_error: null,
      config,
    });
    expect(decision.tier).toBe('small');
  });

  it('applies the task type floor', () => {
    const decision = decide({
      features: features(),
      judgments: judgments({ task_type: { value: 'code_debugging', confidence: 0.9 } }),
      judge_error: null,
      config,
    });
    expect(decision.tier).toBe('mid');
    expect(decision.reason).toContain('code_debugging');
  });

  it('applies the long output floor', () => {
    const decision = decide({
      features: features(),
      judgments: judgments({ needs_long_output: { probability: 0.9, confidence: 0.9 } }),
      judge_error: null,
      config,
    });
    expect(decision.tier).toBe('mid');
    expect(decision.reason).toContain('long output');
  });

  it('never lowers a tier the judgments already raised', () => {
    const decision = decide({
      features: features(),
      judgments: judgments({
        difficulty: { value: 3, confidence: 0.9 },
        task_type: { value: 'chit_chat', confidence: 0.9 },
      }),
      judge_error: null,
      config,
    });
    expect(decision.tier).toBe('top');
  });

  it('moves images off a tier that cannot serve them', () => {
    const decision = decide({
      features: features({ has_images: true }),
      judgments: judgments(),
      judge_error: null,
      config,
    });
    expect(decision.tier).toBe('mid');
    expect(decision.reason).toContain('cannot serve');
  });

  it('moves a request off a tier whose context window is too small', () => {
    const decision = decide({
      features: features({ estimated_prompt_tokens: 150_000 }),
      judgments: judgments(),
      judge_error: null,
      config,
    });
    expect(decision.tier).toBe('mid');
  });

  it('counts requested max_tokens against the context window', () => {
    const decision = decide({
      features: features({ estimated_prompt_tokens: 127_000, requested_max_tokens: 8_000 }),
      judgments: judgments(),
      judge_error: null,
      config,
    });
    expect(decision.tier).toBe('mid');
  });

  it('uses the top tier when no tier can satisfy the request', () => {
    const decision = decide({
      features: features({ estimated_prompt_tokens: 5_000_000 }),
      judgments: judgments(),
      judge_error: null,
      config,
    });
    expect(decision.tier).toBe('top');
    expect(decision.reason).toContain('no tier satisfies');
  });

  it('keeps a hard requirement even when the judge failed', () => {
    const decision = decide({
      features: features({ has_images: true, estimated_prompt_tokens: 10 }),
      judgments: null,
      judge_error: 'timeout',
      config,
    });
    expect(decision.tier).toBe('mid');
  });

  it('ignores client pinning by default', () => {
    const decision = decide({
      features: features({ pinned_model: 'replace-me-top' }),
      judgments: judgments(),
      judge_error: null,
      config,
    });
    expect(decision.pinned).toBe(false);
    expect(decision.tier).toBe('small');
  });

  it('honours client pinning when config allows it', () => {
    const decision = decide({
      features: features({ pinned_model: 'replace-me-top' }),
      judgments: judgments(),
      judge_error: null,
      config: testConfig({ allow_client_model_pinning: true }),
    });
    expect(decision.pinned).toBe(true);
    expect(decision.tier).toBe('top');
  });

  it('ignores an unknown pinned model', () => {
    const decision = decide({
      features: features({ pinned_model: 'not-a-configured-model' }),
      judgments: judgments(),
      judge_error: null,
      config: testConfig({ allow_client_model_pinning: true }),
    });
    expect(decision.pinned).toBe(false);
    expect(decision.tier).toBe('small');
  });

  it('always explains itself', () => {
    const decision = decide({ features: features(), judgments: judgments(), judge_error: null, config });
    expect(decision.reason.length).toBeGreaterThan(0);
  });
});
