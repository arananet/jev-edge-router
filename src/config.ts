import { z } from 'zod';

export const TierSchema = z.object({
  provider: z.enum(['openai-compatible', 'anthropic']),
  base_url: z.string().url().optional(),
  model: z.string().min(1),
  context_window: z.number().int().positive(),
  supports_tools: z.boolean(),
  supports_images: z.boolean().default(false),
  /** USD per million tokens, used for cost estimates in telemetry and eval. */
  price_in_per_mtok: z.number().nonnegative().default(0),
  price_out_per_mtok: z.number().nonnegative().default(0),
});

export const RouterConfigSchema = z
  .object({
    /** Cheapest to most capable. Escalation walks this order. */
    tier_order: z.array(z.string().min(1)).min(1),
    default_tier: z.string().min(1),
    min_confidence: z.number().min(0).max(1),
    high_stakes_threshold: z.number().min(0).max(1),
    high_stakes_min_tier: z.string().min(1),
    allow_client_model_pinning: z.boolean().default(false),
    /** Tier picked per difficulty score 0..3, then overridden per task type. */
    difficulty_tiers: z.record(z.enum(['0', '1', '2', '3']), z.string().min(1)),
    task_type_min_tier: z.record(z.string(), z.string().min(1)).default({}),
    long_output_min_tier: z.string().min(1).optional(),
    judge: z.object({
      provider: z.enum(['cloudflare', 'typesafe', 'vercel']),
      model: z.string().min(1).optional(),
      deadline_ms: z.number().int().positive(),
      base_url: z.string().url().optional(),
      /** Char budget for each free text field sent to the judge. */
      max_chars: z.number().int().positive().default(2000),
    }),
    tiers: z.record(z.string(), TierSchema),
  })
  .superRefine((cfg, ctx) => {
    const known = new Set(Object.keys(cfg.tiers));
    const check = (name: string, path: string) => {
      if (!known.has(name)) {
        ctx.addIssue({ code: z.ZodIssueCode.custom, path: [path], message: `unknown tier "${name}"` });
      }
    };
    for (const t of cfg.tier_order) check(t, 'tier_order');
    check(cfg.default_tier, 'default_tier');
    check(cfg.high_stakes_min_tier, 'high_stakes_min_tier');
    for (const t of Object.values(cfg.difficulty_tiers)) check(t, 'difficulty_tiers');
    for (const t of Object.values(cfg.task_type_min_tier)) check(t, 'task_type_min_tier');
    if (cfg.long_output_min_tier) check(cfg.long_output_min_tier, 'long_output_min_tier');
    for (const name of known) {
      if (!cfg.tier_order.includes(name)) {
        ctx.addIssue({ code: z.ZodIssueCode.custom, path: ['tier_order'], message: `tier "${name}" missing from tier_order` });
      }
    }
    for (const [name, tier] of Object.entries(cfg.tiers)) {
      if (tier.provider === 'openai-compatible' && !tier.base_url) {
        ctx.addIssue({ code: z.ZodIssueCode.custom, path: ['tiers', name, 'base_url'], message: 'base_url is required for openai-compatible tiers' });
      }
    }
  });

export type TierConfig = z.infer<typeof TierSchema>;
export type RouterConfig = z.infer<typeof RouterConfigSchema>;

export function parseConfig(raw: unknown): RouterConfig {
  return RouterConfigSchema.parse(raw);
}

/**
 * Loads the tiers config from the TIERS_CONFIG var (a JSON string).
 * Parsing failures are fatal: a router with an invalid policy table must not serve traffic.
 */
export function loadConfig(source: string): RouterConfig {
  let raw: unknown;
  try {
    raw = JSON.parse(source);
  } catch (err) {
    throw new Error(`TIERS_CONFIG is not valid JSON: ${(err as Error).message}`);
  }
  return parseConfig(raw);
}
