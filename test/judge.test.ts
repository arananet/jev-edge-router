import { describe, expect, it } from 'vitest';
import routerFixture from '../fixtures/jev-router-questions.expected.json';
import restFixture from '../fixtures/jev-rest-envelope.expected.json';
import completedRestFixture from '../fixtures/jev-rest-completed-envelope.expected.json';
import vendorFixture from '../fixtures/jev-vendor-example.json';
import { runJudge, overallConfidence, type JudgeProvider } from '../src/judge/judge';
import { buildState, QUESTIONS, TASK_TYPES, type JudgeState } from '../src/judge/questions';
import { buildJevInput, buildJevPayload, noulConfidence, normaliseJevResponse } from '../src/judge/wire';
import { extractFeatures } from '../src/features';
import { testConfig } from './helpers';

const features = extractFeatures({
  messages: [
    { role: 'system', content: 'you are terse' },
    { role: 'user', content: 'why is my worker returning 522?' },
  ],
});

describe('judge request', () => {
  it('sends the state and every question in one input object', () => {
    const state: JudgeState = buildState(features, 100);
    const input = buildJevInput(state) as { state: JudgeState; questions: Record<string, { type: string }> };
    expect(Object.keys(input.questions)).toEqual(['task_type', 'difficulty', 'needs_long_output', 'high_stakes']);
    expect(Object.values(input.questions).map((q) => q.type)).toEqual(['choice', 'score', 'noul', 'noul']);
    expect(input.state).toBe(state);
  });

  it('wraps the input under a model for the REST form', () => {
    const payload = buildJevPayload(buildState(features, 100), 'typesafe/jev') as { model: string; input: unknown };
    expect(payload.model).toBe('typesafe/jev');
    expect(payload.input).toMatchObject({ questions: QUESTIONS });
  });

  it('gives the choice question one criterion per task type', () => {
    const question = QUESTIONS['task_type'];
    expect(question?.type).toBe('choice');
    if (question?.type === 'choice') {
      expect(Object.keys(question.criteria).sort()).toEqual([...TASK_TYPES].sort());
    }
  });

  it('gives the score question four ordered levels, so the score is 0 to 3', () => {
    const question = QUESTIONS['difficulty'];
    expect(question?.type).toBe('score');
    if (question?.type === 'score') expect(question.criteria).toHaveLength(4);
  });

  it('gives every noul question both criteria, as the schema requires', () => {
    for (const name of ['needs_long_output', 'high_stakes']) {
      const question = QUESTIONS[name];
      expect(question?.type).toBe('noul');
      if (question?.type === 'noul') {
        expect(question.criteria.true.length).toBeGreaterThan(0);
        expect(question.criteria.false.length).toBeGreaterThan(0);
      }
    }
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

describe('judge response', () => {
  it('normalises the documented answer shape', () => {
    const judgments = normaliseJevResponse(routerFixture);
    expect(judgments.task_type.value).toBe('code_debugging');
    expect(judgments.task_type.confidence).toBe(0.8);
    expect(judgments.task_type.distribution).toMatchObject({ code_debugging: 0.87 });
    expect(judgments.difficulty.value).toBeCloseTo(1.86);
    expect(judgments.needs_long_output.probability).toBeCloseTo(0.18);
    expect(judgments.high_stakes.probability).toBeCloseTo(0.05);
  });

  it('unwraps the Cloudflare REST envelope', () => {
    const judgments = normaliseJevResponse(restFixture);
    expect(judgments.task_type.value).toBe('chit_chat');
    expect(judgments.difficulty.value).toBeCloseTo(0.04);
  });

  it('unwraps the completed Cloudflare REST envelope', () => {
    const judgments = normaliseJevResponse(completedRestFixture);
    expect(judgments.task_type.value).toBe('code_debugging');
    expect(judgments.difficulty.value).toBeCloseTo(1.86);
  });

  it('rejects a completed REST envelope without a valid nested result', () => {
    expect(() => normaliseJevResponse({ success: true, result: { state: 'Completed', result: {} } })).toThrow();
  });

  it('derives noul confidence from distance to 0.5', () => {
    expect(noulConfidence(0.95)).toBeCloseTo(0.9);
    expect(noulConfidence(0.05)).toBeCloseTo(0.9);
    expect(noulConfidence(0.5)).toBe(0);
    const judgments = normaliseJevResponse(routerFixture);
    expect(judgments.high_stakes.confidence).toBeCloseTo(0.9);
  });

  it('matches the answer types the vendor example returns', () => {
    const answers = vendorFixture.response.answers as Record<string, { type: string }>;
    expect(new Set(Object.values(answers).map((a) => a.type))).toEqual(new Set(['noul', 'choice', 'score']));
  });

  it('rejects a response with a missing answer', () => {
    expect(() =>
      normaliseJevResponse({ answers: { task_type: { type: 'choice', choice: 'chit_chat', confidence: 1 } } }),
    ).toThrow();
  });

  it('rejects an unknown task type', () => {
    const raw = structuredClone(routerFixture) as Record<string, any>;
    raw['answers']['task_type']['choice'] = 'vibes';
    expect(() => normaliseJevResponse(raw)).toThrow(/unknown task_type/);
  });

  it('falls back to the top probability when a confidence is absent', () => {
    const raw = structuredClone(routerFixture) as Record<string, any>;
    delete raw['answers']['task_type']['confidence'];
    expect(normaliseJevResponse(raw).task_type.confidence).toBeCloseTo(0.87);
  });

  it('reports zero confidence when neither confidence nor probabilities are present', () => {
    const raw = structuredClone(routerFixture) as Record<string, any>;
    delete raw['answers']['difficulty']['confidence'];
    delete raw['answers']['difficulty']['probabilities'];
    expect(normaliseJevResponse(raw).difficulty.confidence).toBe(0);
  });
});

describe('runJudge', () => {
  const config = testConfig({ judge: { provider: 'cloudflare', deadline_ms: 50, max_chars: 2000 } });

  it('returns judgments on success', async () => {
    const provider: JudgeProvider = { name: 'fake', judge: async () => normaliseJevResponse(routerFixture) };
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

  it('reads confidence from the two answers that pick the tier', () => {
    const judgments = normaliseJevResponse(routerFixture);
    expect(overallConfidence(judgments)).toBeCloseTo(0.71);
  });
});
