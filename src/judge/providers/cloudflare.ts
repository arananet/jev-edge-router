import type { JudgeProvider } from '../judge';
import type { JudgeState, Judgments } from '../questions';
import { buildJevPayload, normaliseJevResponse } from '../wire';

const DEFAULT_MODEL = '@typesafe/jev-1';

/**
 * Jev through the Workers AI binding. The binding takes no AbortSignal, so the deadline is
 * enforced by racing the call; the underlying request is left to settle on its own.
 */
export class CloudflareJudgeProvider implements JudgeProvider {
  readonly name = 'cloudflare';

  constructor(
    private readonly ai: Ai,
    private readonly model: string = DEFAULT_MODEL,
  ) {}

  async judge(state: JudgeState, signal: AbortSignal): Promise<Judgments> {
    const payload = buildJevPayload(state);
    // Adapter boundary: the binding is typed against a fixed model catalogue.
    const call = (this.ai.run as (model: string, input: unknown) => Promise<unknown>)(this.model, payload);
    const raw = await Promise.race([call, abortPromise(signal)]);
    return normaliseJevResponse(raw);
  }
}

function abortPromise(signal: AbortSignal): Promise<never> {
  return new Promise((_resolve, reject) => {
    if (signal.aborted) {
      reject(new Error('aborted'));
      return;
    }
    signal.addEventListener('abort', () => reject(new Error('aborted')), { once: true });
  });
}
