import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { defineConfig } from 'vite';
import vue from '@vitejs/plugin-vue';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

// The koa server mounts Vite as middleware in dev (one origin: the API and the SPA share a port).
// root = this config's directory (the app dir); index.html lives at the root, the SPA entry at
// /web/src/main.ts. `vite build` emits to web-dist/ which koa serves statically in prod.
export default defineConfig({
  plugins: [vue()],
  build: { outDir: path.resolve(__dirname, 'web-dist'), emptyOutDir: true },
});
