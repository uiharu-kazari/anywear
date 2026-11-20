import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import tailwindcss from '@tailwindcss/vite';
import istanbul from 'vite-plugin-istanbul';

// E2E coverage builds (`npm run test:e2e`) instrument the client code.
const COVERAGE = process.env.COVERAGE === '1';

export default defineConfig(({ mode }) => ({
  plugins: [
    react(),
    tailwindcss(),
    COVERAGE &&
      istanbul({ include: ['src/**', 'shared/**'], extension: ['.ts', '.tsx'], requireEnv: false, forceBuildInstrument: true }),
    // Anna serves the bundle into a sandboxed (opaque-origin) iframe; a
    // `crossorigin` stylesheet would need CORS headers from the bundle CDN.
    mode === 'anna' && {
      name: 'anna-no-crossorigin-css',
      transformIndexHtml: (html: string) => html.replace(/<link rel="stylesheet" crossorigin /g, '<link rel="stylesheet" '),
    },
  ],
  // The Anna edition is served from /anna-apps/<slug>/<version>/, so assets
  // must resolve relative to index.html.
  ...(mode === 'anna' ? { base: './', build: { outDir: 'anna/bundle', emptyOutDir: true } } : {}),
  server: {
    port: 5173,
    proxy: {
      '/api': {
        target: 'http://localhost:8931',
        changeOrigin: true,
      },
    },
  },
}));
