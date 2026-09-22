import { z } from 'zod';
import {
  JudgmentsSchema,
  QUESTIONS,
  TASK_TYPES,
  DIFFICULTY_LEVELS,
  type JudgeState,
  type Judgments,
} from './questions';

/**
 * Jev wire format, as documented in the Workers AI model catalogue for `typesafe/jev`
 * and confirmed against a live `POST /accounts/{id}/ai/run` call. A recorded, redacted
 * sample is in `fixtures/`. See docs/jev-wire-format.md.
 */

export function buildJevInput(state: JudgeState): Record<string, unknown> {
  return { state, questions: QUESTIONS };
}

export function buildJevPayload(state: JudgeState, model: string): Record<string, unknown> {
  return { model, input: buildJevInput(state) };
}

const ProbabilitiesSchema = z.record(z.string(), z.number());

const NoulAnswerSchema = z.object({ type: z.literal('noul'), noul: z.number() });
const ChoiceAnswerSchema = z.object({
  type: z.literal('choice'),
  choice: z.string(),
  confidence: z.number().optional(),
  probabilities: ProbabilitiesSchema.optional(),
});
const ScoreAnswerSchema = z.object({
  type: z.literal('score'),
  score: z.number(),
  confidence: z.number().optional(),
  legend: z.record(z.string(), z.string()).optional(),
  probabilities: ProbabilitiesSchema.optional(),
});

export const JevResultSchema = z.object({
  model: z.string().optional(),
  answers: z.object({
    task_type: ChoiceAnswerSchema,
    difficulty: ScoreAnswerSchema,
    needs_long_output: NoulAnswerSchema,
    high_stakes: NoulAnswerSchema,
  }),
  usage: z.object({ input_tokens: z.number(), output_tokens: z.number() }).optional(),
});

/** The REST API wraps the result; the Workers AI binding returns it directly. */
const JevEnvelopeSchema = z.union([
  JevResultSchema,
  z.object({ success: z.boolean().optional(), result: JevResultSchema }).transform((env) => env.result),
]);

export type JevResult = z.infer<typeof JevResultSchema>;

function clamp01(value: number): number {
  return Math.min(1, Math.max(0, value));
}

/**
 * Jev returns no confidence for a noul answer, only the probability itself. A probability
 * near 0.5 is an undecided answer, so confidence is its distance from the midpoint. That
 * makes an undecided judge trip the min_confidence escalation instead of passing silently.
 */
export function noulConfidence(probability: number): number {
  return clamp01(Math.abs(probability - 0.5) * 2);
}

/** Highest probability, used when the model omits an explicit confidence. */
function topProbability(probabilities: Record<string, number> | undefined): number | undefined {
  if (!probabilities) return undefined;
  const values = Object.values(probabilities);
  return values.length > 0 ? Math.max(...values) : undefined;
}

/** Turns a validated Jev envelope into the normalised Judgments the policy reads. */
export function normaliseJevResponse(raw: unknown): Judgments {
  const parsed = JevEnvelopeSchema.parse(raw);
  const answers = parsed.answers;

  if (!(TASK_TYPES as readonly string[]).includes(answers.task_type.choice)) {
    throw new Error(`judge returned unknown task_type "${answers.task_type.choice}"`);
  }

  const maxScore = DIFFICULTY_LEVELS.length - 1;
  const longOutput = clamp01(answers.needs_long_output.noul);
  const highStakes = clamp01(answers.high_stakes.noul);

  return JudgmentsSchema.parse({
    task_type: {
      value: answers.task_type.choice,
      confidence: clamp01(answers.task_type.confidence ?? topProbability(answers.task_type.probabilities) ?? 0),
      ...(answers.task_type.probabilities ? { distribution: answers.task_type.probabilities } : {}),
    },
    difficulty: {
      value: Math.min(maxScore, Math.max(0, answers.difficulty.score)),
      confidence: clamp01(answers.difficulty.confidence ?? topProbability(answers.difficulty.probabilities) ?? 0),
      ...(answers.difficulty.probabilities ? { distribution: answers.difficulty.probabilities } : {}),
    },
    needs_long_output: { probability: longOutput, confidence: noulConfidence(longOutput) },
    high_stakes: { probability: highStakes, confidence: noulConfidence(highStakes) },
  });
}
