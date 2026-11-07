import { fileURLToPath, URL } from 'node:url';
import { defineConfig } from 'vitest/config';

// The harness evals import live server modules, whose '@/' alias points at server/ (see evals/tsconfig.json).
// Kept apart from the root config, whose '@/' alias points at the client src/ under jsdom.
export default defineConfig({
  resolve: {
    alias: [
      { find: /^@src\/(.*)$/, replacement: fileURLToPath(new URL('../src/', import.meta.url)) + '$1' },
      { find: /^@\/(.*)$/, replacement: fileURLToPath(new URL('../server/', import.meta.url)) + '$1' },
    ],
  },
  test: {
    root: fileURLToPath(new URL('..', import.meta.url)),
    environment: 'node',
    include: ['evals/**/*.test.ts'],
    restoreMocks: true,
  },
});
