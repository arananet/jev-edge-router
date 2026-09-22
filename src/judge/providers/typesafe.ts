import type { JudgeProvider } from '../judge';
import type { JudgeState, Judgments } from '../questions';
import { postJudge } from './http';

const DEFAULT_BASE_URL = 'https://api.typesafe.ai/v1/judge';
const DEFAULT_MODEL = 'jev-1';

/** Jev through the TypeSafe REST API. */
export class TypeSafeJudgeProvider implements JudgeProvider {
  readonly name = 'typesafe';

  constructor(
    private readonly apiKey: string,
    private readonly model: string = DEFAULT_MODEL,
    private readonly baseUrl: string = DEFAULT_BASE_URL,
  ) {}

  judge(state: JudgeState, signal: AbortSignal): Promise<Judgments> {
    return postJudge(this.baseUrl, { authorization: `Bearer ${this.apiKey}` }, state, signal, this.model);
  }
}
