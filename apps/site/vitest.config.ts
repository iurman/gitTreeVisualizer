import { fileURLToPath } from 'node:url';
import { defineConfig } from 'vitest/config';

export default defineConfig({
  resolve: {
    alias: { '@gittree/core': fileURLToPath(new URL('../../packages/core/src/index.ts', import.meta.url)) },
  },
  test: { environment: 'node', include: ['api/**/*.test.ts'] },
});
