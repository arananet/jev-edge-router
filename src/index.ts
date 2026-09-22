import { loadConfig, type RouterConfig } from './config';
import { extractFeatures } from './features';
import { createJudgeProvider, runJudge, type JudgeOutcome } from './judge';
import { decide, type Decision } from './policy';
import { logDecision } from './telemetry';
import { ChatCompletionRequestSchema } from './types';
import { createUpstreamProvider } from './upstream';

export interface Env {
  AI?: Ai;
  DB?: D1Database;
  TIERS_CONFIG?: string;
  ROUTER_MODE?: string;
  LOG_CONTENT?: string;
  ROUTER_API_KEYS?: string;
  TYPESAFE_API_KEY?: string;
  VERCEL_AI_GATEWAY_KEY?: string;
  [key: string]: unknown;
}

export type RouterMode = 'shadow' | 'route' | 'off';

function parseMode(value: string | undefined): RouterMode {
  return value === 'route' || value === 'off' ? value : 'shadow';
}

function json(body: unknown, status: number, headers: Record<string, string> = {}): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json', ...headers },
  });
}

function errorResponse(status: number, message: string, type: string): Response {
  return json({ error: { message, type } }, status);
}

/** Constant time comparison so a client key cannot be recovered byte by byte. */
function safeEqual(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return diff === 0;
}

function authorised(request: Request, env: Env): boolean {
  const configured = (env.ROUTER_API_KEYS ?? '')
    .split(',')
    .map((k) => k.trim())
    .filter((k) => k.length > 0);
  if (configured.length === 0) return true; // No keys configured: local development.
  const header = request.headers.get('authorization') ?? '';
  const presented = header.startsWith('Bearer ') ? header.slice(7) : '';
  return configured.some((key) => safeEqual(key, presented));
}

function upstreamKey(env: Env, tierName: string): string {
  const value = env[`UPSTREAM_API_KEY_${tierName.toUpperCase()}`];
  return typeof value === 'string' ? value : '';
}

let cachedConfig: { source: string; config: RouterConfig } | null = null;

export function getConfig(env: Env): RouterConfig {
  const source = env.TIERS_CONFIG;
  if (!source) throw new Error('TIERS_CONFIG is not set');
  if (cachedConfig && cachedConfig.source === source) return cachedConfig.config;
  const config = loadConfig(source);
  cachedConfig = { source, config };
  return config;
}

async function handleChatCompletions(request: Request, env: Env, ctx: ExecutionContext): Promise<Response> {
  if (!authorised(request, env)) return errorResponse(401, 'invalid API key', 'authentication_error');

  let body: unknown;
  try {
    body = await request.json();
  } catch {
    return errorResponse(400, 'request body is not valid JSON', 'invalid_request_error');
  }
  const parsed = ChatCompletionRequestSchema.safeParse(body);
  if (!parsed.success) {
    return errorResponse(400, parsed.error.issues[0]?.message ?? 'invalid request', 'invalid_request_error');
  }

  const config = getConfig(env);
  const mode = parseMode(env.ROUTER_MODE);
  const logContent = env.LOG_CONTENT === 'true';
  const requestId = crypto.randomUUID();
  const features = extractFeatures(parsed.data);

  let outcome: JudgeOutcome | null = null;
  if (mode !== 'off') {
    try {
      const provider = createJudgeProvider(config, {
        ...(env.AI ? { ai: env.AI } : {}),
        ...(env.TYPESAFE_API_KEY ? { typesafe_api_key: env.TYPESAFE_API_KEY } : {}),
        ...(env.VERCEL_AI_GATEWAY_KEY ? { vercel_api_key: env.VERCEL_AI_GATEWAY_KEY } : {}),
      });
      outcome = await runJudge(provider, features, config);
    } catch (err) {
      outcome = {
        ok: false,
        error: (err as Error).message,
        latency_ms: 0,
        provider: config.judge.provider,
      };
    }
  }

  const decision: Decision =
    mode === 'off'
      ? { tier: config.default_tier, reason: 'router mode off, default tier', judged_tier: null, pinned: false }
      : decide({
          features,
          judgments: outcome?.ok ? outcome.judgments : null,
          judge_error: outcome && !outcome.ok ? outcome.error : null,
          config,
        });

  // Shadow mode judges and logs, then always serves the default tier.
  const servedTier = mode === 'route' ? decision.tier : config.default_tier;
  const tierConfig = config.tiers[servedTier];
  if (!tierConfig) return errorResponse(500, `tier "${servedTier}" is not configured`, 'server_error');

  const upstream = createUpstreamProvider(tierConfig);
  let result;
  try {
    result = await upstream.send(parsed.data, tierConfig, upstreamKey(env, servedTier));
  } catch (err) {
    ctx.waitUntil(
      logDecision(env.DB, config, {
        request_id: requestId,
        mode,
        features,
        judgments: outcome?.ok ? outcome.judgments : null,
        judge_provider: outcome?.provider ?? null,
        judge_error: outcome && !outcome.ok ? outcome.error : null,
        judge_latency_ms: outcome?.latency_ms ?? null,
        decision,
        served_tier: servedTier,
        upstream_latency_ms: null,
        usage: null,
        status: 502,
      }, logContent),
    );
    return errorResponse(502, `upstream request failed: ${(err as Error).message}`, 'upstream_error');
  }

  ctx.waitUntil(
    logDecision(env.DB, config, {
      request_id: requestId,
      mode,
      features,
      judgments: outcome?.ok ? outcome.judgments : null,
      judge_provider: outcome?.provider ?? null,
      judge_error: outcome && !outcome.ok ? outcome.error : null,
      judge_latency_ms: outcome?.latency_ms ?? null,
      decision,
      served_tier: servedTier,
      upstream_latency_ms: result.latency_ms,
      usage: result.usage,
      status: result.response.status,
    }, logContent),
  );

  const headers = new Headers(result.response.headers);
  headers.set('x-router-request-id', requestId);
  headers.set('x-router-mode', mode);
  headers.set('x-router-tier', servedTier);
  headers.set('x-router-decided-tier', decision.tier);
  headers.set('x-router-reason', decision.reason);
  if (outcome) headers.set('x-router-judge-latency-ms', String(outcome.latency_ms));
  return new Response(result.response.body, { status: result.response.status, headers });
}

function models(config: RouterConfig): Response {
  return json(
    {
      object: 'list',
      data: config.tier_order.map((name) => ({
        id: config.tiers[name]?.model ?? name,
        object: 'model',
        owned_by: config.tiers[name]?.provider ?? 'unknown',
        router_tier: name,
      })),
    },
    200,
  );
}

export default {
  async fetch(request: Request, env: Env, ctx: ExecutionContext): Promise<Response> {
    const url = new URL(request.url);

    if (url.pathname === '/health') {
      return json({ status: 'ok', mode: parseMode(env.ROUTER_MODE) }, 200);
    }

    try {
      if (url.pathname === '/v1/models' && request.method === 'GET') {
        if (!authorised(request, env)) return errorResponse(401, 'invalid API key', 'authentication_error');
        return models(getConfig(env));
      }
      if (url.pathname === '/v1/chat/completions') {
        if (request.method !== 'POST') return errorResponse(405, 'method not allowed', 'invalid_request_error');
        return await handleChatCompletions(request, env, ctx);
      }
    } catch (err) {
      return errorResponse(500, (err as Error).message, 'server_error');
    }

    return errorResponse(404, `no route for ${url.pathname}`, 'invalid_request_error');
  },
};
