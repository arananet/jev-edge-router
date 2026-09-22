import { parseConfig, type RouterConfig } from '../src/config';
import exampleConfig from '../config/tiers.example.json';
import type { Judgments } from '../src/judge/questions';

export function testConfig(overrides: Record<string, unknown> = {}): RouterConfig {
  return parseConfig({ ...(exampleConfig as Record<string, unknown>), ...overrides });
}

export function judgments(overrides: Partial<Judgments> = {}): Judgments {
  return {
    task_type: { value: 'factual_lookup', confidence: 0.9 },
    difficulty: { value: 0, confidence: 0.9 },
    needs_long_output: { probability: 0.0, confidence: 0.9 },
    high_stakes: { probability: 0.0, confidence: 0.9 },
    ...overrides,
  };
}
