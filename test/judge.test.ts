import { describe, expect, it } from 'vitest';
import arrayFixture from '../fixtures/jev-response.synthetic.json';
import objectFixture from '../fixtures/jev-response.object-form.synthetic.json';
import { runJudge, overallConfidence, type JudgeProvider } from '../src/judge/judge';
import { buildState, type JudgeState } from '../src/judge/questions';
import { buildJevPayload, normaliseJevResponse } from '../src/judge/wire';
import { extractFeatures } from '../src/features';
import { testConfig } from './helpers';

const features = extractFeatures({
  messages: [
    { role: 'system', content: 'you are terse' },
    { role: 'user', content: 'why is my worker returning 522?' },
  ],
});

describe('judge wire format', () => {
  it('normalises the array answer form', () => {
    const judgments = normaliseJevResponse(arrayFixture);
    expect(judgments.task_type.value).toBe('code_debugging');
    expect(judgments.difficulty.value).toBe(2);
    expect(judgments.high_stakes.probability).toBeCloseTo(0.08);
  });

  it('normalises the object answer form, booleans and distributions', () => {
    const judgments = normaliseJevResponse(objectFixture);
    expect(judgments.task_type.value).toBe('chit_chat');
    expect(judgments.task_type.confidence).toBeCloseTo(0.93);
    expect(judgments.needs_long_output.probability).toBe(0);
    expect(judgments.high_stakes.probability).toBeCloseTo(0.02);
  });

  it('rejects a response with a missing answer', () => {
    expect(() => normaliseJevResponse({ answers: [{ name: 'task_type', value: 'chit_chat', confidence: 1 }] })).toThrow(
      /missing answer "difficulty"/,
    );
  });

  it('rejects an unknown task type', () => {
    const raw = { answers: { ...(objectFixture.answers as Record<string, unknown>), task_type: { value: 'vibes' } } };
    expect(() => normaliseJevResponse(raw)).toThrow(/unknown task_type/);
  });

  it('asks every question in one payload', () => {
    const state: JudgeState = buildState(features, 100);
    const payload = buildJevPayload(state, 'jev-1') as { questions: Array<{ name: string; type: string }> };
    expect(payload.questions.map((q) => q.name)).toEqual([
      'task_type',
      'difficulty',
      'needs_long_output',
      'high_stakes',
    ]);
    expect(payload.questions.map((q) => q.type)).toEqual(['Choice', 'Score', 'Noul', 'Noul']);
  });

  it('truncates free text to the configured budget', () => {
    const long = extractFeatures({ messages: [{ role: 'user', content: 'x'.repeat(5000) }] });
    const state = buildState(long, 100);
    expect(state.request.last_user_message.length).toBe(101); // 100 chars plus the ellipsis
  });

  it('keeps computed features out of the judge state', () => {
    const state = buildState(features, 2000);
    expect(Object.keys(state.request).sort()).toEqual([
      'conversation_turns',
      'last_user_message',
      'system_prompt_excerpt',
    ]);
  });
});

describe('runJudge', () => {
  const config = testConfig({ judge: { provider: 'cloudflare', deadline_ms: 50, max_chars: 2000 } });

  it('returns judgments on success', async () => {
    const provider: JudgeProvider = {
      name: 'fake',
      judge: async () => normaliseJevResponse(arrayFixture),
    };
    const outcome = await runJudge(provider, features, config);
    expect(outcome.ok).toBe(true);
    if (outcome.ok) expect(outcome.judgments.task_type.value).toBe('code_debugging');
  });

  it('fails open when the provider throws', async () => {
    const provider: JudgeProvider = {
      name: 'fake',
      judge: async () => {
        throw new Error('upstream 500');
      },
    };
    const outcome = await runJudge(provider, features, config);
    expect(outcome.ok).toBe(false);
    if (!outcome.ok) expect(outcome.error).toBe('upstream 500');
  });

  it('fails open when the provider misses the deadline', async () => {
    const provider: JudgeProvider = {
      name: 'slow',
      judge: (_state, signal) =>
        new Promise((_resolve, reject) => {
          signal.addEventListener('abort', () => reject(new Error('aborted')), { once: true });
        }),
    };
    const outcome = await runJudge(provider, features, config);
    expect(outcome.ok).toBe(false);
    if (!outcome.ok) expect(outcome.error).toContain('deadline');
  });

  it('reports the lowest confidence across questions the policy reads', () => {
    const judgments = normaliseJevResponse(arrayFixture);
    expect(overallConfidence(judgments)).toBeCloseTo(0.64);
  });
});
