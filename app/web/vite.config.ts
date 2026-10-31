import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

/**
 * Build of the browser page (research R9, R11; contracts/compose.md). The page is served by `@fastify/static` from the
 * app container, so the output goes to `app/dist/web` and every URL in it is relative (`base: ''`): the page does not
 * depend on the path it is mounted at. The build runs as `vite build --config web/vite.config.ts` from `app/`, hence the
 * root is set from this file's location and not left to the working directory; `import.meta.url` is used because the
 * front's tsconfig carries no Node types. `emptyOutDir` is explicit because the output folder lies outside the root,
 * where Vite would otherwise warn and keep stale files.
 */
export default defineConfig({
  root: new URL('.', import.meta.url).pathname,
  base: '',
  plugins: [react()],
  build: {
    outDir: '../dist/web',
    emptyOutDir: true,
  },
});
