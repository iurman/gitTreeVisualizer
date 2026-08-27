import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import { devApi } from './dev-api.js';

export default defineConfig({
  plugins: [react(), devApi()],
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
