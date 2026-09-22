declare module 'cloudflare:test' {
  interface ProvidedEnv extends Record<string, unknown> {}
  export const env: ProvidedEnv;
  export function createExecutionContext(): ExecutionContext;
  export function waitOnExecutionContext(ctx: ExecutionContext): Promise<void>;
}
