import { env, createExecutionContext, waitOnExecutionContext } from 'cloudflare:test';
import { beforeAll, describe, expect, it, vi, afterEach } from 'vitest';
import worker, { type Env } from '../src/index';
import exampleConfig from '../config/tiers.example.json';
import arrayFixture from '../fixtures/jev-response.synthetic.json';
import { applyMigrations } from './apply-migrations';

const TIERS_CONFIG = JSON.stringify(exampleConfig);

function testEnv(overrides: Partial<Env> = {}): Env {
  return { ...(env as unknown as Env), TIERS_CONFIG, ROUTER_MODE: 'shadow', ...overrides };
}

function chatRequest(body: unknown, headers: Record<string, string> = {}): Request {
  return new Request('https://router.test/v1/chat/completions', {
    method: 'POST',
    headers: { 'content-type': 'application/json', ...headers },
    body: JSON.stringify(body),
  });
}

async function run(request: Request, environment: Env): Promise<Response> {
  const ctx = createExecutionContext();
  const response = await worker.fetch(request, environment, ctx);
  await waitOnExecutionContext(ctx);
  return response;
}

const upstreamBody = {
  id: 'chatcmpl-1',
  choices: [{ index: 0, message: { role: 'assistant', content: 'hi' }, finish_reason: 'stop' }],
  usage: { prompt_tokens: 10, completion_tokens: 2, total_tokens: 12 },
};

afterEach(() => {
  vi.restoreAllMocks();
});

function stubFetch(): void {
  vi.stubGlobal(
    'fetch',
    vi.fn(async (input: RequestInfo | URL) => {
      const url = String(input instanceof Request ? input.url : input);
      if (url.includes('/judge')) {
        return new Response(JSON.stringify(arrayFixture), { headers: { 'content-type': 'application/json' } });
      }
      return new Response(JSON.stringify(upstreamBody), { headers: { 'content-type': 'application/json' } });
    }),
  );
}

describe('worker', () => {
  beforeAll(applyMigrations);

  it('serves health without auth', async () => {
    const response = await run(new Request('https://router.test/health'), testEnv());
    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toMatchObject({ status: 'ok', mode: 'shadow' });
  });

  it('rejects a request with the wrong API key', async () => {
    const response = await run(
      chatRequest({ messages: [{ role: 'user', content: 'hi' }] }, { authorization: 'Bearer nope' }),
      testEnv({ ROUTER_API_KEYS: 'secret-key' }),
    );
    expect(response.status).toBe(401);
  });

  it('accepts a configured API key', async () => {
    stubFetch();
    const response = await run(
      chatRequest({ messages: [{ role: 'user', content: 'hi' }] }, { authorization: 'Bearer secret-key' }),
      testEnv({ ROUTER_API_KEYS: 'other-key, secret-key', ROUTER_MODE: 'off' }),
    );
    expect(response.status).toBe(200);
  });

  it('rejects a body with no messages', async () => {
    const response = await run(chatRequest({ model: 'x' }), testEnv());
    expect(response.status).toBe(400);
  });

  it('rejects a non JSON body', async () => {
    const request = new Request('https://router.test/v1/chat/completions', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: 'not json',
    });
    expect((await run(request, testEnv())).status).toBe(400);
  });

  it('rejects GET on the completions path', async () => {
    const response = await run(new Request('https://router.test/v1/chat/completions'), testEnv());
    expect(response.status).toBe(405);
  });

  it('404s an unknown path', async () => {
    expect((await run(new Request('https://router.test/nope'), testEnv())).status).toBe(404);
  });

  it('lists tiers as models', async () => {
    const response = await run(new Request('https://router.test/v1/models'), testEnv());
    const body = (await response.json()) as { data: Array<{ router_tier: string }> };
    expect(body.data.map((m) => m.router_tier)).toEqual(['small', 'mid', 'top']);
  });

  it('shadow mode serves the default tier but reports the decided tier', async () => {
    stubFetch();
    const response = await run(
      chatRequest({ messages: [{ role: 'user', content: 'why is my worker returning 522?' }] }),
      testEnv({ ROUTER_MODE: 'shadow', TIERS_CONFIG: JSON.stringify({ ...exampleConfig, judge: { provider: 'typesafe', deadline_ms: 2000, max_chars: 2000 } }), TYPESAFE_API_KEY: 'k' }),
    );
    expect(response.status).toBe(200);
    expect(response.headers.get('x-router-tier')).toBe('mid');
    expect(response.headers.get('x-router-decided-tier')).toBe('mid');
    expect(response.headers.get('x-router-reason')).toContain('difficulty 2');
  });

  it('route mode serves the decided tier', async () => {
    stubFetch();
    const response = await run(
      chatRequest({ messages: [{ role: 'user', content: 'hello there' }] }),
      testEnv({
        ROUTER_MODE: 'route',
        TIERS_CONFIG: JSON.stringify({
          ...exampleConfig,
          judge: { provider: 'typesafe', deadline_ms: 2000, max_chars: 2000 },
          difficulty_tiers: { '0': 'small', '1': 'small', '2': 'small', '3': 'top' },
          task_type_min_tier: {},
          long_output_min_tier: 'small',
        }),
        TYPESAFE_API_KEY: 'k',
      }),
    );
    expect(response.headers.get('x-router-tier')).toBe('small');
  });

  it('off mode never calls the judge', async () => {
    stubFetch();
    const response = await run(
      chatRequest({ messages: [{ role: 'user', content: 'hi' }] }),
      testEnv({ ROUTER_MODE: 'off' }),
    );
    expect(response.headers.get('x-router-reason')).toContain('router mode off');
    const calls = (globalThis.fetch as unknown as { mock: { calls: unknown[][] } }).mock.calls;
    expect(calls.every((call) => !String(call[0]).includes('/judge'))).toBe(true);
  });

  it('fails open to the default tier when the judge errors', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async (input: RequestInfo | URL) => {
        const url = String(input instanceof Request ? input.url : input);
        if (url.includes('/judge')) return new Response('boom', { status: 500 });
        return new Response(JSON.stringify(upstreamBody), { headers: { 'content-type': 'application/json' } });
      }),
    );
    const response = await run(
      chatRequest({ messages: [{ role: 'user', content: 'hi' }] }),
      testEnv({
        ROUTER_MODE: 'route',
        TIERS_CONFIG: JSON.stringify({ ...exampleConfig, judge: { provider: 'typesafe', deadline_ms: 2000, max_chars: 2000 } }),
        TYPESAFE_API_KEY: 'k',
      }),
    );
    expect(response.status).toBe(200);
    expect(response.headers.get('x-router-tier')).toBe('mid');
    expect(response.headers.get('x-router-reason')).toContain('judge unavailable');
  });

  it('returns 502 when the upstream call throws', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => { throw new Error('connection reset'); }));
    const response = await run(chatRequest({ messages: [{ role: 'user', content: 'hi' }] }), testEnv({ ROUTER_MODE: 'off' }));
    expect(response.status).toBe(502);
  });

  it('fails with 500 when no config is set', async () => {
    const response = await run(
      chatRequest({ messages: [{ role: 'user', content: 'hi' }] }),
      { ...(env as unknown as Env), TIERS_CONFIG: undefined },
    );
    expect(response.status).toBe(500);
  });
});
