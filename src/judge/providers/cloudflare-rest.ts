import type { JudgeProvider } from '../judge';
import type { JudgeState, Judgments } from '../questions';
import { postJudge } from './http';

const DEFAULT_MODEL = 'typesafe/jev';

/**
 * Jev through the Cloudflare REST API, for callers without the Workers AI binding
 * (the eval harness, the probe, or a Worker in another account).
 */
export class CloudflareRestJudgeProvider implements JudgeProvider {
  readonly name = 'cloudflare-rest';

  constructor(
    private readonly accountId: string,
    private readonly apiToken: string,
    private readonly model: string = DEFAULT_MODEL,
    private readonly baseUrl = 'https://api.cloudflare.com/client/v4',
  ) {}

  judge(state: JudgeState, signal: AbortSignal): Promise<Judgments> {
    const url = `${this.baseUrl.replace(/\/$/, '')}/accounts/${this.accountId}/ai/run`;
    return postJudge(url, { authorization: `Bearer ${this.apiToken}` }, state, signal, this.model);
  }
}
