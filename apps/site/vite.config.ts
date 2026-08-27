import { fileURLToPath } from 'node:url';
import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import { devApi } from './dev-api.js';

const src = (p: string) => fileURLToPath(new URL(p, import.meta.url));

export default defineConfig({
  plugins: [react(), devApi()],
  resolve: {
    // The workspace packages resolve to their TypeScript sources for the
    // bundler, so editing core hot-reloads the viewer. Their package manifests
    // still point at built output, which is what the serverless functions and
    // any external consumer get.
    alias: {
      '@gittree/core': src('../../packages/core/src/index.ts'),
      '@gittree/web/styles.css': src('../../packages/web/src/styles.css'),
      '@gittree/web': src('../../packages/web/src/index.ts'),
    },
  },
  server: { port: 5173 },
  build: {
    target: 'es2022',
    sourcemap: true,
    rollupOptions: {
      output: {
        // Three is the heaviest thing here and it never changes between
        // deploys of the viewer, so it gets its own long-lived chunk.
        manualChunks(id: string) {
          if (id.includes('/node_modules/three/')) return 'three';
          if (id.includes('/node_modules/react')) return 'react';
          return undefined;
        },
      },
    },
  },
  worker: { format: 'es' },
});
