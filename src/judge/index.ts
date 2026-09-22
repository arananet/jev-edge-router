import type { RouterConfig } from '../config';
import type { JudgeProvider } from './judge';
import { CloudflareJudgeProvider } from './providers/cloudflare';
import { CloudflareRestJudgeProvider } from './providers/cloudflare-rest';
import { TypeSafeJudgeProvider } from './providers/typesafe';
import { VercelJudgeProvider } from './providers/vercel';

export interface JudgeCredentials {
  ai?: Ai;
  cloudflare_account_id?: string;
  cloudflare_api_token?: string;
  typesafe_api_key?: string;
  vercel_api_key?: string;
}

/** Swapping judge vendors is a config change, never a code change. */
export function createJudgeProvider(config: RouterConfig, creds: JudgeCredentials): JudgeProvider {
  const model = config.judge.model;
  switch (config.judge.provider) {
    case 'cloudflare': {
      if (!creds.ai) throw new Error('judge.provider=cloudflare requires the AI binding');
      return new CloudflareJudgeProvider(creds.ai, model);
    }
    case 'cloudflare-rest': {
      if (!creds.cloudflare_account_id || !creds.cloudflare_api_token) {
        throw new Error('judge.provider=cloudflare-rest requires CLOUDFLARE_ACCOUNT_ID and CLOUDFLARE_API_TOKEN');
      }
      return new CloudflareRestJudgeProvider(
        creds.cloudflare_account_id,
        creds.cloudflare_api_token,
        model,
        config.judge.base_url,
      );
    }
    case 'typesafe': {
      if (!creds.typesafe_api_key) throw new Error('judge.provider=typesafe requires TYPESAFE_API_KEY');
      return new TypeSafeJudgeProvider(creds.typesafe_api_key, model, config.judge.base_url);
    }
    case 'vercel': {
      if (!creds.vercel_api_key) throw new Error('judge.provider=vercel requires VERCEL_AI_GATEWAY_KEY');
      return new VercelJudgeProvider(creds.vercel_api_key, model, config.judge.base_url);
    }
  }
}

export * from './judge';
export * from './questions';
