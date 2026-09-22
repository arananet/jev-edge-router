import { z } from 'zod';
import { JudgmentsSchema, QUESTIONS, TASK_TYPES, type JudgeState, type Judgments } from './questions';

/**
 * Jev wire format.
 *
 * UNVERIFIED against a live endpoint in this repo: no credentials were available when this
 * adapter was written, so the envelope below is the documented assumption, not a recorded
 * sample. See KNOWN_ISSUES.md ("Jev wire format is unverified") and docs/jev-wire-format.md.
 * Run `npm run probe` with real credentials, drop the redacted sample in fixtures/, and
 * correct this file before trusting routing in `route` mode.
 */

export function buildJevPayload(state: JudgeState, model?: string): Record<string, unknown> {
  return {
    ...(model ? { model } : {}),
    state,
    questions: QUESTIONS.map((q) => {
      switch (q.type) {
        case 'choice':
          return { name: q.name, type: 'Choice', question: q.question, options: q.options };
        case 'score':
          return { name: q.name, type: 'Score', question: q.question, levels: q.levels };
        case 'noul':
          return { name: q.name, type: 'Noul', question: q.question };
      }
    }),
  };
}

const DistributionSchema = z.record(z.string(), z.number());

const AnswerSchema = z
  .object({
    name: z.string().optional(),
    value: z.union([z.string(), z.number(), z.boolean()]).optional(),
    probability: z.number().optional(),
    confidence: z.number().optional(),
    distribution: DistributionSchema.optional(),
  })
  .passthrough();

export const JevResponseSchema = z.object({
  answers: z.union([z.array(AnswerSchema.extend({ name: z.string() })), z.record(z.string(), AnswerSchema)]),
});

type Answer = z.infer<typeof AnswerSchema>;

function indexAnswers(parsed: z.infer<typeof JevResponseSchema>): Record<string, Answer> {
  if (Array.isArray(parsed.answers)) {
    return Object.fromEntries(parsed.answers.map((a) => [a.name, a]));
  }
  return parsed.answers;
}

function require_(answers: Record<string, Answer>, name: string): Answer {
  const answer = answers[name];
  if (!answer) throw new Error(`judge response is missing answer "${name}"`);
  return answer;
}

function clamp01(value: number | undefined, fallback: number): number {
  if (typeof value !== 'number' || Number.isNaN(value)) return fallback;
  return Math.min(1, Math.max(0, value));
}

/** Highest probability in a distribution, used when the provider omits an explicit confidence. */
function topProbability(dist: Record<string, number> | undefined): number | undefined {
  if (!dist) return undefined;
  const values = Object.values(dist);
  return values.length > 0 ? Math.max(...values) : undefined;
}

function booleanProbability(answer: Answer): number {
  if (typeof answer.probability === 'number') return clamp01(answer.probability, 0);
  if (typeof answer.value === 'boolean') return answer.value ? 1 : 0;
  const dist = answer.distribution;
  if (dist) {
    const yes = dist['true'] ?? dist['yes'] ?? dist['True'];
    if (typeof yes === 'number') return clamp01(yes, 0);
  }
  throw new Error('boolean answer has neither probability, value nor distribution');
}

/** Turns a validated Jev envelope into the normalised Judgments the policy reads. */
export function normaliseJevResponse(raw: unknown): Judgments {
  const parsed = JevResponseSchema.parse(raw);
  const answers = indexAnswers(parsed);

  const taskAnswer = require_(answers, 'task_type');
  const taskValue = String(taskAnswer.value ?? '');
  if (!(TASK_TYPES as readonly string[]).includes(taskValue)) {
    throw new Error(`judge returned unknown task_type "${taskValue}"`);
  }

  const difficultyAnswer = require_(answers, 'difficulty');
  const difficulty = Number(difficultyAnswer.value);
  if (!Number.isFinite(difficulty)) throw new Error('judge returned a non numeric difficulty');

  const longOutput = require_(answers, 'needs_long_output');
  const highStakes = require_(answers, 'high_stakes');

  return JudgmentsSchema.parse({
    task_type: {
      value: taskValue,
      confidence: clamp01(taskAnswer.confidence ?? topProbability(taskAnswer.distribution), 0),
      ...(taskAnswer.distribution ? { distribution: taskAnswer.distribution } : {}),
    },
    difficulty: {
      value: Math.min(3, Math.max(0, difficulty)),
      confidence: clamp01(difficultyAnswer.confidence ?? topProbability(difficultyAnswer.distribution), 0),
      ...(difficultyAnswer.distribution ? { distribution: difficultyAnswer.distribution } : {}),
    },
    needs_long_output: {
      probability: booleanProbability(longOutput),
      confidence: clamp01(longOutput.confidence ?? topProbability(longOutput.distribution), 0),
    },
    high_stakes: {
      probability: booleanProbability(highStakes),
      confidence: clamp01(highStakes.confidence ?? topProbability(highStakes.distribution), 0),
    },
  });
}
