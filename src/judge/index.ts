import type { RouterConfig } from '../config';
import type { JudgeProvider } from './judge';
import { CloudflareJudgeProvider } from './providers/cloudflare';
import { TypeSafeJudgeProvider } from './providers/typesafe';
import { VercelJudgeProvider } from './providers/vercel';

export interface JudgeCredentials {
  ai?: Ai;
  typesafe_api_key?: string;
  vercel_api_key?: string;
}

/** Swapping judge vendors is a config change, never a code change. */
export function createJudgeProvider(config: RouterConfig, creds: JudgeCredentials): JudgeProvider {
  switch (config.judge.provider) {
    case 'cloudflare': {
      if (!creds.ai) throw new Error('judge.provider=cloudflare requires the AI binding');
      return new CloudflareJudgeProvider(creds.ai, config.judge.model);
    }
    case 'typesafe': {
      if (!creds.typesafe_api_key) throw new Error('judge.provider=typesafe requires TYPESAFE_API_KEY');
      return new TypeSafeJudgeProvider(creds.typesafe_api_key, config.judge.base_url, config.judge.model);
    }
    case 'vercel': {
      if (!creds.vercel_api_key) throw new Error('judge.provider=vercel requires VERCEL_AI_GATEWAY_KEY');
      return new VercelJudgeProvider(creds.vercel_api_key, config.judge.base_url, config.judge.model);
    }
  }
}

export * from './judge';
export * from './questions';
