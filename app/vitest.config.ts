import { defineConfig } from 'vitest/config';
import react from '@vitejs/plugin-react';

/* Unit tests for the front end's pure logic (tests/unit). The Playwright smoke run (tests/e2e) has its own config. */
export default defineConfig({
  plugins: [react()],
  test: {
    environment: 'jsdom',
    include: ['tests/unit/**/*.test.{ts,tsx}'],
    setupFiles: ['tests/unit/setup.ts'],
  },
});
