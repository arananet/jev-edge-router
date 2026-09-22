import type { JudgeState, Judgments } from '../questions';
import { buildJevPayload, normaliseJevResponse } from '../wire';

/** Shared REST path for the judge providers that speak HTTP. No retries on the judge path. */
export async function postJudge(
  url: string,
  headers: Record<string, string>,
  state: JudgeState,
  signal: AbortSignal,
  model?: string,
): Promise<Judgments> {
  const response = await fetch(url, {
    method: 'POST',
    headers: { 'content-type': 'application/json', ...headers },
    body: JSON.stringify(buildJevPayload(state, model)),
    signal,
  });
  if (!response.ok) {
    const body = await response.text().catch(() => '');
    throw new Error(`judge HTTP ${response.status}: ${body.slice(0, 200)}`);
  }
  return normaliseJevResponse(await response.json());
}
