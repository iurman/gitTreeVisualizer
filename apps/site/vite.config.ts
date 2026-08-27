import { fileURLToPath } from 'node:url';
import { defineConfig, type Plugin } from 'vite';
import react from '@vitejs/plugin-react';
import { devApi } from './dev-api.js';

const src = (p: string) => fileURLToPath(new URL(p, import.meta.url));

/**
 * Preload the latin faces. Vite content-hashes them into /assets, so the names
 * are only known once the bundle exists — but every visitor needs these three
 * files, and without a preload they cannot start downloading until the browser
 * has fetched and parsed the stylesheet that mentions them. That is one round
 * trip of blank text on every cold load, for about fifteen lines.
 *
 * Only the three regular latin faces, one per family — the ones on screen
 * before anything is typed. Preloading the rest would be worse than preloading
 * none: italic, bold, the 500 weight and every latin-ext subset add up to more
 * than 200 kB that most visitors never render, and eagerly fetching them
 * competes with the JavaScript for bandwidth. Those keep arriving on demand,
 * which is the entire reason for keeping the unicode-range declarations split.
 */
function preloadLatinFonts(): Plugin {
  return {
    name: 'gittree-preload-fonts',
    apply: 'build',
    enforce: 'post',
    transformIndexHtml(_html, ctx) {
      // Vite's content hash is base64url and can itself contain a dash, so
      // "latin but not latin-ext" is two plain tests rather than one clever one.
      const files = Object.keys(ctx.bundle ?? {}).filter(
        (f) => f.endsWith('.woff2') && f.includes('-400-latin-') && !f.includes('-latin-ext-'),
      );
      return files.sort().map((href) => ({
        tag: 'link',
        attrs: { rel: 'preload', as: 'font', type: 'font/woff2', href: `/${href}`, crossorigin: '' },
        injectTo: 'head-prepend' as const,
      }));
    },
  };
}

export default defineConfig({
  plugins: [react(), devApi(), preloadLatinFonts()],
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
