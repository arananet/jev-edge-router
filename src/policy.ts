import type { RouterConfig, TierConfig } from './config';
import type { RequestFeatures } from './features';
import { overallConfidence } from './judge/judge';
import type { Judgments } from './judge/questions';

export interface Decision {
  tier: string;
  reason: string;
  /** Tier the difficulty table alone would have chosen, before feature and escalation rules. */
  judged_tier: string | null;
  pinned: boolean;
}

export interface PolicyInput {
  features: RequestFeatures;
  judgments: Judgments | null;
  /** Why the judge produced nothing, when it did not. */
  judge_error: string | null;
  config: RouterConfig;
}

function tierIndex(config: RouterConfig, tier: string): number {
  const index = config.tier_order.indexOf(tier);
  if (index < 0) throw new Error(`tier "${tier}" is not in tier_order`);
  return index;
}

function atLeast(config: RouterConfig, tier: string, floor: string): string {
  return tierIndex(config, tier) >= tierIndex(config, floor) ? tier : floor;
}

function escalate(config: RouterConfig, tier: string): string {
  const next = config.tier_order[Math.min(tierIndex(config, tier) + 1, config.tier_order.length - 1)];
  return next ?? tier;
}

function tierOf(config: RouterConfig, name: string): TierConfig {
  const tier = config.tiers[name];
  if (!tier) throw new Error(`unknown tier "${name}"`);
  return tier;
}

/**
 * The cheapest tier that satisfies every hard requirement, or null when none does.
 * Hard requirements come from computed features only, never from a judgment.
 */
function firstCapableTier(config: RouterConfig, features: RequestFeatures): string | null {
  for (const name of config.tier_order) {
    if (capable(tierOf(config, name), features)) return name;
  }
  return null;
}

function capable(tier: TierConfig, features: RequestFeatures): boolean {
  if (features.has_tools && !tier.supports_tools) return false;
  if (features.has_images && !tier.supports_images) return false;
  const needed = features.estimated_prompt_tokens + (features.requested_max_tokens ?? 0);
  if (needed > tier.context_window) return false;
  return true;
}

/**
 * Pure function: features + judgments + config -> tier. No I/O, no clocks, no randomness.
 * Rules are applied in the order documented in CLAUDE.md.
 */
export function decide({ features, judgments, judge_error, config }: PolicyInput): Decision {
  // 1. Client pinning, when config allows it.
  if (features.pinned_model && config.allow_client_model_pinning) {
    const pinnedTier = Object.keys(config.tiers).find((name) => tierOf(config, name).model === features.pinned_model);
    if (pinnedTier) {
      return {
        tier: pinnedTier,
        reason: `client pinned model ${features.pinned_model} (tier ${pinnedTier})`,
        judged_tier: null,
        pinned: true,
      };
    }
  }

  const reasons: string[] = [];

  // 3. Judge failure: fall back to the configured default.
  let tier: string;
  let judgedTier: string | null = null;
  if (!judgments) {
    tier = config.default_tier;
    reasons.push(`judge unavailable (${judge_error ?? 'no judgment'}), default tier ${config.default_tier}`);
  } else {
    // 4. Difficulty score and task type map to a tier through the config table.
    const level = String(Math.round(judgments.difficulty.value)) as '0' | '1' | '2' | '3';
    const fromDifficulty = config.difficulty_tiers[level] ?? config.default_tier;
    tier = fromDifficulty;
    reasons.push(`difficulty ${level} maps to ${fromDifficulty}`);

    const taskFloor = config.task_type_min_tier[judgments.task_type.value];
    if (taskFloor && atLeast(config, tier, taskFloor) !== tier) {
      tier = taskFloor;
      reasons.push(`task type ${judgments.task_type.value} requires at least ${taskFloor}`);
    }

    if (config.long_output_min_tier && judgments.needs_long_output.probability >= 0.5) {
      const floor = config.long_output_min_tier;
      if (atLeast(config, tier, floor) !== tier) {
        tier = floor;
        reasons.push(`long output expected, at least ${floor}`);
      }
    }
    judgedTier = tier;

    // 5. Low confidence escalates one tier.
    const confidence = overallConfidence(judgments);
    if (confidence < config.min_confidence) {
      const escalated = escalate(config, tier);
      if (escalated !== tier) {
        reasons.push(`confidence ${confidence.toFixed(2)} below ${config.min_confidence}, escalated to ${escalated}`);
        tier = escalated;
      } else {
        reasons.push(`confidence ${confidence.toFixed(2)} below ${config.min_confidence}, already at top tier`);
      }
    }

    // 6. High stakes enforce a minimum tier.
    if (judgments.high_stakes.probability > config.high_stakes_threshold) {
      const floor = config.high_stakes_min_tier;
      if (atLeast(config, tier, floor) !== tier) {
        reasons.push(`high stakes ${judgments.high_stakes.probability.toFixed(2)}, enforced ${floor}`);
        tier = floor;
      }
    }
  }

  // 2. Hard feature requirements win over any judgment based choice.
  if (!capable(tierOf(config, tier), features)) {
    const capableTier = firstCapableTier(config, features);
    if (capableTier && tierIndex(config, capableTier) > tierIndex(config, tier)) {
      reasons.push(`${tier} cannot serve this request (tools, images or context length), moved to ${capableTier}`);
      tier = capableTier;
    } else if (!capableTier) {
      const top = config.tier_order[config.tier_order.length - 1] as string;
      reasons.push(`no tier satisfies the request constraints, using ${top}`);
      tier = top;
    }
  }

  return { tier, reason: reasons.join('; '), judged_tier: judgedTier, pinned: false };
}
