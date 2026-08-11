import { resolve } from 'node:path';
import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: { environment: 'node', globals: true, testTimeout: 15_000, pool: 'forks', maxWorkers: 1 },
  resolve: {
    alias: {
      '@seo-agent/database': resolve('packages/database/src/index.ts'),
      '@seo-agent/resource-guard': resolve('packages/resource-guard/src/index.ts'),
      '@seo-agent/shared': resolve('packages/shared/src/index.ts'),
    },
  },
});
