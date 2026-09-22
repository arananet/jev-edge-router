import { defineWorkersConfig } from '@cloudflare/vitest-pool-workers/config';

// The AI binding is not simulated locally (it proxies to the Cloudflare API), so tests
// configure bindings here rather than reading wrangler.toml. Judge coverage runs through the
// REST providers and fixtures; see KNOWN_ISSUES.md.
export default defineWorkersConfig({
  test: {
    globals: true,
    poolOptions: {
      workers: {
        main: './src/index.ts',
        miniflare: {
          compatibilityDate: '2024-12-30',
          compatibilityFlags: ['nodejs_compat'],
          d1Databases: ['DB'],
        },
      },
    },
  },
});
