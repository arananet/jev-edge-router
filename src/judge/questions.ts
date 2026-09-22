import { z } from 'zod';
import type { RequestFeatures } from '../features';

/**
 * The question set is the single source of truth for what the judge is asked.
 * Questions are independent: none may assume another question's answer.
 * Anything computable (tokens, tools, images, pinning) stays out of the state.
 *
 * Shapes follow the typesafe/jev schema on Workers AI: each question carries a type
 * ("noul", "choice" or "score"), free text `instructions`, and `criteria` that are a
 * true/false map, a label map, or an ordered list of levels.
 */

export const TASK_TYPES = [
  'chit_chat',
  'factual_lookup',
  'rewrite_or_summarise',
  'extraction_to_structured_data',
  'code_generation',
  'code_debugging',
  'math_or_formal_reasoning',
  'multi_step_planning_or_agentic',
  'creative_writing',
  'other',
] as const;

export type TaskType = (typeof TASK_TYPES)[number];

/** Score levels are an ordered list: the index is the score the model returns. */
export const DIFFICULTY_LEVELS = [
  'A short answer any small model would get right on the first try.',
  'Needs care with instructions or format, but no deep reasoning.',
  'Requires multi-step reasoning, domain knowledge, or non-trivial code.',
  'A mistake would be costly or subtle; needs the strongest available model.',
] as const;

const TASK_TYPE_CRITERIA: Record<TaskType, string> = {
  chit_chat: 'Greetings, small talk, banter, no information need',
  factual_lookup: 'A single fact, definition or short explanation',
  rewrite_or_summarise: 'Rewriting, translating, shortening or summarising supplied text',
  extraction_to_structured_data: 'Pulling fields out of text into JSON, a table or a list',
  code_generation: 'Writing new code, scripts or configuration',
  code_debugging: 'Diagnosing an error, a failing test or unexpected behaviour in existing code',
  math_or_formal_reasoning: 'Arithmetic, proofs, logic puzzles or formal derivations',
  multi_step_planning_or_agentic: 'Planning a multi-step task, orchestrating tools or agents',
  creative_writing: 'Fiction, poetry, marketing copy or other open-ended writing',
  other: 'Anything that fits none of the categories above',
};

export interface JudgeState {
  request: {
    last_user_message: string;
    system_prompt_excerpt: string;
    conversation_turns: number;
  };
}

export type JevQuestion =
  | { type: 'noul'; instructions: string; criteria: { true: string; false: string } }
  | { type: 'choice'; instructions: string; criteria: Record<string, string> }
  | { type: 'score'; instructions: string; criteria: readonly string[] };

/** Sent verbatim as the `questions` object of the Jev request. */
export const QUESTIONS: Record<string, JevQuestion> = {
  task_type: {
    type: 'choice',
    instructions: 'Which single category best describes what the user is asking the assistant for?',
    criteria: TASK_TYPE_CRITERIA,
  },
  difficulty: {
    type: 'score',
    instructions: 'How demanding is this request for a language model?',
    criteria: DIFFICULTY_LEVELS,
  },
  needs_long_output: {
    type: 'noul',
    instructions: 'Does the request ask for a long, structured deliverable?',
    criteria: {
      true: 'Asks for a document, report, full file, or several sections of output',
      false: 'A short answer, a snippet, or a single value is enough',
    },
  },
  high_stakes: {
    type: 'noul',
    instructions:
      'Does the request involve legal, medical, financial or security decisions where an error has real consequences?',
    criteria: {
      true: 'A wrong answer could cause legal, medical, financial or security harm',
      false: 'A wrong answer is merely unhelpful',
    },
  },
};

export const QUESTION_NAMES = Object.keys(QUESTIONS);

export function truncate(text: string, maxChars: number): string {
  if (text.length <= maxChars) return text;
  return `${text.slice(0, maxChars)}…`;
}

export function buildState(features: RequestFeatures, maxChars: number): JudgeState {
  return {
    request: {
      last_user_message: truncate(features.last_user_message, maxChars),
      system_prompt_excerpt: truncate(features.system_prompt_excerpt, maxChars),
      conversation_turns: features.conversation_turns,
    },
  };
}

/** Normalised judgment shape. Every provider adapter must produce exactly this. */
export const JudgmentsSchema = z.object({
  task_type: z.object({
    value: z.enum(TASK_TYPES),
    confidence: z.number().min(0).max(1),
    distribution: z.record(z.string(), z.number()).optional(),
  }),
  difficulty: z.object({
    value: z.number().min(0).max(3),
    confidence: z.number().min(0).max(1),
    distribution: z.record(z.string(), z.number()).optional(),
  }),
  needs_long_output: z.object({
    probability: z.number().min(0).max(1),
    confidence: z.number().min(0).max(1),
  }),
  high_stakes: z.object({
    probability: z.number().min(0).max(1),
    confidence: z.number().min(0).max(1),
  }),
});

export type Judgments = z.infer<typeof JudgmentsSchema>;
