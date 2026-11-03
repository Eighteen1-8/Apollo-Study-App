import { defineConfig, Plugin } from 'vite';
import react from '@vitejs/plugin-react';

/** The packaged app runs no inline script (only Vite's dev server needs it, for hot reload), so the built page's
 * Content-Security-Policy drops 'unsafe-inline' from script-src: injected markup can't run code. */
const strictScripts: Plugin = {
  name: 'strict-csp',
  apply: 'build',
  transformIndexHtml: (html) => html.replace("script-src 'self' 'unsafe-inline'", "script-src 'self'"),
};

export default defineConfig({
  plugins: [react(), strictScripts],
  base: './',
  build: { outDir: 'dist', emptyOutDir: true },
});
