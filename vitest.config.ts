import { defineConfig } from 'vitest/config';
import react from '@vitejs/plugin-react';
import { fileURLToPath } from 'url';
import path from 'path';
import { buildDefine } from './build-meta.ts';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

export default defineConfig({
  define: buildDefine(),
  plugins: [react()],
  resolve: {
    alias: {
      '@': path.resolve(__dirname, './src'),
    },
  },
  test: {
    environment: 'jsdom',
    globals: true,
    // Comfortably above the 15 s asyncUtilTimeout set in src/test/setup.ts. A findBy*
    // query that waits its full budget has to be able to report that as a query failure;
    // when the two are equal — as they were — Vitest kills the test first and the suite
    // reports a bare timeout instead of naming the element that never appeared.
    testTimeout: 30_000,
    setupFiles: ['./src/test/setup.ts'],
    include: [
      'tests/App.test.tsx',
      'tests/world/**/*.test.{ts,tsx}',
      'tests/components/**/*.test.{ts,tsx}',
      'tests/hooks/**/*.test.{ts,tsx}',
      'tests/svartaksi/**/*.test.{ts,tsx}',
      'tests/physics/**/*.test.{ts,tsx}',
      'tests/performance/**/*.test.{ts,tsx}',
      'tests/author/**/*.test.{ts,tsx}',
      'tests/story/**/*.test.{ts,tsx}',
      'tests/tooling/**/*.test.{ts,tsx}',
    ],
    css: true,
  },
});
