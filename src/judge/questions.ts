import { z } from 'zod';
import type { RequestFeatures } from '../features';

/**
 * The question set is the single source of truth for what the judge is asked.
 * Questions are independent: none may assume another question's answer.
 * Anything computable (tokens, tools, images, pinning) stays out of the state.
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

export const DIFFICULTY_LEVELS = {
  '0': 'A short answer any small model would get right on the first try.',
  '1': 'Needs care with instructions or format, but no deep reasoning.',
  '2': 'Requires multi-step reasoning, domain knowledge, or non-trivial code.',
  '3': 'A mistake would be costly or subtle; needs the strongest available model.',
} as const;

export interface JudgeState {
  request: {
    last_user_message: string;
    system_prompt_excerpt: string;
    conversation_turns: number;
  };
}

export interface JudgeQuestion {
  name: string;
  type: 'choice' | 'score' | 'noul';
  question: string;
  /** Choice options, or score level descriptions keyed by level. */
  options?: readonly string[];
  levels?: Record<string, string>;
}

export const QUESTIONS: readonly JudgeQuestion[] = [
  {
    name: 'task_type',
    type: 'choice',
    question: 'Which single category best describes what the user is asking for?',
    options: TASK_TYPES,
  },
  {
    name: 'difficulty',
    type: 'score',
    question: 'How demanding is this request for a language model?',
    levels: DIFFICULTY_LEVELS,
  },
  {
    name: 'needs_long_output',
    type: 'noul',
    question: 'Does the request ask for a long, structured deliverable?',
  },
  {
    name: 'high_stakes',
    type: 'noul',
    question:
      'Does the request involve legal, medical, financial or security decisions where an error has real consequences?',
  },
] as const;

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
