import type { JudgeProvider } from '../judge';
import type { JudgeState, Judgments } from '../questions';
import { postJudge } from './http';

const DEFAULT_BASE_URL = 'https://ai-gateway.vercel.sh/v1/judge';
const DEFAULT_MODEL = 'typesafe/jev-1';

/** Jev through the Vercel AI Gateway. */
export class VercelJudgeProvider implements JudgeProvider {
  readonly name = 'vercel';

  constructor(
    private readonly apiKey: string,
    private readonly model: string = DEFAULT_MODEL,
    private readonly baseUrl: string = DEFAULT_BASE_URL,
  ) {}

  judge(state: JudgeState, signal: AbortSignal): Promise<Judgments> {
    return postJudge(this.baseUrl, { authorization: `Bearer ${this.apiKey}` }, state, signal, this.model);
  }
}
